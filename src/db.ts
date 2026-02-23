import { Pool, PoolClient, QueryResult } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://clawdfather:clawdfather_dev_pass@localhost:5432/clawdfather';

const pool = new Pool({ connectionString: DATABASE_URL, max: 20 });

pool.on('error', (err) => {
  console.error('[clawdfather] Unexpected DB pool error:', err.message);
});

export async function query(text: string, params?: unknown[]): Promise<QueryResult> {
  return pool.query(text, params);
}

export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

export async function dbHealthCheck(): Promise<'ok' | 'unreachable'> {
  try {
    await pool.query('SELECT 1');
    return 'ok';
  } catch {
    return 'unreachable';
  }
}
