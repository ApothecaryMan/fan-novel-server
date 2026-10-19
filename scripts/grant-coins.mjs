#!/usr/bin/env node
// Grant coins to a user through the ledger (never raw SQL): the single balance
// writer plus an idempotency key keeps point_transactions append-only.
// Usage:
//   node scripts/grant-coins.mjs good --amount 1000 --reason "..." [--currency free|pro] [--dry-run]
//   npm run economy:grant -- good --amount 1000 --reason "..."
// Identifier accepts username, email, or uuid. See docs/ECONOMY_GRANTS.md.
import 'dotenv/config';
import pg from 'pg';

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || '').trim() : '';
}

const identifier = (process.argv[2] || '').trim();
const amount = Number(flag('--amount'));
const currency = flag('--currency') || 'free';
const reason = flag('--reason');
const dryRun = process.argv.includes('--dry-run');

if (!identifier) {
  console.error('Usage: node scripts/grant-coins.mjs <username|email|uuid> --amount <n> --reason "..." [--currency free|pro] [--dry-run]');
  process.exit(2);
}
if (!Number.isInteger(amount) || amount < 1) {
  console.error('Amount must be a positive integer');
  process.exit(2);
}
if (currency !== 'free' && currency !== 'pro') {
  console.error('Currency must be free or pro');
  process.exit(2);
}
if (!reason) {
  console.error('A --reason is required (recorded in the ledger row)');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(2);
}

// Fail closed: if the compiled config cannot load (stale dist), refuse rather
// than run without the cap. Rebuild with `npm run build` and retry.
const econConfig = await import('../dist/features/economy/config.js').catch(() => ({}));
const ADMIN_GRANT_MAX = econConfig.ADMIN_GRANT_MAX;
if (!Number.isInteger(ADMIN_GRANT_MAX)) {
  console.error('Could not load ADMIN_GRANT_MAX from dist — run `npm run build` first');
  process.exit(2);
}
if (amount > ADMIN_GRANT_MAX) {
  console.error(`Amount exceeds ADMIN_GRANT_MAX (${ADMIN_GRANT_MAX})`);
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const found = await pool.query(
    'SELECT id, username, email FROM users WHERE id::text = $1 OR lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 2',
    [identifier],
  );
  if (found.rowCount === 0) {
    console.error(`No user found for ${identifier}`);
    process.exit(1);
  }
  if (found.rowCount > 1) {
    console.error(`Ambiguous identifier ${identifier}: use the uuid`);
    process.exit(1);
  }
  const user = found.rows[0];
  const [{ db, initDb }, { grantPoints, getBalances }] = await Promise.all([
    import('../dist/database/db.js'),
    import('../dist/features/economy/service.js'),
  ]);
  await initDb();
  if (dryRun) {
    const balances = await getBalances(db, user.id).catch(() => null);
    console.log(JSON.stringify({ dryRun: true, user, amount, currency, reason, balances }, null, 2));
    process.exit(0);
  }
  const key = `admin-manual:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const res = await grantPoints(db, {
    userId: user.id, amount, currency, type: 'admin_adjust', key,
    source: 'admin', referenceType: 'admin_grant', reason, actorId: null,
  });
  const balances = await getBalances(db, user.id);
  console.log(JSON.stringify({ user, key, ...res, balances }, null, 2));
} catch (err) {
  console.error('Failed:', err.code ?? '', err.cause?.message ?? err.message ?? err);
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
