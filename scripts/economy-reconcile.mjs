#!/usr/bin/env node
import pg from 'pg';

const out = [];
let mismatches = 0;
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  try {
    const { rows } = await pool.query(
      `SELECT b.user_id, b.currency, b.balance, COALESCE(SUM(t.amount), 0) AS total
       FROM user_coin_balances b LEFT JOIN point_transactions t
       ON t.user_id = b.user_id AND t.currency = b.currency
       GROUP BY b.user_id, b.currency`);
    for (const r of rows) {
      if (Number(r.total) !== r.balance) {
        mismatches++;
        out.push({ userId: r.user_id, currency: r.currency, wallet: r.balance, ledger: Number(r.total) });
      }
    }
    console.log(JSON.stringify({ checked: rows.length, mismatches, rows: out }));
    if (mismatches) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
