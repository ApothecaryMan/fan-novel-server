#!/usr/bin/env node
import pg from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  try {
    const { rows: legacy } = await pool.query(
      `SELECT id, sku, type, metadata FROM store_items WHERE sku LIKE 'legacy-%'`);
    const { rows: seeded } = await pool.query(
      `SELECT id, type, metadata FROM store_items WHERE NOT (sku LIKE 'legacy-%')`);
    let merged = 0;
    const kept = [];
    for (const leg of legacy) {
      const field = leg.metadata?.frameKey ? 'frameKey' : leg.metadata?.styleId ? 'styleId' : null;
      const needle = field ? leg.metadata[field] : null;
      const hit = needle ? seeded.find((s) => s.type === leg.type && s.metadata?.[field] === needle) : null;
      if (!hit) {
        kept.push(leg.sku);
        continue;
      }
      await pool.query('BEGIN');
      try {
        await pool.query(`INSERT INTO user_inventory (user_id, item_id, source, price_paid, currency)
          SELECT user_id, $2, source, price_paid, currency FROM user_inventory WHERE item_id = $1
          ON CONFLICT (user_id, item_id) DO NOTHING`, [leg.id, hit.id]);
        await pool.query(`UPDATE user_equipped SET item_id = $2 WHERE item_id = $1`, [leg.id, hit.id]);
        await pool.query(`DELETE FROM user_inventory WHERE item_id = $1`, [leg.id]);
        await pool.query(`DELETE FROM store_items WHERE id = $1`, [leg.id]);
        await pool.query('COMMIT');
        merged++;
      } catch (e) {
        await pool.query('ROLLBACK');
        throw e;
      }
    }
    console.log(JSON.stringify({ legacy: legacy.length, merged, kept }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
