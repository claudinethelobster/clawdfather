import type { IncomingMessage, ServerResponse } from 'http';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { query } from '../db';
import { deriveAccountKEK, decryptPrivateKey } from '../crypto';
import { apiOk, apiError } from '../api-response';
import { authenticate } from '../auth-middleware';
import { auditLog } from '../audit';
import { testSSHConnection } from '../ssh-test';
import { probeConnectivity } from '../ssh-probe';
import { createRateLimiter } from '../rate-limit';
import { readBody, getClientIp } from './auth';

const USERNAME_RE = /^[a-z_][a-z0-9_-]*$/;
const probeLimiter = createRateLimiter(30, 60 * 60 * 1000);

export async function handleListConnections(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    `SELECT c.id, c.keypair_id, c.label, c.host, c.port, c.username,
            c.host_key_fingerprint, c.last_test_result, c.last_tested_at, c.created_at, c.updated_at,
            k.fingerprint AS key_fingerprint
     FROM ssh_connections c
     LEFT JOIN agent_keypairs k ON k.id = c.keypair_id
     WHERE c.account_id = $1 AND c.deleted_at IS NULL
     ORDER BY c.created_at DESC`,
    [auth.account.id],
  );

  apiOk(res, { connections: result.rows });
}

export async function handleCreateConnection(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    apiError(res, 400, 'bad_request', 'Invalid JSON body');
    return;
  }

  const { keypair_id, label, host, username } = body;
  const port = body.port ?? 22;

  if (!label || typeof label !== 'string' || label.length > 64) {
    apiError(res, 400, 'validation', 'Label is required (max 64 characters)');
    return;
  }
  if (!host || typeof host !== 'string' || host.length > 255) {
    apiError(res, 400, 'validation', 'Host is required (max 255 characters)');
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

  const kpCheck = await query(
    'SELECT id FROM agent_keypairs WHERE id = $1 AND account_id = $2 AND is_active = TRUE',
    [keypair_id, auth.account.id],
  );
  if (kpCheck.rows.length === 0) {
    apiError(res, 400, 'validation', 'Keypair not found');
    return;
  }

  const result = await query(
    `INSERT INTO ssh_connections (account_id, keypair_id, label, host, port, username)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, keypair_id, label, host, port, username, created_at`,
    [auth.account.id, keypair_id, label.trim(), host.trim(), port, username],
  );

  await auditLog({
    accountId: auth.account.id,
    action: 'connection.create',
    targetType: 'connection',
    targetId: result.rows[0].id,
    result: 'ok',
    ipAddress: getClientIp(req),
  });

  apiOk(res, { connection: result.rows[0] }, 201);
}

export async function handleUpdateConnection(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const connectionId = match[1];

  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    apiError(res, 400, 'bad_request', 'Invalid JSON body');
    return;
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || body.label.length > 64) {
      apiError(res, 400, 'validation', 'Label max 64 characters');
      return;
    }
    sets.push(`label = $${idx++}`);
    params.push(body.label.trim());
  }
  if (body.host !== undefined) {
    if (typeof body.host !== 'string' || body.host.length > 255) {
      apiError(res, 400, 'validation', 'Host max 255 characters');
      return;
    }
    sets.push(`host = $${idx++}`);
    params.push(body.host.trim());
  }
  if (body.port !== undefined) {
    if (typeof body.port !== 'number' || body.port < 1 || body.port > 65535) {
      apiError(res, 400, 'validation', 'Port must be between 1 and 65535');
      return;
    }
    sets.push(`port = $${idx++}`);
    params.push(body.port);
  }
  if (body.username !== undefined) {
    if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username)) {
      apiError(res, 400, 'validation', 'Username must match /^[a-z_][a-z0-9_-]*$/');
      return;
    }
    sets.push(`username = $${idx++}`);
    params.push(body.username);
  }

  if (sets.length === 0) {
    apiError(res, 400, 'bad_request', 'No fields to update');
    return;
  }

  sets.push(`updated_at = NOW()`);
  params.push(connectionId, auth.account.id);

  const result = await query(
    `UPDATE ssh_connections SET ${sets.join(', ')}
     WHERE id = $${idx++} AND account_id = $${idx} AND deleted_at IS NULL
     RETURNING id, keypair_id, label, host, port, username, updated_at`,
    params,
  );

  if (result.rows.length === 0) {
    apiError(res, 404, 'not_found', 'Connection not found');
    return;
  }

  apiOk(res, { connection: result.rows[0] });
}

export async function handleDeleteConnection(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const connectionId = match[1];
  const result = await query(
    'UPDATE ssh_connections SET deleted_at = NOW() WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL RETURNING id',
    [connectionId, auth.account.id],
  );

  if (result.rows.length === 0) {
    apiError(res, 404, 'not_found', 'Connection not found');
    return;
  }

  await auditLog({
    accountId: auth.account.id,
    action: 'connection.delete',
    targetType: 'connection',
    targetId: connectionId,
    result: 'ok',
    ipAddress: getClientIp(req),
  });

  res.writeHead(204);
  res.end();
}

export async function handleTestConnection(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const connectionId = match[1];

  let body: any = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) body = JSON.parse(raw);
  } catch {}

  const connResult = await query(
    `SELECT c.*, k.private_key_enc, k.fingerprint AS key_fingerprint
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
  const privateKeyPem = decryptPrivateKey(conn.private_key_enc, kek);

  const tmpBase = '/tmp/clawdfather';
  await mkdir(tmpBase, { recursive: true });
  const keyFile = join(tmpBase, `test-${connectionId}.key`);

  try {
    await writeFile(keyFile, privateKeyPem, { mode: 0o600 });

    const testResult = await testSSHConnection({
      host: conn.host,
      port: conn.port,
      username: conn.username,
      privateKeyPath: keyFile,
      knownHostFingerprint: conn.host_key_fingerprint ?? undefined,
      acceptHostKey: body.accept_host_key ?? true,
    });

    if (testResult.ok) {
      await query(
        `UPDATE ssh_connections SET last_test_result = 'ok', last_tested_at = NOW(),
         host_key_fingerprint = COALESCE($1, host_key_fingerprint), updated_at = NOW()
         WHERE id = $2`,
        [testResult.hostKeyFingerprint ?? null, connectionId],
      );
    } else {
      if (testResult.errorCode === 'auth_fail' && conn.host_key_fingerprint && testResult.hostKeyFingerprint &&
          testResult.hostKeyFingerprint !== conn.host_key_fingerprint && !body.accept_host_key) {
        await query(
          "UPDATE ssh_connections SET last_test_result = 'host_key_changed', last_tested_at = NOW(), updated_at = NOW() WHERE id = $1",
          [connectionId],
        );
        apiError(res, 409, 'host_key_changed', 'Host key has changed. Set accept_host_key to true to accept.');
        return;
      }

      await query(
        `UPDATE ssh_connections SET last_test_result = $1, last_tested_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [testResult.errorCode ?? 'fail', connectionId],
      );
    }

    await auditLog({
      accountId: auth.account.id,
      action: 'connection.test',
      targetType: 'connection',
      targetId: connectionId,
      result: testResult.ok ? 'ok' : 'fail',
      metadata: { durationMs: testResult.durationMs, errorCode: testResult.errorCode },
      ipAddress: getClientIp(req),
    });

    apiOk(res, {
      ok: testResult.ok,
      duration_ms: testResult.durationMs,
      host_key_fingerprint: testResult.hostKeyFingerprint,
      error_code: testResult.errorCode,
      error_message: testResult.errorMessage,
    });
  } finally {
    await unlink(keyFile).catch(() => {});
  }
}

export async function handleProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const limit = probeLimiter.check(auth.account.id);
  if (!limit.allowed) {
    apiError(res, 429, 'rate_limited', 'Probe rate limit exceeded. Try again later.');
    return;
  }

  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    apiError(res, 400, 'bad_request', 'Invalid JSON body');
    return;
  }

  const host = body.host;
  const port = body.port ?? 22;

  if (!host || typeof host !== 'string') {
    apiError(res, 400, 'validation', 'Host is required');
    return;
  }

  const result = await probeConnectivity(host, port);

  apiOk(res, {
    status: result.status,
    latency_ms: result.latencyMs,
    error_detail: result.errorDetail,
    resolved_ip: result.resolvedIp,
  });
}
