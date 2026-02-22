import type { IncomingMessage, ServerResponse } from 'http';
import { query } from '../db';
import { apiOk } from '../api-response';
import { authenticate } from '../auth-middleware';

export async function handleListAuditLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;

  const result = await query(
    `SELECT id, action, target_type, target_id, result, metadata, ip_address, created_at
     FROM audit_logs WHERE account_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [auth.account.id],
  );

  apiOk(res, { events: result.rows });
}
