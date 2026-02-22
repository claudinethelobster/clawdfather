import type { IncomingMessage, ServerResponse } from 'http';
import { execSync } from 'child_process';
import { readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { query } from '../db';
import { generateToken, deriveAccountKEK, encryptPrivateKey, computeEd25519Fingerprint } from '../crypto';
import { apiOk, apiError } from '../api-response';
import { authenticate } from '../auth-middleware';
import { auditLog } from '../audit';
import { readBody, getClientIp } from './auth';

export async function handleListKeys(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    `SELECT id, label, public_key, fingerprint, is_active, created_at
     FROM agent_keypairs WHERE account_id = $1 AND is_active = TRUE
     ORDER BY created_at DESC`,
    [auth.account.id],
  );

  apiOk(res, { keypairs: result.rows });
}

export async function handleCreateKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    apiError(res, 400, 'bad_request', 'Invalid JSON body');
    return;
  }

  const label = body.label?.trim();
  if (!label || label.length > 64) {
    apiError(res, 400, 'validation', 'Label is required (max 64 characters)');
    return;
  }

  const existing = await query(
    'SELECT id FROM agent_keypairs WHERE account_id = $1 AND label = $2 AND is_active = TRUE',
    [auth.account.id, label],
  );
  if (existing.rows.length > 0) {
    apiError(res, 409, 'duplicate', 'A keypair with this label already exists');
    return;
  }

  const tmpDir = join(tmpdir(), `cf-keygen-${randomBytes(8).toString('hex')}`);
  const keyPath = join(tmpDir, 'id_ed25519');
  try {
    mkdirSync(tmpDir, { recursive: true });
    execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -q`);
    const privateKeyPem = readFileSync(keyPath, 'utf8');
    const publicKey = readFileSync(keyPath + '.pub', 'utf8').trim();
    const fingerprint = computeEd25519Fingerprint(publicKey);
    const kek = deriveAccountKEK(auth.account.id);
    const encryptedKey = encryptPrivateKey(privateKeyPem, kek);

    const insertResult = await query(
      `INSERT INTO agent_keypairs (account_id, label, public_key, private_key_enc, fingerprint)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, label, public_key, fingerprint, created_at`,
      [auth.account.id, label, publicKey, encryptedKey, fingerprint],
    );

    await auditLog({
      accountId: auth.account.id,
      action: 'key.create',
      targetType: 'keypair',
      targetId: insertResult.rows[0].id,
      result: 'ok',
      ipAddress: getClientIp(req),
    });

    apiOk(res, { keypair: insertResult.rows[0] }, 201);
  } finally {
    try { unlinkSync(keyPath); } catch {}
    try { unlinkSync(keyPath + '.pub'); } catch {}
    try { unlinkSync(tmpDir); } catch {}
  }
}

export async function handleGetInstallCommand(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const keypairId = match[1];
  const result = await query(
    'SELECT id, public_key FROM agent_keypairs WHERE id = $1 AND account_id = $2 AND is_active = TRUE',
    [keypairId, auth.account.id],
  );

  if (result.rows.length === 0) {
    apiError(res, 404, 'not_found', 'Keypair not found');
    return;
  }

  const publicKey = result.rows[0].public_key;
  if (!/^[\x20-\x7e]+$/.test(publicKey)) {
    apiError(res, 500, 'invalid_key', 'Public key contains invalid characters');
    return;
  }

  const cmd = `mkdir -p ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;
  apiOk(res, { install_command: cmd });
}

export async function handleDefaultInstallCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    "SELECT id, public_key FROM agent_keypairs WHERE account_id = $1 AND label = 'default' AND is_active = TRUE",
    [auth.account.id],
  );

  if (result.rows.length === 0) {
    apiError(res, 404, 'not_found', 'Default keypair not found');
    return;
  }

  const publicKey = result.rows[0].public_key;
  if (!/^[\x20-\x7e]+$/.test(publicKey)) {
    apiError(res, 500, 'invalid_key', 'Public key contains invalid characters');
    return;
  }

  const cmd = `mkdir -p ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;
  apiOk(res, { install_command: cmd });
}

export async function handleRevokeKey(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const keypairId = match[1];
  const result = await query(
    'UPDATE agent_keypairs SET is_active = FALSE WHERE id = $1 AND account_id = $2 AND is_active = TRUE RETURNING id',
    [keypairId, auth.account.id],
  );

  if (result.rows.length === 0) {
    apiError(res, 404, 'not_found', 'Keypair not found');
    return;
  }

  await auditLog({
    accountId: auth.account.id,
    action: 'key.revoke',
    targetType: 'keypair',
    targetId: keypairId,
    result: 'ok',
    ipAddress: getClientIp(req),
  });

  res.writeHead(204);
  res.end();
}
