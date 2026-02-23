import type { IncomingMessage, ServerResponse } from 'http';
import { dbHealthCheck, query } from '../db';
import { apiOk } from '../api-response';

const START_TIME = Date.now();

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = await dbHealthCheck();

  let activeSessions = 0;
  try {
    const r = await query("SELECT COUNT(*) AS cnt FROM session_leases WHERE status IN ('pending','active')");
    activeSessions = parseInt(r.rows[0].cnt, 10);
  } catch {}

  const status = db === 'ok' ? 'ok' : 'degraded';
  const statusCode = status === 'ok' ? 200 : 503;

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status,
    active_sessions: activeSessions,
    db,
    version: '0.2.0',
    uptime_s: Math.floor((Date.now() - START_TIME) / 1000),
  }));
}
