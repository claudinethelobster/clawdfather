import type { IncomingMessage, ServerResponse } from 'http';
import { randomBytes, createHash } from 'crypto';
import { query, getClient } from '../db';
import { generateSessionToken, hashToken, deriveAccountKEK, encryptPrivateKey } from '../crypto';
import { apiError, apiOk } from '../api-response';
import { auditLog } from '../audit';
import { authenticate } from '../auth-middleware';
import { createRateLimiter } from '../rate-limit';
import type { ClawdfatherConfig } from '../types';

const oauthStartLimiter = createRateLimiter(10, 60_000);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? '127.0.0.1';
}

export async function handleOAuthGitHubStart(
  req: IncomingMessage,
  res: ServerResponse,
  config: ClawdfatherConfig,
): Promise<void> {
  const ip = getClientIp(req);
  const rl = oauthStartLimiter.check(ip);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)));
    return apiError(res, 429, 'rate_limited', 'Too many requests. Please wait before trying again.');
  }

  const state = randomBytes(32).toString('hex');
  const stateHash = createHash('sha256').update(state).digest('hex');

  await query(
    `INSERT INTO oauth_state_cache (state_hash, code_verifier, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
    [stateHash, state],
  );

  const clientId = config.githubClientId ?? process.env.GITHUB_CLIENT_ID ?? '';
  const authorizeUrl =
    `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}&scope=read:user,user:email`;

  auditLog({ action: 'auth.oauth.start', ip_address: ip, result: 'ok' });

  apiOk(res, { authorize_url: authorizeUrl, state });
}

export async function handleOAuthGitHubCallback(
  req: IncomingMessage,
  res: ServerResponse,
  config: ClawdfatherConfig,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const ip = getClientIp(req);

  if (!code || !state) {
    return apiError(res, 400, 'invalid_state', 'Missing code or state parameter.');
  }

  const stateHash = createHash('sha256').update(state).digest('hex');
  const stateResult = await query(
    `DELETE FROM oauth_state_cache WHERE state_hash = $1 AND expires_at > NOW() RETURNING state_hash`,
    [stateHash],
  );

  if (stateResult.rowCount === 0) {
    return apiError(res, 400, 'invalid_state', 'State mismatch or expired. Please try again.');
  }

  // Exchange code for GitHub access token
  const clientId = config.githubClientId ?? process.env.GITHUB_CLIENT_ID ?? '';
  const clientSecret = config.githubClientSecret ?? process.env.GITHUB_CLIENT_SECRET ?? '';

  let ghAccessToken: string;
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenData = await tokenRes.json() as Record<string, string>;
    if (!tokenData.access_token) {
      return apiError(res, 400, 'invalid_code', tokenData.error_description || 'GitHub rejected the authorization code.');
    }
    ghAccessToken = tokenData.access_token;
  } catch {
    return apiError(res, 502, 'github_unavailable', 'Could not reach GitHub. Try again later.');
  }

  // Fetch GitHub user profile
  let ghUser: Record<string, unknown>;
  try {
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${ghAccessToken}`, Accept: 'application/json' },
    });
    ghUser = await userRes.json() as Record<string, unknown>;
  } catch {
    return apiError(res, 502, 'github_unavailable', 'Could not fetch GitHub user profile.');
  }

  const ghUserId = String(ghUser.id);
  const ghUsername = (ghUser.login as string) ?? 'unknown';
  let email = (ghUser.email as string) ?? null;

  // Fetch email if not on profile
  if (!email) {
    try {
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${ghAccessToken}`, Accept: 'application/json' },
      });
      const emails = await emailRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
      const primary = emails.find((e) => e.primary && e.verified);
      if (primary) email = primary.email;
    } catch {}
  }

  // Upsert account + oauth_identity in a transaction
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Check for existing oauth identity
    const existing = await client.query(
      `SELECT oi.id, oi.account_id FROM oauth_identities oi WHERE oi.provider = 'github' AND oi.provider_user_id = $1`,
      [ghUserId],
    );

    let accountId: string;

    if (existing.rows.length > 0) {
      accountId = existing.rows[0].account_id;
      // Update the oauth identity tokens
      const kek = deriveAccountKEK(
        config.masterKey ?? process.env.CLAWDFATHER_MASTER_KEY ?? '',
        accountId,
      );
      const encToken = encryptPrivateKey(ghAccessToken, kek);
      await client.query(
        `UPDATE oauth_identities SET access_token = $1, provider_username = $2, provider_email = $3, updated_at = NOW()
         WHERE provider = 'github' AND provider_user_id = $4`,
        [encToken, ghUsername, email, ghUserId],
      );
      await client.query(
        `UPDATE accounts SET last_seen_at = NOW(), display_name = $1 WHERE id = $2`,
        [ghUsername, accountId],
      );
    } else {
      // Create new account
      const acctResult = await client.query(
        `INSERT INTO accounts (display_name, email) VALUES ($1, $2) RETURNING id`,
        [ghUsername, email],
      );
      accountId = acctResult.rows[0].id;

      const kek = deriveAccountKEK(
        config.masterKey ?? process.env.CLAWDFATHER_MASTER_KEY ?? '',
        accountId,
      );
      const encToken = encryptPrivateKey(ghAccessToken, kek);

      await client.query(
        `INSERT INTO oauth_identities (account_id, provider, provider_user_id, provider_username, provider_email, access_token, scopes)
         VALUES ($1, 'github', $2, $3, $4, $5, $6)`,
        [accountId, ghUserId, ghUsername, email, encToken, ['read:user', 'user:email']],
      );
    }

    // Create app session
    const token = generateSessionToken();
    const tokenH = hashToken(token);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO app_sessions (account_id, token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3::inet, $4, $5)`,
      [accountId, tokenH, ip, req.headers['user-agent'] ?? null, expiresAt.toISOString()],
    );

    await client.query('COMMIT');

    auditLog({
      account_id: accountId,
      action: 'auth.oauth.callback',
      ip_address: ip,
      result: 'ok',
      detail: { provider: 'github', github_username: ghUsername },
    });

    // Get account info for response
    const acctRow = await query('SELECT id, display_name, email FROM accounts WHERE id = $1', [accountId]);
    const acct = acctRow.rows[0];

    const wantsJson =
      (req.headers['accept'] ?? '').includes('application/json') ||
      url.searchParams.get('mode') === 'json';

    if (wantsJson) {
      apiOk(res, {
        token,
        account: { id: acct.id, display_name: acct.display_name, email: acct.email },
        expires_at: expiresAt.toISOString(),
      });
    } else {
      const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
      const isSecure =
        req.headers['x-forwarded-proto'] === 'https' ||
        (!config.webDomain.startsWith('localhost') && !config.webDomain.startsWith('127.'));
      const secureFlag = isSecure ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `session_token=${token}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
      );
      const useHttps = !config.webDomain.startsWith('localhost') && !config.webDomain.startsWith('127.');
      const port = config.webPort ?? 3000;
      const baseUrl = useHttps
        ? `https://${config.webDomain}/`
        : `http://${config.webDomain.includes(':') ? config.webDomain : `${config.webDomain}:${port}`}/`;
      res.setHeader('Location', baseUrl);
      res.writeHead(302);
      res.end();
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function handleDeleteSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  await query(
    `UPDATE app_sessions SET revoked_at = NOW() WHERE token_hash = $1`,
    [auth.tokenHash],
  );

  auditLog({
    account_id: auth.account.id,
    action: 'auth.session.revoke',
    ip_address: getClientIp(req),
    result: 'ok',
  });

  apiOk(res, { ok: true });
}

export async function handleGetMe(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const providers = await query(
    `SELECT DISTINCT provider FROM oauth_identities WHERE account_id = $1`,
    [auth.account.id],
  );

  apiOk(res, {
    account: {
      id: auth.account.id,
      display_name: auth.account.display_name,
      email: auth.account.email,
      created_at: auth.account.created_at,
      oauth_providers: providers.rows.map((r) => r.provider),
    },
  });
}

export { readBody, getClientIp };
