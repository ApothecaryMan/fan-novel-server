# Phase 1 security release gates

## Scope and authorization

This release hardens account identity only. No app, R2, frame, entitlement, payment, or general ownership changes are included. Do not run production commands during plan review. Deployment and migration require explicit user authorization, and a live Google login smoke check requires a separate approval because it writes account data.

Production accounts bind permanently to `googleSubject` and `google_<verified sub>`. There is no legacy linking, repair, or backfill. Unexpected existing users STOP the release; do not delete them or populate subjects automatically. Do not roll back to the old permissive auth code or erase subject bindings. Prefer a fixed secure release or temporary unavailability.

## Local acceptance

From the repository root, with the dedicated local test container running:

```bash
npm run typecheck
npm test
PHASE1_PG_URL='postgresql://phase1:phase1-local-only@127.0.0.1:55432/phase1_identity_test' npm test -- src/routes/googleAccount.postgres.test.ts
npm run build
mkdir -p /tmp/opencode/fan-novel-phase1-dry-run
npx wrangler deploy --dry-run --outdir /tmp/opencode/fan-novel-phase1-dry-run
```

All commands must exit 0; four isolated PostgreSQL cases must pass, not skip. Dry-run must report successful bundling and exit without deployment. It validates neither deployed secret values nor database availability. No local test calls real Google or production storage.

Local starts must set `NODE_ENV=development` or `test` explicitly. `.env.example` already specifies development; do not copy its production-placeholder JWT secret into a deployment. Production needs explicit `NODE_ENV=production`, `SYNC_OPEN=false` exactly, at least one nonempty Google audience, a valid postgres/postgresql database URL, and a nondefault JWT secret of at least 32 UTF-8 bytes. Invalid numeric settings also stop initialization. On Node this happens before listen; on Workers it happens at request initialization, not necessarily at upload time.

## Actual production-value validation (no value output)

A release operator must provide the exact intended/current deployed `DATABASE_URL` and `JWT_SECRET` from the authorized secret source and confirm whether secret bindings override any checked-in vars, especially `ADMIN_EMAILS`. Secret-name listing cannot prove their values. If these exact values or override information are unavailable, STOP; a successful dry-run is not a substitute. Do not print, commit, or store secrets in the repository. Never run these commands under shell tracing.

After explicit release authorization, run in one Bash shell:

```bash
set +x
read -r -s -p 'Exact deployed DATABASE_URL: ' DATABASE_URL; printf '\n'
read -r -s -p 'Exact deployed JWT_SECRET: ' JWT_SECRET; printf '\n'
export DATABASE_URL JWT_SECRET
node --input-type=module - <<'JS'
import fs from 'node:fs';
import { getEnv, setWorkerEnv } from './dist/config/env.js';
const text = fs.readFileSync('wrangler.toml', 'utf8');
const vars = {};
for (const line of text.split('\n')) {
  const match = /^(NODE_ENV|SYNC_OPEN|CORS_ORIGIN|GOOGLE_WEB_CLIENT_ID|GOOGLE_ANDROID_CLIENT_ID|ADMIN_EMAILS) = "([^"]*)"$/.exec(line);
  if (match) vars[match[1]] = match[2];
}
setWorkerEnv({ ...vars, DATABASE_URL: process.env.DATABASE_URL, JWT_SECRET: process.env.JWT_SECRET });
try { getEnv(); console.log('PRODUCTION_CONFIG_VALID'); }
catch (error) { console.error(error.message); process.exitCode = 1; }
JS
```

Expected `PRODUCTION_CONFIG_VALID`, exit 0. This uses the checked-in production vars and the two exact secrets; it is valid only after the operator confirms there are no deployed secret overrides of those vars and no extra invalid numeric overrides. If overrides exist, STOP and reconcile the release configuration with the user; this plan does not authorize changing unrelated bindings. Confirm Google audiences and the administrator allowlist against the intended deployment without posting email values to logs or chat.

## Read-only emptiness and database-health gate

Keep the approved secret variables in the same shell. Run immediately before migration and again immediately before deployment. The operator must prevent registrations during this interval using the deployment's approved maintenance procedure; if that cannot be confirmed, STOP rather than race the old provisioning code.

```bash
node --input-type=module - <<'JS'
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const result = await client.query('SELECT count(*)::text AS count FROM public.users');
  await client.query('ROLLBACK');
  if (result.rows[0].count !== '0') {
    console.error('STOP: users are not empty; consult the user. No mutations authorized.');
    process.exitCode = 2;
  } else console.log('USERS_EMPTY_AND_DATABASE_REACHABLE');
} catch {
  console.error('STOP: database validation unavailable'); process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
JS
```

Expected `USERS_EMPTY_AND_DATABASE_REACHABLE`, exit 0. Nonzero count means STOP and consult the user; do not delete rows or backfill subjects. A failed connection means STOP. This check performs no account writes.

## Migration gate

After empty-table verification and explicit migration authorization:

```bash
node --input-type=module - <<'JS'
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='google_subject'");
  if (rows.length !== 1) throw new Error('missing migration column');
  const constraint = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_google_subject_unique' AND contype='u'");
  if (constraint.rows.length !== 1) throw new Error('missing migration constraint');
  console.log('IDENTITY_MIGRATION_APPLIED');
} catch {
  console.error('STOP: migration or schema verification failed; inspect through approved private diagnostics');
  process.exitCode = 1;
} finally { await pool.end(); }
JS
```

Expected `IDENTITY_MIGRATION_APPLIED`, exit 0. This uses the existing Drizzle journal workflow without printing raw SQL/driver errors or connection strings. Do not run `drizzle-kit push` or remove the nullable subject column. Stop if earlier migration history is inconsistent.

## Deployment gate

After the user authorizes the release, all local checks pass, exact production configuration is validated, and the read-only gate is rerun successfully with registrations still held:

```bash
npx wrangler deploy
unset DATABASE_URL JWT_SECRET
```

Expected successful upload/deployment of `fan-novel-server` and a version ID. Record the version ID, not secrets. Preserve `wrangler.toml` and all R2 bindings/assets unchanged. Do not run any R2 commands. Resume registrations only after the operator confirms the hardened version is active.

For read-only post-release health, enter the HTTPS deployment origin printed by Wrangler:

```bash
read -r -p 'Deployed HTTPS origin: ' PHASE1_ORIGIN
export PHASE1_ORIGIN
node --input-type=module - <<'JS'
try {
  const url = new URL('/health', process.env.PHASE1_ORIGIN);
  if (url.protocol !== 'https:') throw new Error('HTTPS required');
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || body.db !== 'up') throw new Error('unhealthy');
  console.log('DEPLOYED_DATABASE_UP');
} catch { console.error('STOP: deployed health check failed'); process.exitCode = 1; }
JS
unset PHASE1_ORIGIN
```

Expected `DEPLOYED_DATABASE_UP`, exit 0. Do not infer success merely from `status: ok`; require `db: up`. Inspect only redacted account events through approved observability access. A creation event contains `event`, `requestId`, `accountId`, and `outcome`, once per inserted account; repeated unchanged login has no account writes or provisioning event. No tokens, emails or secrets belong in these events. No live login test is included; obtain separate approval before one. On failure keep bindings/column intact and use a fixed secure release or temporary unavailability.
