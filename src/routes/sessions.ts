import type { IncomingMessage, ServerResponse } from 'http';
import { spawn, execSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { query } from '../db';
import { deriveAccountKEK, decryptPrivateKey } from '../crypto';
import { apiError, apiOk } from '../api-response';
import { auditLog } from '../audit';
import { authenticate } from '../auth-middleware';
import { createRateLimiter } from '../rate-limit';
import { sessionStore } from '../sessions';
import { closeSessionClients } from '../web-server';
import type { ClawdfatherConfig } from '../types';
import { readBody, getClientIp } from './auth';

const sessionStartLimiter = createRateLimiter(10, 3600_000);

const TMP_DIR = '/tmp/clawdfather';

function ensureTmpDir(): void {
  try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}
}

function waitForSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(socketPath)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(check, 250);
    };
    check();
  });
}

export async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  config: ClawdfatherConfig,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const rl = sessionStartLimiter.check(auth.account.id);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)));
    return apiError(res, 429, 'rate_limited', 'Too many session start requests. Please wait.');
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return apiError(res, 400, 'validation_error', 'Invalid JSON body.');
  }

  const connectionId = body.connection_id as string | undefined;
  if (!connectionId) {
    return apiError(res, 400, 'validation_error', 'connection_id is required.');
  }

  const connResult = await query(
    `SELECT c.*, kp.private_key_enc, kp.is_active AS kp_active
     FROM ssh_connections c
     JOIN agent_keypairs kp ON kp.id = c.keypair_id
     WHERE c.id = $1 AND c.account_id = $2 AND c.deleted_at IS NULL`,
    [connectionId, auth.account.id],
  );
  if (connResult.rows.length === 0) {
    return apiError(res, 404, 'not_found', 'Connection not found.');
  }

  const connection = connResult.rows[0];

  if (!connection.kp_active) {
    return apiError(res, 409, 'keypair_revoked', 'The keypair for this connection has been revoked.');
  }

  if (connection.last_test_result !== 'ok') {
    return apiError(res, 400, 'connection_not_tested', 'Connection has not been successfully tested. Run a test first.');
  }

  // Check concurrent active sessions
  const activeCount = await query(
    `SELECT COUNT(*) AS cnt FROM session_leases WHERE account_id = $1 AND status IN ('pending','active')`,
    [auth.account.id],
  );
  if (parseInt(activeCount.rows[0].cnt, 10) >= 3) {
    return apiError(res, 409, 'session_limit_reached', 'Maximum of 3 concurrent sessions reached.');
  }

  // Create session lease
  const sessionId = randomUUID();
  await query(
    `INSERT INTO session_leases (id, account_id, connection_id, keypair_id, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [sessionId, auth.account.id, connectionId, connection.keypair_id],
  );

  // Decrypt private key
  const masterKey = config.masterKey ?? process.env.CLAWDFATHER_MASTER_KEY ?? '';
  const kek = deriveAccountKEK(masterKey, auth.account.id);
  let privateKeyPem: string;
  try {
    privateKeyPem = decryptPrivateKey(connection.private_key_enc, kek);
  } catch {
    await query(
      `UPDATE session_leases SET status = 'error', error_detail = 'Key decryption failed', closed_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    return apiError(res, 500, 'internal_error', 'Failed to decrypt keypair.');
  }

  ensureTmpDir();
  const keyPath = `${TMP_DIR}/${sessionId}.key`;
  const controlPath = `${TMP_DIR}/${sessionId}.sock`;

  try {
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    // StrictHostKeyChecking=no is safe here because host-key verification
    // (TOFU + mismatch detection) was already performed in the /connections/:id/test
    // route before this session was created. Using /dev/null for UserKnownHostsFile
    // avoids polluting the system known_hosts while still allowing the ControlMaster
    // to establish. Combining StrictHostKeyChecking=yes with UserKnownHostsFile=/dev/null
    // would cause OpenSSH to reject every host (nothing to check against).
    const proc = spawn('ssh', [
      '-N',
      '-o', 'ControlMaster=yes',
      '-o', `ControlPath=${controlPath}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=15',
      '-o', 'BatchMode=yes',
      '-i', keyPath,
      '-p', String(connection.port),
      `${connection.username}@${connection.host}`,
    ], { stdio: 'ignore', detached: true });
    proc.unref();

    const socketReady = await waitForSocket(controlPath, 10_000);

    // Always clean up the key file
    try { unlinkSync(keyPath); } catch {}

    if (!socketReady) {
      await query(
        `UPDATE session_leases SET status = 'error', error_detail = 'SSH ControlMaster socket never appeared', closed_at = NOW() WHERE id = $1`,
        [sessionId],
      );
      auditLog({
        account_id: auth.account.id,
        action: 'session.start',
        target_type: 'session_lease',
        target_id: sessionId,
        ip_address: getClientIp(req),
        result: 'failed',
        detail: { reason: 'ssh_connect_failed' },
      });
      return apiError(res, 502, 'ssh_connect_failed', 'SSH ControlMaster failed to establish.');
    }
  } catch (err) {
    try { unlinkSync(keyPath); } catch {}
    await query(
      `UPDATE session_leases SET status = 'error', error_detail = $1, closed_at = NOW() WHERE id = $2`,
      [(err as Error).message, sessionId],
    );
    return apiError(res, 502, 'ssh_connect_failed', 'Failed to start SSH connection.');
  }

  const agentSessionId = `ssh:${sessionId}`;
  await query(
    `UPDATE session_leases SET status = 'active', started_at = NOW(), last_heartbeat_at = NOW(), agent_session_id = $1 WHERE id = $2`,
    [agentSessionId, sessionId],
  );

  sessionStore.create({
    sessionId,
    keyFingerprint: connection.fingerprint ?? 'unknown',
    targetHost: connection.host,
    targetUser: connection.username,
    targetPort: connection.port,
    controlPath,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
  });

  const chatUrl = `https://${config.webDomain}/?session=${sessionId}`;

  auditLog({
    account_id: auth.account.id,
    action: 'session.start',
    target_type: 'session_lease',
    target_id: sessionId,
    ip_address: getClientIp(req),
    result: 'ok',
    detail: { connection_label: connection.label, host: connection.host },
  });

  apiOk(res, {
    session: {
      id: sessionId,
      status: 'active',
      agent_session_id: agentSessionId,
      connection: {
        id: connection.id,
        label: connection.label,
        host: connection.host,
        username: connection.username,
      },
      started_at: new Date().toISOString(),
      chat_url: chatUrl,
    },
  }, 201);
}

export async function handleListSessions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const status = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;

  let whereClause = 'sl.account_id = $1';
  const params: unknown[] = [auth.account.id];
  let idx = 2;

  if (status) {
    whereClause += ` AND sl.status = $${idx}`;
    params.push(status);
    idx++;
  }

  params.push(limit, offset);

  const result = await query(
    `SELECT sl.id, sl.status, sl.agent_session_id, sl.started_at, sl.closed_at, sl.close_reason, sl.last_heartbeat_at, sl.created_at,
            c.id AS conn_id, c.label AS conn_label, c.host AS conn_host
     FROM session_leases sl
     JOIN ssh_connections c ON c.id = sl.connection_id
     WHERE ${whereClause}
     ORDER BY sl.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    params,
  );

  const countResult = await query(
    `SELECT COUNT(*) AS cnt FROM session_leases sl WHERE ${whereClause}`,
    params.slice(0, idx - 1),
  );

  const sessions = result.rows.map((r) => ({
    id: r.id,
    status: r.status,
    connection: { id: r.conn_id, label: r.conn_label, host: r.conn_host },
    started_at: r.started_at,
    last_heartbeat_at: r.last_heartbeat_at,
    closed_at: r.closed_at ?? null,
  }));

  apiOk(res, {
    sessions,
    total: parseInt(countResult.rows[0].cnt, 10),
    limit,
    offset,
  });
}

export async function handleGetSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  config: ClawdfatherConfig,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    `SELECT sl.*, c.id AS conn_id, c.label AS conn_label, c.host AS conn_host, c.port AS conn_port, c.username AS conn_username
     FROM session_leases sl
     JOIN ssh_connections c ON c.id = sl.connection_id
     WHERE sl.id = $1 AND sl.account_id = $2`,
    [sessionId, auth.account.id],
  );

  if (result.rows.length === 0) {
    return apiError(res, 404, 'not_found', 'Session not found.');
  }

  const r = result.rows[0];
  const chatUrl = `https://${config.webDomain}/?session=${r.id}`;

  apiOk(res, {
    session: {
      id: r.id,
      status: r.status,
      agent_session_id: r.agent_session_id,
      connection: {
        id: r.conn_id,
        label: r.conn_label,
        host: r.conn_host,
        port: r.conn_port,
        username: r.conn_username,
      },
      started_at: r.started_at,
      last_heartbeat_at: r.last_heartbeat_at,
      closed_at: r.closed_at ?? null,
      close_reason: r.close_reason,
      chat_url: chatUrl,
    },
  });
}

export async function handleDeleteSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    `SELECT sl.*, c.username AS conn_username, c.host AS conn_host, c.port AS conn_port
     FROM session_leases sl
     JOIN ssh_connections c ON c.id = sl.connection_id
     WHERE sl.id = $1 AND sl.account_id = $2`,
    [sessionId, auth.account.id],
  );

  if (result.rows.length === 0) {
    return apiError(res, 404, 'not_found', 'Session not found.');
  }

  const session = result.rows[0];

  // Already closed — idempotent
  if (session.status === 'closed' || session.status === 'error') {
    return apiOk(res, {
      session: {
        id: session.id,
        status: session.status,
        closed_at: session.closed_at,
        close_reason: session.close_reason,
      },
    });
  }

  // Teardown ControlMaster
  const controlPath = `${TMP_DIR}/${sessionId}.sock`;
  try {
    execSync(
      `ssh -S "${controlPath}" -O exit -p ${session.conn_port} ${session.conn_username}@${session.conn_host}`,
      { stdio: 'ignore', timeout: 5000 },
    );
  } catch {}

  try { unlinkSync(controlPath); } catch {}

  sessionStore.remove(sessionId);
  closeSessionClients(sessionId, 4001, 'Session closed by user');

  await query(
    `UPDATE session_leases SET status = 'closed', closed_at = NOW(), close_reason = 'user' WHERE id = $1`,
    [sessionId],
  );

  auditLog({
    account_id: auth.account.id,
    action: 'session.close',
    target_type: 'session_lease',
    target_id: sessionId,
    ip_address: getClientIp(req),
    result: 'ok',
  });

  apiOk(res, {
    session: {
      id: sessionId,
      status: 'closed',
      closed_at: new Date().toISOString(),
      close_reason: 'user',
    },
  });
}

/** Background cleanup: close sessions with stale heartbeats */
export function startSessionCleanup(): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      const stale = await query(
        `SELECT sl.id, c.username, c.host, c.port
         FROM session_leases sl
         JOIN ssh_connections c ON c.id = sl.connection_id
         WHERE sl.status = 'active' AND sl.last_heartbeat_at < NOW() - INTERVAL '30 minutes'`,
      );

      for (const row of stale.rows) {
        const controlPath = `${TMP_DIR}/${row.id}.sock`;
        try {
          execSync(
            `ssh -S "${controlPath}" -O exit -p ${row.port} ${row.username}@${row.host}`,
            { stdio: 'ignore', timeout: 5000 },
          );
        } catch {}
        try { unlinkSync(controlPath); } catch {}

        await query(
          `UPDATE session_leases SET status = 'closed', closed_at = NOW(), close_reason = 'timeout' WHERE id = $1`,
          [row.id],
        );

        sessionStore.remove(row.id);
        closeSessionClients(row.id, 4001, 'Session timed out');

        auditLog({
          action: 'session.timeout',
          target_type: 'session_lease',
          target_id: row.id,
          result: 'ok',
        });
      }
    } catch (err) {
      console.error('[clawdfather] Session cleanup error:', (err as Error).message);
    }
  }, 60_000);
  timer.unref();
  return timer;
}
