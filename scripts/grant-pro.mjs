#!/usr/bin/env node
// Manual Pro grant/renew (no billing), same semantics as
// POST /api/v1/admin/users/:id/reading-plan: row-locked, additive, audited.
// Usage:
//   node scripts/grant-pro.mjs <username|email|uuid> --days 1 --reason "..." [--dry-run]
//   npm run pro:grant -- good --days 1 --reason "..."
// See docs/PRO_GRANTS.md.
import 'dotenv/config';
import https from 'node:https';

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';

const DAY_MS = 86_400_000;

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || '').trim() : '';
}

const identifier = (process.argv[2] || '').trim();
const days = Number(flag('--days') || 1);
const reason = flag('--reason');
const dryRun = process.argv.includes('--dry-run');

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node scripts/grant-pro.mjs <username|email|uuid> --days <n> --reason "..." [--dry-run]');
  process.exit(2);
}

if (!identifier) usage();
if (!Number.isInteger(days) || days < 1 || days > 365) usage('--days must be an integer between 1 and 365');
if (!reason) usage('--reason is required (it lands in subscription_events)');
if (!process.env.DATABASE_URL) usage('DATABASE_URL is not set (see .env.example)');

const endpoint = `https://${new URL(process.env.DATABASE_URL).hostname}/sql`;

// Neon is HTTPS-only here, and the pooler's IPv6 is unreachable while IPv4
// connects can take seconds. Pin IPv4 and give connect a 30 s budget; the
// default Node/psql behaviour times out on this network.
function query(sql, params) {
  const body = JSON.stringify({ query: sql, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: new URL(endpoint).hostname,
      port: 443,
      path: '/sql',
      method: 'POST',
      family: 4,
      timeout: 30_000,
      headers: {
        'Neon-Connection-String': process.env.DATABASE_URL,
        'Neon-Raw-Text-Output': 'true',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`database error (${res.statusCode}): ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data).rows);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('database connection timed out after 30s')));
    req.on('error', reject);
    req.end(body);
  });
}

const LOOKUP = `
  SELECT id, username, display_name, email, role,
         reading_stats_plan AS plan,
         reading_stats_plan_expires_at AS expires_at,
         reading_stats_plan_status AS status,
         reading_stats_renewal_count AS renewals
  FROM users
  WHERE id::text = $1
     OR lower(username) = lower($1)
     OR lower(email) = lower($1)
     OR lower(display_name) = lower($1)
  ORDER BY CASE
    WHEN id::text = $1 THEN 0
    WHEN lower(username) = lower($1) THEN 1
    WHEN lower(email) = lower($1) THEN 2
    ELSE 3 END`;

const matches = await query(LOOKUP, [identifier]);
if (matches.length === 0) {
  console.error(`No user matches "${identifier}" (username, email, display name, or uuid).`);
  process.exit(1);
}
const best = matches[0];
const sameRank = matches.filter((row) => {
  const rank = (u) => u.id === best.id ? 0
    : u.username?.toLowerCase() === identifier.toLowerCase() ? 1
    : u.email?.toLowerCase() === identifier.toLowerCase() ? 2 : 3;
  return rank(row) === rank(best);
});
if (sameRank.length > 1) {
  console.error(`"${identifier}" is ambiguous; use the uuid:`);
  for (const row of sameRank) console.error(`  ${row.id}  ${row.username ?? '-'}  ${row.email ?? '-'}`);
  process.exit(1);
}

const now = Date.now();
const prev = Number(best.expires_at);
const livePrev = Number.isSafeInteger(prev) && prev > now ? prev : null;
const projectedExpiry = (livePrev ?? now) + days * DAY_MS;

console.log(`user      ${best.username ?? '-'} <${best.email ?? '-'}> (${best.id})`);
console.log(`current   plan=${best.plan} status=${best.status} expires=${best.expires_at ? new Date(prev).toISOString() : 'never'}`);
console.log(`grants    renewal_count=${best.renewals}`);
console.log(`action    ${livePrev ? 'extend from current expiry' : 'start from now'}`);
console.log(`new       plan=pro status=active expires=${new Date(projectedExpiry).toISOString()} (${days}d)`);

if (dryRun) {
  console.log('dry-run: nothing written');
  process.exit(0);
}

const GRANT = `
  WITH target AS (
    SELECT u.id, u.username,
           u.reading_stats_plan_expires_at AS prev_expires,
           u.reading_stats_plan_started_at AS started,
           EXISTS (SELECT 1 FROM subscription_events se
                   WHERE se.user_id = u.id AND se.type IN ('grant', 'renew')) AS has_history
    FROM users u WHERE u.id = $1
  ), calc AS (
    SELECT *, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms FROM target
  ), base AS (
    SELECT *,
           CASE WHEN prev_expires IS NOT NULL AND prev_expires > now_ms THEN prev_expires ELSE now_ms END AS base_ms,
           COALESCE(started, now_ms) AS started_ms
    FROM calc
  ), upd AS (
    UPDATE users u SET
      reading_stats_plan = 'pro',
      reading_stats_plan_started_at = b.started_ms,
      reading_stats_plan_expires_at = b.base_ms + $2,
      reading_stats_last_renewed_at = b.now_ms,
      reading_stats_plan_duration_days = $3,
      reading_stats_plan_status = 'active',
      reading_stats_renewal_count = COALESCE(u.reading_stats_renewal_count, 0) + 1,
      reading_stats_total_subscribed_ms = COALESCE(u.reading_stats_total_subscribed_ms, 0) + $2,
      updated_at = now()
    FROM base b WHERE u.id = b.id
    RETURNING u.id, u.username, u.reading_stats_plan AS plan,
              u.reading_stats_plan_expires_at AS expires_at,
              u.reading_stats_plan_status AS status,
              u.reading_stats_renewal_count AS renewals,
              b.prev_expires, b.now_ms, b.has_history
  ), ev AS (
    INSERT INTO subscription_events
      (user_id, type, actor_id, previous_expires_at, new_expires_at, duration_days, reason, occurred_at)
    SELECT u.id, CASE WHEN u.has_history THEN 'renew' ELSE 'grant' END, NULL,
           u.prev_expires, u.expires_at, $3, $4, u.now_ms
    FROM upd u
    RETURNING id
  )
  SELECT u.*, (SELECT count(*)::int FROM ev) AS events FROM upd u`;

const [result] = await query(GRANT, [best.id, days * DAY_MS, days, reason]);
if (!result) {
  console.error('Grant failed: user disappeared mid-transaction.');
  process.exit(1);
}

console.log(`written   event=${result.has_history ? 'renew' : 'grant'} days=${days} events=${result.events}`);
console.log(`result    plan=${result.plan} status=${result.status} renewals=${result.renewals} expires=${new Date(Number(result.expires_at)).toISOString()}`);
console.log(`reason    ${reason}`);
