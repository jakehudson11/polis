import pg from 'pg';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (pool) return pool;

  const url = process.env.AGORA_DATABASE_URL;
  if (!url) {
    console.warn('[agora-pg] AGORA_DATABASE_URL not set, AI usage logging disabled');
    return null;
  }

  try {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    pool.on('error', (err) => {
      console.error('[agora-pg] Pool error:', err.message);
      pool = null;
    });
    return pool;
  } catch (err) {
    console.error('[agora-pg] Failed to create pool:', err);
    return null;
  }
}

export async function agoraQuery(text: string, params?: any[]): Promise<pg.QueryResult | null> {
  const p = getPool();
  if (!p) return null;
  try {
    return await p.query(text, params);
  } catch (err) {
    console.error('[agora-pg] Query error:', err);
    return null;
  }
}
