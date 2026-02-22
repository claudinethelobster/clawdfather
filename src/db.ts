import { Pool } from 'pg';
import { env } from './env';

const pool = new Pool({ connectionString: env.dbUrl });

export async function query(sql: string, params?: unknown[]): Promise<any> {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

export { pool };
