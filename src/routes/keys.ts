import type { IncomingMessage, ServerResponse } from 'http';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { query } from '../db';
import { deriveAccountKEK, encryptPrivateKey, computeEd25519Fingerprint } from '../crypto';
import { apiError, apiOk } from '../api-response';
import { auditLog } from '../audit';
import { authenticate } from '../auth-middleware';
import { createRateLimiter } from '../rate-limit';
import type { ClawdfatherConfig } from '../types';
import { readBody, getClientIp } from './auth';

const keyGenLimiter = createRateLimiter(5, 3600_000);

function generateOpenSSHKeypair(label: string): { publicKeySSH: string; privateKeyPem: string } {
  const tmpDir = '/tmp/clawdfather';
  try { mkdirSync(tmpDir, { recursive: true }); } catch {}
  const tmpFile = join(tmpDir, `keygen-${crypto.randomUUID()}`);
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

export async function handleListKeys(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    `SELECT id, label, fingerprint, public_key, algorithm, created_at, is_active, revoked_at, rotated_at
     FROM agent_keypairs WHERE account_id = $1 ORDER BY created_at DESC`,
    [auth.account.id],
  );

  apiOk(res, { keypairs: result.rows });
}

export async function handleCreateKey(
  req: IncomingMessage,
  res: ServerResponse,
  config: ClawdfatherConfig,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const rl = keyGenLimiter.check(auth.account.id);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)));
    return apiError(res, 429, 'rate_limited', 'Too many key generation requests. Please wait.');
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch {}

  const label = (body.label as string) || 'default';

  // Check if label already exists and is active → return existing
  const existing = await query(
    `SELECT id, label, fingerprint, public_key, algorithm, created_at
     FROM agent_keypairs WHERE account_id = $1 AND label = $2 AND is_active = TRUE`,
    [auth.account.id, label],
  );

  if (existing.rows.length > 0) {
    return apiOk(res, { keypair: existing.rows[0] }, 200);
  }

  // Check active key count
  const countResult = await query(
    `SELECT COUNT(*) AS cnt FROM agent_keypairs WHERE account_id = $1 AND is_active = TRUE`,
    [auth.account.id],
  );
  if (parseInt(countResult.rows[0].cnt, 10) >= 5) {
    return apiError(res, 409, 'key_limit_reached', 'Maximum of 5 active keypairs reached. Revoke an unused key first.');
  }

  const { publicKeySSH, privateKeyPem } = generateOpenSSHKeypair(label);
  const fingerprint = computeEd25519Fingerprint(publicKeySSH);

  const masterKey = config.masterKey ?? process.env.CLAWDFATHER_MASTER_KEY ?? '';
  const kek = deriveAccountKEK(masterKey, auth.account.id);
  const privateKeyEnc = encryptPrivateKey(privateKeyPem, kek);

  const insertResult = await query(
    `INSERT INTO agent_keypairs (account_id, label, algorithm, public_key, private_key_enc, fingerprint)
     VALUES ($1, $2, 'ed25519', $3, $4, $5)
     RETURNING id, label, fingerprint, public_key, algorithm, created_at`,
    [auth.account.id, label, publicKeySSH, privateKeyEnc, fingerprint],
  );

  auditLog({
    account_id: auth.account.id,
    action: 'key.generate',
    target_type: 'agent_keypair',
    target_id: insertResult.rows[0].id,
    ip_address: getClientIp(req),
    result: 'ok',
    detail: { label, fingerprint },
  });

  apiOk(res, { keypair: insertResult.rows[0] }, 201);
}

export async function handleGetInstallCommand(
  req: IncomingMessage,
  res: ServerResponse,
  keyId: string,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    `SELECT id, public_key, fingerprint FROM agent_keypairs WHERE id = $1 AND account_id = $2`,
    [keyId, auth.account.id],
  );

  if (result.rows.length === 0) {
    return apiError(res, 404, 'not_found', 'Keypair not found.');
  }

  const kp = result.rows[0];
  const command = `mkdir -p ~/.ssh && echo '${kp.public_key}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;

  apiOk(res, { command, public_key: kp.public_key, fingerprint: kp.fingerprint });
}

export async function handleDeleteKey(
  req: IncomingMessage,
  res: ServerResponse,
  keyId: string,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const force = url.searchParams.get('force') === 'true';

  const result = await query(
    `SELECT id, label, is_active, revoked_at FROM agent_keypairs WHERE id = $1 AND account_id = $2`,
    [keyId, auth.account.id],
  );

  if (result.rows.length === 0) {
    return apiError(res, 404, 'not_found', 'Keypair not found.');
  }

  const kp = result.rows[0];

  // Already revoked — idempotent
  if (kp.revoked_at) {
    return apiOk(res, { keypair: { id: kp.id, label: kp.label, is_active: false, revoked_at: kp.revoked_at } });
  }

  // Check for active sessions
  if (!force) {
    const sessions = await query(
      `SELECT id FROM session_leases WHERE keypair_id = $1 AND status IN ('pending', 'active') LIMIT 1`,
      [keyId],
    );
    if (sessions.rows.length > 0) {
      return apiError(res, 409, 'active_sessions_exist', 'Active sessions are using this key. End them first or use ?force=true.');
    }
  }

  const updated = await query(
    `UPDATE agent_keypairs SET is_active = FALSE, revoked_at = NOW() WHERE id = $1 RETURNING id, label, is_active, revoked_at`,
    [keyId],
  );

  auditLog({
    account_id: auth.account.id,
    action: 'key.revoke',
    target_type: 'agent_keypair',
    target_id: keyId,
    ip_address: getClientIp(req),
    result: 'ok',
  });

  apiOk(res, { keypair: updated.rows[0] });
}
