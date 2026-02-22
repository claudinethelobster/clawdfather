import type { IncomingMessage, ServerResponse } from 'http';
import { query } from '../db';
import { apiOk, apiError } from '../api-response';

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  let dbStatus = 'ok';
  try {
    await query('SELECT 1');
  } catch {
    dbStatus = 'error';
  }

  const status = dbStatus === 'ok' ? 'ok' : 'degraded';
  const code = dbStatus === 'ok' ? 200 : 503;

  if (code === 200) {
    apiOk(res, { status, db: dbStatus, version: '0.2.0' });
  } else {
    apiError(res, code, 'db_error', 'Database unavailable');
  }
}
