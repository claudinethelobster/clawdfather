import type { IncomingMessage, ServerResponse } from 'http';
import * as https from 'https';
import { createHash, randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { query } from '../db';
import { env } from '../env';
import { generateToken, hashToken, deriveAccountKEK, encryptPrivateKey, computeEd25519Fingerprint } from '../crypto';
import { apiOk, apiError } from '../api-response';
import { authenticate } from '../auth-middleware';
import { auditLog } from '../audit';

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function httpsRequest(url: string, options: https.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function provisionDefaultKeypair(accountId: string): Promise<void> {
  const existing = await query(
    'SELECT id FROM agent_keypairs WHERE account_id = $1 AND label = $2 AND is_active = TRUE',
    [accountId, 'default'],
  );
  if (existing.rows.length > 0) return;

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

    await query(
      `INSERT INTO agent_keypairs (account_id, label, public_key, private_key_enc, fingerprint)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, label) DO NOTHING`,
      [accountId, 'default', publicKey, encryptedKey, fingerprint],
    );
  } finally {
    try { unlinkSync(keyPath); } catch {}
    try { unlinkSync(keyPath + '.pub'); } catch {}
    try { unlinkSync(tmpDir); } catch {}
  }
}

export async function handleOAuthStart(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const state = randomBytes(32).toString('hex');
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  const stateHash = hashToken(state);
  await query(
    `INSERT INTO oauth_state_cache (state_hash, code_verifier, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
    [stateHash, codeVerifier],
  );

  const params = new URLSearchParams({
    client_id: env.githubClientId,
    scope: 'read:user,user:email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const redirectUrl = `https://github.com/login/oauth/authorize?${params}`;
  res.writeHead(302, { Location: redirectUrl });
  res.end();
}

export async function handleOAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    apiError(res, 400, 'bad_request', 'Missing code or state parameter');
    return;
  }

  const stateHash = hashToken(state);
  const stateResult = await query(
    'DELETE FROM oauth_state_cache WHERE state_hash = $1 RETURNING code_verifier',
    [stateHash],
  );

  if (stateResult.rows.length === 0) {
    apiError(res, 400, 'invalid_state', 'Invalid or expired OAuth state');
    return;
  }

  const codeVerifier = stateResult.rows[0].code_verifier;

  const tokenBody = JSON.stringify({
    client_id: env.githubClientId,
    client_secret: env.githubClientSecret,
    code,
    code_verifier: codeVerifier,
  });

  const tokenResp = await httpsRequest('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(tokenBody),
    },
  }, tokenBody);

  const tokenData = JSON.parse(tokenResp.body);
  if (!tokenData.access_token) {
    apiError(res, 502, 'github_error', tokenData.error_description ?? 'Failed to exchange code');
    return;
  }

  const accessToken = tokenData.access_token;

  const [userResp, emailsResp] = await Promise.all([
    httpsRequest('https://api.github.com/user', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Clawdfather' },
    }),
    httpsRequest('https://api.github.com/user/emails', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Clawdfather' },
    }),
  ]);

  const ghUser = JSON.parse(userResp.body);
  let email: string | null = ghUser.email;
  if (!email) {
    try {
      const emails: Array<{ email: string; primary: boolean; verified: boolean }> = JSON.parse(emailsResp.body);
      const primary = emails.find((e) => e.primary && e.verified);
      email = primary?.email ?? emails[0]?.email ?? null;
    } catch {}
  }

  const githubId = String(ghUser.id);
  const upsertResult = await query(
    `INSERT INTO accounts (github_id, login, display_name, email, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (github_id) DO UPDATE SET
       login = EXCLUDED.login, display_name = EXCLUDED.display_name,
       email = EXCLUDED.email, avatar_url = EXCLUDED.avatar_url, updated_at = NOW()
     RETURNING id, github_id, login, display_name, email, avatar_url`,
    [githubId, ghUser.login, ghUser.name ?? null, email, ghUser.avatar_url ?? null],
  );
  const account = upsertResult.rows[0];

  await provisionDefaultKeypair(account.id);

  const sessionToken = generateToken();
  const sessionTokenHash = hashToken(sessionToken);
  const clientIp = getClientIp(req);

  await query(
    `INSERT INTO auth_sessions (account_id, token_hash, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [account.id, sessionTokenHash, clientIp, req.headers['user-agent'] ?? null],
  );

  await auditLog({
    accountId: account.id,
    action: 'auth.login',
    result: 'ok',
    metadata: { method: 'github_oauth', login: ghUser.login },
    ipAddress: clientIp,
  });

  const acceptJson = req.headers.accept?.includes('application/json') || url.searchParams.get('mode') === 'json';

  if (acceptJson) {
    apiOk(res, {
      token: sessionToken,
      account: {
        id: account.id,
        login: account.login,
        display_name: account.display_name,
        email: account.email,
        avatar_url: account.avatar_url,
      },
    });
  } else {
    const protocol = env.webDomain.startsWith('localhost') ? 'http' : 'https';
    const secure = protocol === 'https' ? '; Secure' : '';
    res.writeHead(302, {
      Location: `${protocol}://${env.webDomain}/?session_established=1`,
      'Set-Cookie': `session=${sessionToken}; Path=/; SameSite=Strict; HttpOnly${secure}`,
    });
    res.end();
  }
}

export async function handleMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  apiOk(res, {
    account: {
      id: auth.account.id,
      login: auth.account.login,
      display_name: auth.account.display_name,
      email: auth.account.email,
      avatar_url: auth.account.avatar_url,
    },
  });
}

export async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const tokenHash = hashToken(auth.sessionToken);
  await query('UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = $1', [tokenHash]);

  await auditLog({
    accountId: auth.account.id,
    action: 'auth.logout',
    result: 'ok',
    ipAddress: getClientIp(req),
  });

  const protocol = env.webDomain.startsWith('localhost') ? 'http' : 'https';
  const secure = protocol === 'https' ? '; Secure' : '';
  res.writeHead(204, {
    'Set-Cookie': `session=; Path=/; SameSite=Strict; HttpOnly${secure}; Max-Age=0`,
  });
  res.end();
}
