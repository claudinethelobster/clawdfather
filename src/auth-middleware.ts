import type { IncomingMessage, ServerResponse } from 'http';
import { hashToken } from './crypto';
import { query } from './db';
import { apiError } from './api-response';
import type { Account } from './types';

const LAST_USED_DEBOUNCE_MS = 60_000;

export async function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ account: Account; tokenHash: string } | null> {
  let token: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    const cookieHeader = req.headers.cookie ?? '';
    const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('session_token='));
    if (match) token = match.slice('session_token='.length);
  }
  if (!token) {
    apiError(res, 401, 'unauthorized', 'Missing or invalid auth token.');
    return null;
  }

  const tokenH = hashToken(token);

  const result = await query(
    `SELECT s.id AS session_id, s.last_used_at, a.id, a.display_name, a.email, a.created_at, a.last_seen_at, a.is_active
     FROM app_sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1
       AND s.expires_at > NOW()
       AND s.revoked_at IS NULL
       AND a.is_active = TRUE`,
    [tokenH],
  );

  if (result.rows.length === 0) {
    apiError(res, 401, 'unauthorized', 'Missing or invalid auth token.');
    return null;
  }

  const row = result.rows[0];

  // Debounced last_used_at update
  const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (Date.now() - lastUsed > LAST_USED_DEBOUNCE_MS) {
    query('UPDATE app_sessions SET last_used_at = NOW() WHERE token_hash = $1', [tokenH]).catch(() => {});
    query('UPDATE accounts SET last_seen_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
  }

  return {
    account: {
      id: row.id,
      display_name: row.display_name,
      email: row.email,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      is_active: row.is_active,
    },
    tokenHash: tokenH,
  };
}
