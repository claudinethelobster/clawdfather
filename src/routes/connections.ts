import type { IncomingMessage, ServerResponse } from 'http';
import { query } from '../db';
import { deriveAccountKEK, decryptPrivateKey } from '../crypto';
import { apiError, apiOk } from '../api-response';
import { auditLog } from '../audit';
import { authenticate } from '../auth-middleware';
import { createRateLimiter } from '../rate-limit';
import { testSSHConnection } from '../ssh-test';
import type { ClawdfatherConfig } from '../types';
import { readBody, getClientIp } from './auth';

const connectionTestLimiters = new Map<string, ReturnType<typeof createRateLimiter>>();

function getTestLimiter(connectionId: string) {
  let limiter = connectionTestLimiters.get(connectionId);
  if (!limiter) {
    limiter = createRateLimiter(5, 60_000);
    connectionTestLimiters.set(connectionId, limiter);
  }
  return limiter;
}

const USERNAME_RE = /^[a-z_][a-z0-9_-]*$/;

export async function handleListConnections(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    `SELECT id, label, host, port, username, keypair_id, host_key_fingerprint,
            last_tested_at, last_test_result, created_at, updated_at
     FROM ssh_connections WHERE account_id = $1 AND deleted_at IS NULL ORDER BY label ASC`,
    [auth.account.id],
  );

  apiOk(res, { connections: result.rows });
}

export async function handleCreateConnection(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return apiError(res, 400, 'validation_error', 'Invalid JSON body.');
  }

  const label = body.label as string | undefined;
  const host = body.host as string | undefined;
  const port = (body.port as number) ?? 22;
  const username = body.username as string | undefined;
  let keypairId = body.keypair_id as string | undefined;

  if (!label || label.length > 64) {
    return apiError(res, 400, 'validation_error', 'Label is required and must be 1-64 characters.');
  }
  if (!host) {
    return apiError(res, 400, 'validation_error', 'Host is required.');
  }
  if (port < 1 || port > 65535) {
    return apiError(res, 400, 'validation_error', 'Port must be between 1 and 65535.');
  }
  if (!username || username.length > 64 || !USERNAME_RE.test(username)) {
    return apiError(res, 400, 'validation_error', 'Username is required, 1-64 chars, valid Unix username characters.');
  }

  // Default keypair if not specified
  if (!keypairId) {
    const defaultKp = await query(
      `SELECT id FROM agent_keypairs WHERE account_id = $1 AND label = 'default' AND is_active = TRUE`,
      [auth.account.id],
    );
    if (defaultKp.rows.length === 0) {
      return apiError(res, 400, 'no_default_keypair', 'No default keypair found. Create a keypair first.');
    }
    keypairId = defaultKp.rows[0].id;
  }

  // Verify keypair belongs to account and is active
  const kpCheck = await query(
    `SELECT id FROM agent_keypairs WHERE id = $1 AND account_id = $2 AND is_active = TRUE`,
    [keypairId, auth.account.id],
  );
  if (kpCheck.rows.length === 0) {
    return apiError(res, 400, 'validation_error', 'Keypair not found or not active.');
  }

  try {
    const insertResult = await query(
      `INSERT INTO ssh_connections (account_id, keypair_id, label, host, port, username)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, label, host, port, username, keypair_id, created_at`,
      [auth.account.id, keypairId, label, host, port, username],
    );

    auditLog({
      account_id: auth.account.id,
      action: 'connection.create',
      target_type: 'ssh_connection',
      target_id: insertResult.rows[0].id,
      ip_address: getClientIp(req),
      result: 'ok',
      detail: { label, host, port },
    });

    apiOk(res, { connection: insertResult.rows[0] }, 201);
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === '23505') {
      return apiError(res, 409, 'label_exists', 'A connection with this label already exists.');
    }
    throw err;
  }
}

export async function handleUpdateConnection(
  req: IncomingMessage,
  res: ServerResponse,
  connectionId: string,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return apiError(res, 400, 'validation_error', 'Invalid JSON body.');
  }

  const conn = await query(
    `SELECT * FROM ssh_connections WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [connectionId, auth.account.id],
  );
  if (conn.rows.length === 0) {
    return apiError(res, 404, 'not_found', 'Connection not found.');
  }

  const existing = conn.rows[0];
  const hostChanging = body.host !== undefined && body.host !== existing.host;
  const portChanging = body.port !== undefined && body.port !== existing.port;

  // Block host/port change if active session exists
  if (hostChanging || portChanging) {
    const active = await query(
      `SELECT id FROM session_leases WHERE connection_id = $1 AND status IN ('pending','active') LIMIT 1`,
      [connectionId],
    );
    if (active.rows.length > 0) {
      return apiError(res, 409, 'active_session_exists', 'Cannot change host/port while a session is active.');
    }
  }

  // Validate username if provided
  if (body.username !== undefined) {
    const u = body.username as string;
    if (!u || u.length > 64 || !USERNAME_RE.test(u)) {
      return apiError(res, 400, 'validation_error', 'Invalid username.');
    }
  }

  // Validate label if provided
  if (body.label !== undefined) {
    const l = body.label as string;
    if (!l || l.length > 64) {
      return apiError(res, 400, 'validation_error', 'Label must be 1-64 characters.');
    }
  }

  // Validate host if provided
  if (body.host !== undefined) {
    const h = body.host as string;
    if (!h) {
      return apiError(res, 400, 'validation_error', 'Host cannot be empty.');
    }
  }

  // Validate port if provided
  if (body.port !== undefined) {
    const p = body.port as number;
    if (p < 1 || p > 65535) {
      return apiError(res, 400, 'validation_error', 'Port must be between 1 and 65535.');
    }
  }

  // Validate keypair_id if provided
  if (body.keypair_id !== undefined) {
    const kpCheck = await query(
      `SELECT id FROM agent_keypairs WHERE id = $1 AND account_id = $2 AND is_active = TRUE`,
      [body.keypair_id, auth.account.id],
    );
    if (kpCheck.rows.length === 0) {
      return apiError(res, 400, 'validation_error', 'Keypair not found or not active.');
    }
  }

  const setClauses: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let idx = 1;

  if (body.label !== undefined) { setClauses.push(`label = $${idx}`); params.push(body.label); idx++; }
  if (body.host !== undefined) { setClauses.push(`host = $${idx}`); params.push(body.host); idx++; }
  if (body.port !== undefined) { setClauses.push(`port = $${idx}`); params.push(body.port); idx++; }
  if (body.username !== undefined) { setClauses.push(`username = $${idx}`); params.push(body.username); idx++; }
  if (body.keypair_id !== undefined) { setClauses.push(`keypair_id = $${idx}`); params.push(body.keypair_id); idx++; }

  // Clear test results on host/port change
  if (hostChanging || portChanging) {
    setClauses.push('host_key_fingerprint = NULL', 'last_tested_at = NULL', 'last_test_result = NULL');
  }

  params.push(connectionId);

  try {
    const updated = await query(
      `UPDATE ssh_connections SET ${setClauses.join(', ')} WHERE id = $${idx}
       RETURNING id, label, host, port, username, keypair_id, host_key_fingerprint, last_tested_at, last_test_result, updated_at`,
      params,
    );

    auditLog({
      account_id: auth.account.id,
      action: 'connection.update',
      target_type: 'ssh_connection',
      target_id: connectionId,
      ip_address: getClientIp(req),
      result: 'ok',
    });

    apiOk(res, { connection: updated.rows[0] });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === '23505') {
      return apiError(res, 409, 'label_exists', 'A connection with this label already exists.');
    }
    throw err;
  }
}

export async function handleDeleteConnection(
  req: IncomingMessage,
  res: ServerResponse,
  connectionId: string,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const conn = await query(
    `SELECT id, deleted_at FROM ssh_connections WHERE id = $1 AND account_id = $2`,
    [connectionId, auth.account.id],
  );
  if (conn.rows.length === 0) {
    return apiError(res, 404, 'not_found', 'Connection not found.');
  }

  // Already deleted — idempotent
  if (conn.rows[0].deleted_at) {
    return apiOk(res, { connection: { id: conn.rows[0].id, deleted_at: conn.rows[0].deleted_at } });
  }

  // Block if active session exists
  const active = await query(
    `SELECT id FROM session_leases WHERE connection_id = $1 AND status IN ('pending','active') LIMIT 1`,
    [connectionId],
  );
  if (active.rows.length > 0) {
    return apiError(res, 409, 'active_session_exists', 'Cannot delete while a session is active.');
  }

  const updated = await query(
    `UPDATE ssh_connections SET deleted_at = NOW() WHERE id = $1 RETURNING id, deleted_at`,
    [connectionId],
  );

  auditLog({
    account_id: auth.account.id,
    action: 'connection.delete',
    target_type: 'ssh_connection',
    target_id: connectionId,
    ip_address: getClientIp(req),
    result: 'ok',
  });

  apiOk(res, { connection: updated.rows[0] });
}

export async function handleTestConnection(
  req: IncomingMessage,
  res: ServerResponse,
  connectionId: string,
  config: ClawdfatherConfig,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const rl = getTestLimiter(connectionId).check(connectionId);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)));
    return apiError(res, 429, 'rate_limited', 'Too many test requests. Please wait.');
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch {}

  const acceptHostKey = body.accept_host_key === true;

  const conn = await query(
    `SELECT c.*, kp.private_key_enc, kp.is_active AS kp_active
     FROM ssh_connections c
     JOIN agent_keypairs kp ON kp.id = c.keypair_id
     WHERE c.id = $1 AND c.account_id = $2 AND c.deleted_at IS NULL`,
    [connectionId, auth.account.id],
  );
  if (conn.rows.length === 0) {
    return apiError(res, 404, 'not_found', 'Connection not found.');
  }

  const row = conn.rows[0];
  if (!row.kp_active) {
    return apiError(res, 409, 'keypair_revoked', 'The keypair for this connection has been revoked.');
  }

  const masterKey = config.masterKey ?? process.env.CLAWDFATHER_MASTER_KEY ?? '';
  const kek = deriveAccountKEK(masterKey, auth.account.id);
  let privateKeyPem: string;
  try {
    privateKeyPem = decryptPrivateKey(row.private_key_enc, kek);
  } catch {
    return apiError(res, 500, 'internal_error', 'Failed to decrypt keypair.');
  }

  const testResult = await testSSHConnection(row.host, row.port, row.username, privateKeyPem);

  // Host key mismatch check
  if (
    testResult.result === 'ok' &&
    testResult.host_key_fingerprint &&
    row.host_key_fingerprint &&
    testResult.host_key_fingerprint !== row.host_key_fingerprint &&
    !acceptHostKey
  ) {
    auditLog({
      account_id: auth.account.id,
      action: 'connection.test',
      target_type: 'ssh_connection',
      target_id: connectionId,
      ip_address: getClientIp(req),
      result: 'failed',
      detail: { reason: 'host_key_changed' },
    });
    return apiError(res, 409, 'host_key_changed', 'The server\'s host key has changed.', {
      result: 'host_key_changed',
      old_fingerprint: row.host_key_fingerprint,
      new_fingerprint: testResult.host_key_fingerprint,
    });
  }

  // Update connection on success
  if (testResult.result === 'ok') {
    await query(
      `UPDATE ssh_connections SET last_tested_at = NOW(), last_test_result = 'ok', host_key_fingerprint = $1, updated_at = NOW()
       WHERE id = $2`,
      [testResult.host_key_fingerprint, connectionId],
    );
  } else {
    await query(
      `UPDATE ssh_connections SET last_tested_at = NOW(), last_test_result = $1, updated_at = NOW() WHERE id = $2`,
      [testResult.result, connectionId],
    );
  }

  auditLog({
    account_id: auth.account.id,
    action: 'connection.test',
    target_type: 'ssh_connection',
    target_id: connectionId,
    ip_address: getClientIp(req),
    result: testResult.result === 'ok' ? 'ok' : 'failed',
    detail: { test_result: testResult.result, latency_ms: testResult.latency_ms },
  });

  apiOk(res, testResult);
}
