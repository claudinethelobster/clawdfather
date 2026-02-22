import type { IncomingMessage, ServerResponse } from 'http';
import { spawn } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import { deriveAccountKEK, encryptPrivateKey, decryptPrivateKey, computeEd25519Fingerprint } from '../crypto';
import { apiOk, apiError } from '../api-response';
import { authenticate } from '../auth-middleware';
import { auditLog } from '../audit';
import { testSSHConnection } from '../ssh-test';
import { sessionStore } from '../sessions';
import { createRateLimiter } from '../rate-limit';
import type { Session } from '../types';
import { readBody, getClientIp } from './auth';

const USERNAME_RE = /^[a-z_][a-z0-9_-]*$/;
const bootstrapLimiter = createRateLimiter(20, 60 * 60 * 1000);
const confirmLimiter = createRateLimiter(10, 60 * 60 * 1000);

const TMP_DIR = '/tmp/clawdfather';

async function ensureDefaultKeypair(accountId: string): Promise<{ id: string; public_key: string; fingerprint: string; private_key_enc: string }> {
  const existing = await query(
    "SELECT id, public_key, fingerprint, private_key_enc FROM agent_keypairs WHERE account_id = $1 AND label = 'default' AND is_active = TRUE",
    [accountId],
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const tmpDir = join(tmpdir(), `cf-keygen-${randomBytes(8).toString('hex')}`);
  const keyPath = join(tmpDir, 'id_ed25519');
  try {
    mkdirSync(tmpDir, { recursive: true });
    execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -q`);
    const privateKeyPem = readFileSync(keyPath, 'utf8');
    const publicKey = readFileSync(keyPath + '.pub', 'utf8').trim();
    const fingerprint = computeEd25519Fingerprint(publicKey);
    const kek = deriveAccountKEK(accountId);
    const encryptedKey = encryptPrivateKey(privateKeyPem, kek);

    const result = await query(
      `INSERT INTO agent_keypairs (account_id, label, public_key, private_key_enc, fingerprint)
       VALUES ($1, 'default', $2, $3, $4)
       ON CONFLICT (account_id, label) DO UPDATE SET
         public_key = EXCLUDED.public_key, private_key_enc = EXCLUDED.private_key_enc,
         fingerprint = EXCLUDED.fingerprint, is_active = TRUE
       RETURNING id, public_key, fingerprint, private_key_enc`,
      [accountId, publicKey, encryptedKey, fingerprint],
    );
    return result.rows[0];
  } finally {
    try { unlinkSync(keyPath); } catch {}
    try { unlinkSync(keyPath + '.pub'); } catch {}
    try { unlinkSync(tmpDir); } catch {}
  }
}

async function findOrCreateConnection(
  accountId: string,
  keypairId: string,
  host: string,
  port: number,
  username: string,
  label: string,
): Promise<{ id: string; last_test_result: string | null }> {
  const existing = await query(
    `SELECT id, last_test_result FROM ssh_connections
     WHERE account_id = $1 AND keypair_id = $2 AND host = $3 AND port = $4 AND username = $5 AND deleted_at IS NULL`,
    [accountId, keypairId, host, port, username],
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await query(
    `INSERT INTO ssh_connections (account_id, keypair_id, label, host, port, username)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, last_test_result`,
    [accountId, keypairId, label, host, port, username],
  );
  return result.rows[0];
}

export async function handleBootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const limit = bootstrapLimiter.check(auth.account.id);
  if (!limit.allowed) {
    apiError(res, 429, 'rate_limited', 'Bootstrap rate limit exceeded. Try again later.');
    return;
  }

  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    apiError(res, 400, 'bad_request', 'Invalid JSON body');
    return;
  }

  const host = body.host?.trim();
  const username = body.username?.trim();
  const port = body.port ?? 22;
  const label = body.label?.trim() || `${username}@${host}`;

  if (!host || typeof host !== 'string') {
    apiError(res, 400, 'validation', 'Host is required');
    return;
  }
  if (!username || typeof username !== 'string' || !USERNAME_RE.test(username)) {
    apiError(res, 400, 'validation', 'Username is required and must match /^[a-z_][a-z0-9_-]*$/');
    return;
  }
  if (typeof port !== 'number' || port < 1 || port > 65535) {
    apiError(res, 400, 'validation', 'Port must be between 1 and 65535');
    return;
  }

  const keypair = await ensureDefaultKeypair(auth.account.id);
  const conn = await findOrCreateConnection(auth.account.id, keypair.id, host, port, username, label);

  await auditLog({
    accountId: auth.account.id,
    action: 'onboarding.bootstrap',
    targetType: 'connection',
    targetId: conn.id,
    result: 'ok',
    metadata: { host, username, port },
    ipAddress: getClientIp(req),
  });

  if (conn.last_test_result === 'ok') {
    apiOk(res, {
      status: 'ready',
      connection_id: conn.id,
      message: `Connection to ${username}@${host} is already verified and ready.`,
    });
    return;
  }

  const installCmd = `mkdir -p ~/.ssh && echo '${keypair.public_key}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;

  apiOk(res, {
    status: 'needs_setup',
    connection_id: conn.id,
    install_command: installCmd,
    public_key: keypair.public_key,
    fingerprint: keypair.fingerprint,
    message: `Run the install command on ${host} to authorize Clawdfather, then confirm.`,
  });
}

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

export async function handleBootstrapConfirm(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const limit = confirmLimiter.check(auth.account.id);
  if (!limit.allowed) {
    apiError(res, 429, 'rate_limited', 'Confirm rate limit exceeded. Try again later.');
    return;
  }

  const connectionId = match[1];

  let body: any = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) body = JSON.parse(raw);
  } catch {}

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
  const kek = deriveAccountKEK(auth.account.id);
  const privateKey = decryptPrivateKey(conn.private_key_enc, kek);

  await mkdir(TMP_DIR, { recursive: true });
  const testKeyFile = join(TMP_DIR, `confirm-${connectionId}.key`);

  try {
    await writeFile(testKeyFile, privateKey, { mode: 0o600 });

    const testResult = await testSSHConnection({
      host: conn.host,
      port: conn.port,
      username: conn.username,
      privateKeyPath: testKeyFile,
      acceptHostKey: body.accept_host_key ?? true,
    });

    if (!testResult.ok) {
      await query(
        `UPDATE ssh_connections SET last_test_result = $1, last_tested_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [testResult.errorCode ?? 'fail', connectionId],
      );

      await auditLog({
        accountId: auth.account.id,
        action: 'onboarding.confirm',
        targetType: 'connection',
        targetId: connectionId,
        result: 'fail',
        metadata: { errorCode: testResult.errorCode, errorMessage: testResult.errorMessage },
        ipAddress: getClientIp(req),
      });

      apiError(res, 502, 'ssh_failed', testResult.errorMessage ?? 'SSH connection test failed');
      return;
    }

    await query(
      `UPDATE ssh_connections SET last_test_result = 'ok', last_tested_at = NOW(),
       host_key_fingerprint = COALESCE($1, host_key_fingerprint), updated_at = NOW()
       WHERE id = $2`,
      [testResult.hostKeyFingerprint ?? null, connectionId],
    );
  } finally {
    await unlink(testKeyFile).catch(() => {});
  }

  const sessionId = uuidv4();

  await query(
    `INSERT INTO session_leases (id, account_id, connection_id, keypair_id, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [sessionId, auth.account.id, connectionId, conn.keypair_id],
  );

  const cm = await startControlMaster(sessionId, conn.host, conn.port, conn.username, privateKey);

  if (!cm.ok) {
    await query("UPDATE session_leases SET status = 'failed' WHERE id = $1", [sessionId]);
    apiError(res, 502, 'ssh_failed', cm.error ?? 'Failed to establish SSH session');
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
    action: 'onboarding.confirm',
    targetType: 'session',
    targetId: sessionId,
    result: 'ok',
    metadata: { host: conn.host, username: conn.username },
    ipAddress: getClientIp(req),
  });

  apiOk(res, { session_id: sessionId, chat_url: chatUrl }, 201);
}
