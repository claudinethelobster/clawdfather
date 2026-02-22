import { query } from './db';

export async function auditLog(params: {
  accountId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  result: 'ok' | 'fail' | 'deny';
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (account_id, action, target_type, target_id, result, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.accountId,
        params.action,
        params.targetType ?? null,
        params.targetId ?? null,
        params.result,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.ipAddress ?? null,
      ],
    );
  } catch (err: any) {
    console.error(`[clawdfather] audit log write failed: ${err.message}`);
  }
}
