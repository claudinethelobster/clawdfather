import type { IncomingMessage, ServerResponse } from 'http';
import { query } from '../db';
import { apiOk } from '../api-response';
import { authenticate } from '../auth-middleware';

export async function handleGetAudit(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 100);
  const before = url.searchParams.get('before');
  const action = url.searchParams.get('action');

  let whereClause = 'account_id = $1';
  const params: unknown[] = [auth.account.id];
  let idx = 2;

  if (before) {
    whereClause += ` AND created_at < $${idx}`;
    params.push(before);
    idx++;
  }

  if (action) {
    whereClause += ` AND action = $${idx}`;
    params.push(action);
    idx++;
  }

  // Fetch one extra to determine has_more
  params.push(limit + 1);

  const result = await query(
    `SELECT id, action, target_type, target_id, result, ip_address, detail, created_at
     FROM audit_log
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    params,
  );

  const hasMore = result.rows.length > limit;
  const entries = hasMore ? result.rows.slice(0, limit) : result.rows;
  const nextBefore = entries.length > 0 ? entries[entries.length - 1].created_at : null;

  apiOk(res, {
    entries,
    has_more: hasMore,
    next_before: nextBefore,
  });
}
