import type { IncomingMessage, ServerResponse } from 'http';
import { spawn, execSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { readFileSync } from 'fs';
import { query } from '../db';
import { deriveAccountKEK, decryptPrivateKey, encryptPrivateKey, computeEd25519Fingerprint } from '../crypto';
import { apiError, apiOk } from '../api-response';
import { auditLog } from '../audit';
import { authenticate } from '../auth-middleware';
import { createRateLimiter } from '../rate-limit';
import { sessionStore } from '../sessions';
import { testSSHConnection } from '../ssh-test';
import type { ClawdfatherConfig } from '../types';
import { readBody, getClientIp } from './auth';

const bootstrapLimiter = createRateLimiter(20, 3600_000);
const confirmLimiter = createRateLimiter(10, 3600_000);

const USERNAME_RE = /^[a-z_][a-z0-9_-]*$/;
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

function generateOpenSSHKeypair(label: string): { publicKeySSH: string; privateKeyPem: string } {
  const tmpDir = '/tmp/clawdfather';
  try { mkdirSync(tmpDir, { recursive: true }); } catch {}
  const tmpFile = join(tmpDir, `keygen-${randomUUID()}`);
  try {
    execSync(`ssh-keygen -t ed25519 -N "" -f "${tmpFile}" -C "clawdfather:${label}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const privateKeyPem = readFileSync(tmpFile, 'utf8');
    const publicKeySSH = readFileSync(tmpFile + '.pub', 'utf8').trim();
    return { publicKeySSH, privateKeyPem };
  } finally {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(tmpFile + '.pub'); } catch {}
  }
}

export async function handleBootstrapSession(
  req: IncomingMessage,
  res: ServerResponse,
  config: ClawdfatherConfig,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const rl = bootstrapLimiter.check(auth.account.id);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)));
    return apiError(res, 429, 'rate_limited', 'Too many bootstrap requests. Please wait.');
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return apiError(res, 400, 'validation_error', 'Invalid JSON body.');
  }

  const host = body.host as string | undefined;
  const username = body.username as string | undefined;
  const port = (body.port as number) ?? 22;
  const labelInput = body.label as string | undefined;

  if (!host) {
    return apiError(res, 400, 'validation_error', 'host is required.');
  }
  if (!username || username.length > 64 || !USERNAME_RE.test(username)) {
    return apiError(res, 400, 'validation_error', 'username is required, 1-64 chars, valid Unix username characters.');
  }
  if (port < 1 || port > 65535) {
    return apiError(res, 400, 'validation_error', 'Port must be between 1 and 65535.');
  }

  const label = labelInput || `${username}@${host}`.slice(0, 64);

  // Ensure default keypair exists
  let keypairId: string;
  let publicKey: string;
  let fingerprint: string;

  const kpResult = await query(
    `SELECT id, public_key, fingerprint FROM agent_keypairs WHERE account_id = $1 AND label = 'default' AND is_active = TRUE`,
    [auth.account.id],
  );

  if (kpResult.rows.length > 0) {
    keypairId = kpResult.rows[0].id;
    publicKey = kpResult.rows[0].public_key;
    fingerprint = kpResult.rows[0].fingerprint;
  } else {
    const { publicKeySSH, privateKeyPem } = generateOpenSSHKeypair('default');
    const fp = computeEd25519Fingerprint(publicKeySSH);
    const masterKey = config.masterKey ?? process.env.CLAWDFATHER_MASTER_KEY ?? '';
    const kek = deriveAccountKEK(masterKey, auth.account.id);
    const privateKeyEnc = encryptPrivateKey(privateKeyPem, kek);

    const insertKp = await query(
      `INSERT INTO agent_keypairs (account_id, label, algorithm, public_key, private_key_enc, fingerprint)
       VALUES ($1, $2, 'ed25519', $3, $4, $5)
       RETURNING id, public_key, fingerprint`,
      [auth.account.id, 'default', publicKeySSH, privateKeyEnc, fp],
    );
    keypairId = insertKp.rows[0].id;
    publicKey = insertKp.rows[0].public_key;
    fingerprint = insertKp.rows[0].fingerprint;
  }

  // Find or create connection
  let connectionId: string;
  let lastTestResult: string | null = null;

  const connResult = await query(
    `SELECT id, last_test_result FROM ssh_connections
     WHERE account_id = $1 AND host = $2 AND username = $3 AND port = $4 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [auth.account.id, host, username, port],
  );

  if (connResult.rows.length > 0) {
    connectionId = connResult.rows[0].id;
    lastTestResult = connResult.rows[0].last_test_result;
  } else {
    const insertConn = await query(
      `INSERT INTO ssh_connections (account_id, keypair_id, label, host, port, username)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [auth.account.id, keypairId, label, host, port, username],
    );
    connectionId = insertConn.rows[0].id;
  }

  auditLog({
    account_id: auth.account.id,
    action: 'onboarding.bootstrap',
    target_type: 'ssh_connection',
    target_id: connectionId,
    ip_address: getClientIp(req),
    result: 'ok',
  });

  if (lastTestResult === 'ok') {
    return apiOk(res, {
      status: 'ready',
      connection_id: connectionId,
      message: 'Connection already verified. Ready to start a session.',
    });
  }

  const installCmd = `mkdir -p ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;

  apiOk(res, {
    status: 'needs_setup',
    connection_id: connectionId,
    install_command: installCmd,
    public_key: publicKey,
    fingerprint,
    message: 'Run this command on your server to install the SSH key, then call /confirm.',
  });
}

export async function handleConfirmAndStartSession(
  req: IncomingMessage,
  res: ServerResponse,
  connectionId: string,
  config: ClawdfatherConfig,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const rl = confirmLimiter.check(auth.account.id);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)));
    return apiError(res, 429, 'rate_limited', 'Too many confirm requests. Please wait.');
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch {}

  const acceptHostKey = body.accept_host_key !== false;

  // Look up connection with keypair
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

  // Decrypt private key
  const masterKey = config.masterKey ?? process.env.CLAWDFATHER_MASTER_KEY ?? '';
  const kek = deriveAccountKEK(masterKey, auth.account.id);
  let privateKeyPem: string;
  try {
    privateKeyPem = decryptPrivateKey(connection.private_key_enc, kek);
  } catch {
    return apiError(res, 500, 'internal_error', 'Failed to decrypt keypair.');
  }

  // Test SSH connection
  const testResult = await testSSHConnection(connection.host, connection.port, connection.username, privateKeyPem);

  // Host key mismatch check
  if (
    testResult.result === 'ok' &&
    testResult.host_key_fingerprint &&
    connection.host_key_fingerprint &&
    testResult.host_key_fingerprint !== connection.host_key_fingerprint &&
    !acceptHostKey
  ) {
    return apiError(res, 409, 'host_key_changed', 'The server\'s host key has changed.', {
      result: 'host_key_changed',
      old_fingerprint: connection.host_key_fingerprint,
      new_fingerprint: testResult.host_key_fingerprint,
    });
  }

  if (testResult.result !== 'ok') {
    await query(
      `UPDATE ssh_connections SET last_tested_at = NOW(), last_test_result = $1, updated_at = NOW() WHERE id = $2`,
      [testResult.result, connectionId],
    );
    return apiError(res, 502, 'ssh_connect_failed', testResult.message);
  }

  // SSH test succeeded — update connection
  await query(
    `UPDATE ssh_connections SET last_tested_at = NOW(), last_test_result = 'ok', host_key_fingerprint = $1, updated_at = NOW() WHERE id = $2`,
    [testResult.host_key_fingerprint, connectionId],
  );

  // Check session limit
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

  // Start SSH ControlMaster
  ensureTmpDir();
  const keyPath = `${TMP_DIR}/${sessionId}.key`;
  const controlPath = `${TMP_DIR}/${sessionId}.sock`;

  try {
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

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

  // Session active
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
