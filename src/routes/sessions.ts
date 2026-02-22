import type { IncomingMessage, ServerResponse } from 'http';
import { spawn } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import { deriveAccountKEK, decryptPrivateKey } from '../crypto';
import { apiOk, apiError } from '../api-response';
import { authenticate } from '../auth-middleware';
import { auditLog } from '../audit';
import { sessionStore } from '../sessions';
import type { Session } from '../types';
import { getClientIp } from './auth';

const TMP_DIR = '/tmp/clawdfather';

async function startControlMaster(
  sessionId: string,
  host: string,
  port: number,
  username: string,
  privateKey: string,
): Promise<{ ok: boolean; controlPath: string; error?: string }> {
  await mkdir(TMP_DIR, { recursive: true });

  const keyFile = join(TMP_DIR, `${sessionId}.key`);
  const controlPath = join(TMP_DIR, `${sessionId}.sock`);

  try {
    await writeFile(keyFile, privateKey, { mode: 0o600 });

    const args = [
      '-N', '-f',
      '-o', 'ControlMaster=yes',
      '-o', `ControlPath=${controlPath}`,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=15',
      '-i', keyFile,
      '-p', String(port),
      `${username}@${host}`,
    ];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `ssh exited with code ${code}`));
      });
      proc.on('error', reject);
      proc.unref();
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (existsSync(controlPath)) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!existsSync(controlPath)) {
      return { ok: false, controlPath, error: 'ControlMaster socket did not appear within 15s' };
    }

    return { ok: true, controlPath };
  } finally {
    await unlink(keyFile).catch(() => {});
  }
}

export async function handleListSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    `SELECT sl.id, sl.status, sl.started_at, sl.ended_at, sl.created_at,
            c.label, c.host, c.port, c.username
     FROM session_leases sl
     JOIN ssh_connections c ON c.id = sl.connection_id
     WHERE sl.account_id = $1
     ORDER BY sl.created_at DESC LIMIT 50`,
    [auth.account.id],
  );

  apiOk(res, { sessions: result.rows });
}

export async function handleCreateSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  let body: any;
  try {
    const { readBody } = await import('./auth');
    body = JSON.parse(await readBody(req));
  } catch {
    apiError(res, 400, 'bad_request', 'Invalid JSON body');
    return;
  }

  const connectionId = body.connection_id;
  if (!connectionId) {
    apiError(res, 400, 'validation', 'connection_id is required');
    return;
  }

  const activeCount = await query(
    "SELECT COUNT(*) AS cnt FROM session_leases WHERE account_id = $1 AND status = 'active'",
    [auth.account.id],
  );
  if (parseInt(activeCount.rows[0].cnt, 10) >= 3) {
    apiError(res, 429, 'session_limit', 'Maximum 3 concurrent sessions allowed');
    return;
  }

  const connResult = await query(
    `SELECT c.*, k.private_key_enc
     FROM ssh_connections c
     JOIN agent_keypairs k ON k.id = c.keypair_id
     WHERE c.id = $1 AND c.account_id = $2 AND c.deleted_at IS NULL`,
    [connectionId, auth.account.id],
  );

  if (connResult.rows.length === 0) {
    apiError(res, 404, 'not_found', 'Connection not found');
    return;
  }

  const conn = connResult.rows[0];
  if (conn.last_test_result !== 'ok') {
    apiError(res, 400, 'not_tested', 'Connection must be tested successfully before starting a session');
    return;
  }

  const kek = deriveAccountKEK(auth.account.id);
  const privateKey = decryptPrivateKey(conn.private_key_enc, kek);
  const sessionId = uuidv4();

  await query(
    `INSERT INTO session_leases (id, account_id, connection_id, keypair_id, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [sessionId, auth.account.id, connectionId, conn.keypair_id],
  );

  const cm = await startControlMaster(sessionId, conn.host, conn.port, conn.username, privateKey);

  if (!cm.ok) {
    await query("UPDATE session_leases SET status = 'failed' WHERE id = $1", [sessionId]);
    apiError(res, 502, 'ssh_failed', cm.error ?? 'Failed to establish SSH connection');
    return;
  }

  await query(
    "UPDATE session_leases SET status = 'active', started_at = NOW() WHERE id = $1",
    [sessionId],
  );

  const session: Session = {
    sessionId,
    keyFingerprint: '',
    targetHost: conn.host,
    targetUser: conn.username,
    targetPort: conn.port,
    controlPath: cm.controlPath,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
  };
  sessionStore.create(session);

  const protocol = (process.env.WEB_DOMAIN ?? 'localhost').startsWith('localhost') ? 'http' : 'https';
  const domain = process.env.WEB_DOMAIN ?? 'localhost:3000';
  const chatUrl = `${protocol}://${domain}/#session=${sessionId}`;

  await auditLog({
    accountId: auth.account.id,
    action: 'session.create',
    targetType: 'session',
    targetId: sessionId,
    result: 'ok',
    metadata: { host: conn.host, username: conn.username },
    ipAddress: getClientIp(req),
  });

  apiOk(res, { session_id: sessionId, chat_url: chatUrl }, 201);
}

export async function handleDeleteSession(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const sessionId = match[1];

  const result = await query(
    "SELECT id FROM session_leases WHERE id = $1 AND account_id = $2 AND status = 'active'",
    [sessionId, auth.account.id],
  );

  if (result.rows.length === 0) {
    apiError(res, 404, 'not_found', 'Active session not found');
    return;
  }

  sessionStore.remove(sessionId);

  await query(
    "UPDATE session_leases SET status = 'closed', ended_at = NOW() WHERE id = $1",
    [sessionId],
  );

  await auditLog({
    accountId: auth.account.id,
    action: 'session.close',
    targetType: 'session',
    targetId: sessionId,
    result: 'ok',
    ipAddress: getClientIp(req),
  });

  res.writeHead(204);
  res.end();
}
