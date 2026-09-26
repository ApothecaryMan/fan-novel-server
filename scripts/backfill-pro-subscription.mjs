#!/usr/bin/env node
// Backfill time-limited Pro windows for pre-entitlement `pro` rows.
// Idempotent: only touches `pro` rows whose plan_expires_at IS NULL, and
// skips users that already hold a migration-backfill grant event.
// Usage:
//   DATABASE_URL=... node scripts/backfill-pro-subscription.mjs [--dry-run]
import 'dotenv/config';
import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const DURATION_DAYS = 30;
const DAY_MS = 86_400_000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const candidates = await pool.query(
    `SELECT id FROM users WHERE reading_stats_plan = 'pro'
     AND reading_stats_plan_expires_at IS NULL`,
  );
  console.log(JSON.stringify({ event: 'pro_backfill.scan', candidates: candidates.rowCount, dryRun: DRY_RUN }));
  if (DRY_RUN) process.exit(0);
  let backfilled = 0;
  for (const { id } of candidates.rows) {
    const prior = await pool.query(
      `SELECT 1 FROM subscription_events
       WHERE user_id = $1 AND type = 'grant' AND reason = 'system: migration backfill' LIMIT 1`,
      [id],
    );
    if ((prior.rowCount ?? 0) > 0) continue;
    const now = Date.now();
    const expiresAt = now + DURATION_DAYS * DAY_MS;
    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE users SET reading_stats_plan_started_at = $2,
         reading_stats_plan_expires_at = $3, reading_stats_last_renewed_at = $2,
         reading_stats_plan_duration_days = $4, reading_stats_plan_status = 'active',
         reading_stats_renewal_count = reading_stats_renewal_count + 1,
         reading_stats_total_subscribed_ms = reading_stats_total_subscribed_ms + $5,
         updated_at = now()
         WHERE id = $1 AND reading_stats_plan_expires_at IS NULL`,
        [id, now, expiresAt, DURATION_DAYS, DURATION_DAYS * DAY_MS],
      );
      await pool.query(
        `INSERT INTO subscription_events
         (user_id, type, actor_id, previous_expires_at, new_expires_at,
          duration_days, reason, occurred_at)
         VALUES ($1, 'grant', NULL, NULL, $2, $3, 'system: migration backfill', $4)`,
        [id, expiresAt, DURATION_DAYS, now],
      );
      await pool.query('COMMIT');
      backfilled += 1;
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
  console.log(JSON.stringify({ event: 'pro_backfill.done', backfilled, now: Date.now() }));
} finally {
  await pool.end();
}
