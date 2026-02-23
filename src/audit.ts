import { query } from './db';

export function auditLog(params: {
  account_id?: string;
  action: string;
  target_type?: string;
  target_id?: string;
  ip_address?: string;
  result: 'ok' | 'failed';
  detail?: Record<string, unknown>;
}): void {
  const actor = params.account_id ? `account:${params.account_id}` : 'system';
  query(
    `INSERT INTO audit_log (account_id, actor, action, target_type, target_id, ip_address, result, detail)
     VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8)`,
    [
      params.account_id ?? null,
      actor,
      params.action,
      params.target_type ?? null,
      params.target_id ?? null,
      params.ip_address ?? null,
      params.result,
      params.detail ? JSON.stringify(params.detail) : null,
    ],
  ).catch((err) => {
    console.error('[clawdfather] Audit log insert failed:', err.message);
  });
}
