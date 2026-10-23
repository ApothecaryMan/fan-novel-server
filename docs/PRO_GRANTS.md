# Manual Pro grants

Giving an account Pro by hand is one command. It writes the same fields and the
same audit row as `POST /api/v1/admin/users/:id/reading-plan`, so there is never
a need to hand-edit `users.reading_stats_*`.

## The one command

```sh
node scripts/grant-pro.mjs <username|email|uuid> --days 1 --reason "why"
npm run pro:grant -- good --days 1 --reason "trial extension"
```

Add `--dry-run` to print the current window and the projected expiry without
writing anything.

## What it does

1. Resolves the user by uuid, username, email, or display name (ambiguous
   display names abort and ask for the uuid).
2. Runs one atomic SQL statement — the user row and the `subscription_events`
   row commit together or not at all.
3. Sets `reading_stats_plan = 'pro'`, `reading_stats_plan_status = 'active'`,
   `reading_stats_plan_expires_at`, `reading_stats_last_renewed_at`,
   `reading_stats_plan_duration_days`, increments
   `reading_stats_renewal_count`, and adds the window to
   `reading_stats_total_subscribed_ms`.
4. Logs `subscription_events.type = 'renew'` when the account already has a
   grant/renew history, otherwise `'grant'`. `actor_id` is null for CLI runs, so
   put the operator in `--reason`.

## Semantics (do not invent your own)

- A live window is `plan_expires_at > now`. A **renew** extends from that
  expiry; an expired or missing window starts from `now`.
- `--days` is additive. Running the command twice gives two extra windows, on
  purpose — there is no idempotency key here.
- `reading_stats_plan_status = 'active'` alone proves nothing. The effective
  plan is `pro` only while the expiry is in the future; an expired account can
  still show `status = 'active'`, and `effectiveReadingPlan()` returns `free`.
- `reading_stats_plan_started_at` keeps the first start; it is not reset by a
  renewal.

## Verify

```sh
node scripts/grant-pro.mjs good --days 1 --reason "check" --dry-run
```

or directly:

```sql
SELECT username, reading_stats_plan, reading_stats_plan_status,
       to_timestamp(reading_stats_plan_expires_at / 1000.0) AS expires
FROM users WHERE username = 'good';

SELECT type, duration_days, reason, new_expires_at
FROM subscription_events
WHERE user_id = (SELECT id FROM users WHERE username = 'good')
ORDER BY id DESC LIMIT 3;
```

## Environment / network gotcha

`psql` and the default Node HTTP stack can time out against this Neon pooler on
some networks (IPv6 is unreachable, IPv4 connects take seconds). The script
pins IPv4 and a 30 s connect timeout in its own HTTPS client, so it works where
`psql` hangs. Do not "fix" that by disabling TLS or editing the connection
string.

`DATABASE_URL` decides which database is touched. Confirm it points at the
intended Neon project before running without `--dry-run`.

## Related files

- `scripts/grant-pro.mjs` — the command
- `src/routes/admin.ts` (`/users/:id/reading-plan`) — the HTTP equivalent
- `src/features/readingSync/freeStore.ts` — `effectiveReadingPlan()`
- `src/database/schema.ts` — `users` Pro columns and `subscription_events`
