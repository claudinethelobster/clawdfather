import type { IncomingMessage, ServerResponse } from 'http';
import { query } from './db';
import { hashToken } from './crypto';
import { apiError } from './api-response';

export interface AuthResult {
  account: {
    id: string;
    github_id: string;
    login: string;
    display_name: string | null;
    email: string | null;
    avatar_url: string | null;
  };
  sessionToken: string;
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function extractCookieToken(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? match[1] : null;
}

export async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<AuthResult | null> {
  const token = extractBearerToken(req) ?? extractCookieToken(req);
  if (!token) {
    apiError(res, 401, 'unauthorized', 'Authentication required.');
    return null;
  }

  const tokenHash = hashToken(token);

  const result = await query(
    `SELECT s.account_id, s.token_hash,
            a.id, a.github_id, a.login, a.display_name, a.email, a.avatar_url
     FROM auth_sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND s.revoked_at IS NULL`,
    [tokenHash],
  );

  if (result.rows.length === 0) {
    apiError(res, 401, 'unauthorized', 'Authentication required.');
    return null;
  }

  query('UPDATE auth_sessions SET last_used_at = NOW() WHERE token_hash = $1', [tokenHash]).catch(() => {});

  const row = result.rows[0];
  return {
    account: {
      id: row.id,
      github_id: row.github_id,
      login: row.login,
      display_name: row.display_name,
      email: row.email,
      avatar_url: row.avatar_url,
    },
    sessionToken: token,
  };
}
