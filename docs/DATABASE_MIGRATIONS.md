# Database migration runbook

## Ledger integrity

Run the file-level check before generating or deploying migrations:

```sh
npm run db:check
npx drizzle-kit check --config=drizzle.config.ts
```

`db:check` verifies that every journal entry has its SQL file and snapshot,
that snapshot `prevId` values form one chain, and that no `CREATE TABLE`,
`ADD COLUMN`, or `CREATE INDEX` operation is repeated across the journal. It
does not connect to a database.

## Rollout of migration 0011

Migration `0011` adds columns to the existing, append-only reading tables and
builds five indexes. The normal Drizzle node-postgres migrator wraps pending
migrations in a transaction. PostgreSQL does not allow
`CREATE INDEX CONCURRENTLY` in that transaction, so 0011 intentionally uses
ordinary `CREATE INDEX IF NOT EXISTS` statements with a five-second
`lock_timeout` and a 30-minute `statement_timeout`.

An ordinary index build still takes a lock that blocks writes to its table while
it runs. For a large or busy production database, use the staged path:

1. Confirm the database is at least at the 0010 state (the indexed columns
   already exist even before 0011; a separate "migrate through 0010" command is
   not required when the preflight is run immediately before the full migrate).
2. With `DATABASE_URL` set, run `npm run db:indexes:concurrent`. The helper
   uses autocommit `CREATE INDEX CONCURRENTLY` statements (and removes an
   invalid leftover from an interrupted build before retrying).
3. Run `npm run db:migrate`. The `IF NOT EXISTS` index statements observe the
   valid prebuilt indexes and do not rebuild them.

If the concurrent preflight is not possible, schedule 0011 for a low-write or
maintenance window and monitor the lock timeout. Do not put
`CREATE INDEX CONCURRENTLY` directly in the Drizzle journal migration: the
project's node-postgres runner will reject it as being inside a transaction.
Neon HTTP migrations also have no transaction support, so the same concurrent
preflight is the safe index path there.
