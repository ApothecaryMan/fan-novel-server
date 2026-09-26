# Pro Subscription Entitlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Pro a 30-day time-limited meaning with renewal counting, cumulative granted time, and a complete grant/renew/revoke/expired audit trail while keeping Free permanent and derivation per-request with no background job.

**Architecture:** Add ten `users` columns plus an append-only `subscription_events` table; derive the effective plan from `planExpiresAt` on every push/pull/profile request; renew manually through an admin-only boundary using `max(now, expiry) + duration`; log natural expiry lazily and idempotently without failing reads.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL/Neon, TypeScript, Vitest, drizzle-kit.

---

## File map

- Modify: `src/database/schema.ts` — ten `users` columns, `plan_status` check, new `subscription_events` table with type check and `(user_id, occurred_at, id)` index plus partial unique `(user_id, previous_expires_at)` for `expired`.
- Create: `drizzle/0013_pro_subscription.<tag>.sql` via `npm run db:generate` — additive migration only.
- Modify: `src/features/readingSync/freeStore.ts` — add `effectiveReadingPlan(row, nowMs)`, keep `authoritativePlan` as legacy wrapper or delegate.
- Modify: `src/routes/sync.ts` — extend `SYNC_USER_COLUMNS`, extend `v2PlanProbe` select, derive in `pushV2`/`pullV2`, add expired observation call.
- Modify: `src/routes/profile.ts` — extend `PROFILE_USER_COLUMNS`, derive in `readingStatsVersion=2` branch, add expired observation call.
- Create: `src/features/readingSync/subscriptionEvents.ts` — `recordExpiredObservation`, `recordGrantEvent` helpers, fixed `system: natural expiry` reason.
- Modify: `src/routes/admin.ts` — add `POST /api/v1/admin/users/:id/reading-plan` grant/revoke with atomic `users` + event write.
- Create: `src/features/readingSync/effectivePlan.test.ts` — pure derivation matrix.
- Extend: `src/routes/readingStats.plan.test.ts`, `src/routes/readingStats.plan.postgres.test.ts` — renewal math, counters, expired idempotency, admin authz.

---

### Task 1: Subscription columns and event table

**Files:**
- Modify: `src/database/schema.ts:7-26`
- Create: `drizzle/0013_pro_subscription.<tag>.sql`
- Test: `src/database/readingStatsSchema.test.ts`

- [ ] **Step 1: Write the failing schema test**

```ts
import { describe, expect, it } from 'vitest';
import { users, subscriptionEvents } from './schema.js';

describe('subscription columns', () => {
  it('exposes renewal counters and the event table', () => {
    expect(users.readingStatsRenewalCount).toBeDefined();
    expect(users.readingStatsTotalSubscribedMs).toBeDefined();
    expect(users.readingStatsPlanExpiresAt).toBeDefined();
    expect(subscriptionEvents.userId).toBeDefined();
    expect(subscriptionEvents.type).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/database/readingStatsSchema.test.ts`
Expected: FAIL with `subscriptionEvents is not defined` or missing columns.

- [ ] **Step 3: Write minimal schema implementation**

```ts
readingStatsPlanStartedAt: bigint('reading_stats_plan_started_at', { mode: 'number' }),
readingStatsPlanExpiresAt: bigint('reading_stats_plan_expires_at', { mode: 'number' }),
readingStatsTrialStartedAt: bigint('reading_stats_trial_started_at', { mode: 'number' }),
readingStatsTrialEndsAt: bigint('reading_stats_trial_ends_at', { mode: 'number' }),
readingStatsLastRenewedAt: bigint('reading_stats_last_renewed_at', { mode: 'number' }),
readingStatsGraceUntil: bigint('reading_stats_grace_until', { mode: 'number' }),
readingStatsPlanDurationDays: integer('reading_stats_plan_duration_days').default(30).notNull(),
readingStatsPlanStatus: varchar('reading_stats_plan_status', { length: 20 }).default('free').notNull(),
readingStatsRenewalCount: integer('reading_stats_renewal_count').default(0).notNull(),
readingStatsTotalSubscribedMs: bigint('reading_stats_total_subscribed_ms', { mode: 'number' }).default(0).notNull(),
```

```ts
export const subscriptionEvents = pgTable('subscription_events', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  type: varchar('type', { length: 16 }).notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  previousExpiresAt: bigint('previous_expires_at', { mode: 'number' }),
  newExpiresAt: bigint('new_expires_at', { mode: 'number' }),
  durationDays: integer('duration_days'),
  reason: varchar('reason', { length: 500 }),
  occurredAt: bigint('occurred_at', { mode: 'number' }).notNull(),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
}, (table) => ({
  userOccurredIdx: index('subscription_events_user_occurred_idx').on(table.userId, table.occurredAt, table.id),
  typeCheck: check('subscription_events_type_check', sql`${table.type} in ('grant','renew','revoke','expired')`),
  expiredUniq: uniqueIndex('subscription_events_expired_uniq').on(table.userId, table.previousExpiresAt).where(sql`${table.type} = 'expired'`),
}));
```

- [ ] **Step 4: Generate the migration, backfill existing Pro rows, run checks**

Run: `npm run db:generate`
Run: `npm run db:check`
Run: `npm test -- src/database/readingStatsSchema.test.ts`
Expected: PASS, migration file created, integrity OK.

Backfill (one idempotent statement, reviewed separately, never inside the DDL transaction beyond defaults): rows with `reading_stats_plan = 'pro'` and no expiry concept receive one 30-day window from migration time (`plan_started_at = now`, `plan_expires_at = now + 30d`, `last_renewed_at = now`, `plan_duration_days = 30`, `plan_status = 'active'`, `renewal_count = 1`, `total_subscribed_ms = 30d`); Free rows keep all new timestamps null and `plan_status = 'free`. Record the exact `now` source in the migration log.

- [ ] **Step 5: Commit**

```bash
git add src/database/schema.ts drizzle/0013_pro_subscription.* src/database/readingStatsSchema.test.ts
git commit -m "feat(subs): add subscription columns and event log"
```

### Task 2: Effective-plan derivation

**Files:**
- Modify: `src/features/readingSync/freeStore.ts:80-87`
- Create: `src/features/readingSync/effectivePlan.test.ts`

- [ ] **Step 1: Write the failing derivation test**

```ts
import { describe, expect, it } from 'vitest';
import { effectiveReadingPlan } from './freeStore.js';

describe('effectiveReadingPlan', () => {
  it('derives pro only inside the window', () => {
    expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: 2000 }, 1999)).toBe('pro');
    expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: 2000 }, 2000)).toBe('free');
    expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: null }, 1000)).toBe('free');
    expect(effectiveReadingPlan({ readingStatsPlan: 'free', readingStatsPlanExpiresAt: 9999 }, 1000)).toBe('free');
    expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: 2000, readingStatsGraceUntil: 9999 }, 2000)).toBe('free');
    expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: 2000, readingStatsTrialEndsAt: 9999 }, 2000)).toBe('free');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/readingSync/effectivePlan.test.ts`
Expected: FAIL with `effectiveReadingPlan is not defined`.

- [ ] **Step 3: Write minimal implementation**

```ts
export function effectiveReadingPlan(
  row: { readingStatsPlan?: unknown; readingStatsPlanExpiresAt?: unknown } | null | undefined,
  nowMs: number,
): ReadingPlan {
  if (row?.readingStatsPlan !== 'pro') return 'free';
  const expiresAt = row.readingStatsPlanExpiresAt;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return 'free';
  return nowMs < expiresAt ? 'pro' : 'free';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/readingSync/effectivePlan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/readingSync/freeStore.ts src/features/readingSync/effectivePlan.test.ts
git commit -m "feat(subs): derive effective plan from expiry"
```

### Task 3: Wire derivation into push/pull/profile

**Files:**
- Modify: `src/routes/sync.ts:118-122`
- Modify: `src/routes/profile.ts:118-133`
- Test: `src/routes/readingStats.plan.test.ts`

- [ ] **Step 1: Write the failing probe test**

```ts
import { describe, expect, it } from 'vitest';

describe('pro expiry derivation', () => {
  it('serves free projection after expiry without touching contracts', async () => {
    await seedUser(SUBJECT, { readingStatsPlan: 'pro', readingStatsPlanExpiresAt: Date.now() - 1000 });
    const res = await pull({ syncVersion: 2, user: { externalId: SUBJECT } });
    expect(res.status).toBe(200);
    expect((await res.json()).plan).toBe('free');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/routes/readingStats.plan.test.ts`
Expected: FAIL with pro projection or 501 instead of free.

- [ ] **Step 3: Write minimal implementation**

```ts
const SUBSCRIPTION_USER_COLUMNS = {
  readingStatsPlanExpiresAt: users.readingStatsPlanExpiresAt,
} as const;

const SYNC_USER_COLUMNS = {
  id: users.id,
  externalId: users.externalId,
  readingStatsPlan: users.readingStatsPlan,
  ...SUBSCRIPTION_USER_COLUMNS,
} as const;
```

```ts
import { effectiveReadingPlan } from '../features/readingSync/freeStore.js';
const plan = effectiveReadingPlan(user, Date.now());
```

Apply the same extension to `PROFILE_USER_COLUMNS` and use `effectiveReadingPlan(row, Date.now())` in the `readingStatsVersion=2` branch. Keep `toPublic()` unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/routes/readingStats.plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/sync.ts src/routes/profile.ts src/routes/readingStats.plan.test.ts
git commit -m "feat(subs): gate sync surfaces on derived plan"
```

### Task 4: Idempotent expired observation

**Files:**
- Create: `src/features/readingSync/subscriptionEvents.ts`
- Modify: `src/routes/sync.ts`
- Modify: `src/routes/profile.ts`
- Test: `src/routes/readingStats.plan.postgres.test.ts`

- [ ] **Step 1: Write the failing expiry-log test**

```ts
import { describe, expect, it } from 'vitest';

describe('expired observation', () => {
  it('writes exactly one expired row for concurrent observers', async () => {
    const { externalId, token } = await createProUserWithExpiry(Date.now() - 1000);
    await Promise.all([
      pullPro({ externalId, token }),
      pullPro({ externalId, token }),
      getProfile({ externalId, token }),
    ]);
    expect(await countExpiredEvents(externalId)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/routes/readingStats.plan.postgres.test.ts`
Expected: FAIL with 0 expired rows.

- [ ] **Step 3: Write minimal implementation**

```ts
import { subscriptionEvents } from '../../database/schema.js';

export const EXPIRED_EVENT_REASON = 'system: natural expiry';

export async function recordExpiredObservation(
  userId: string,
  previousExpiresAt: number,
  nowMs: number,
): Promise<void> {
  try {
    await db.insert(subscriptionEvents).values({
      userId,
      type: 'expired',
      actorId: null,
      previousExpiresAt,
      newExpiresAt: null,
      durationDays: null,
      reason: EXPIRED_EVENT_REASON,
      occurredAt: nowMs,
    }).onConflictDoNothing();
  } catch (error) {
    console.warn(JSON.stringify({ event: 'sync.plan_expired_log', outcome: 'unavailable' }));
  }
}
```

Call it after computing a Free-derived response for a stored-pro row, without awaiting it before the response and without calling `noteDbFailure()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/routes/readingStats.plan.postgres.test.ts`
Expected: PASS with exactly one row.

- [ ] **Step 5: Commit**

```bash
git add src/features/readingSync/subscriptionEvents.ts src/routes/sync.ts src/routes/profile.ts src/routes/readingStats.plan.postgres.test.ts
git commit -m "feat(subs): log natural expiry idempotently"
```

### Task 5: Manual grant and revoke with atomic events

**Files:**
- Modify: `src/routes/admin.ts`
- Test: `src/routes/admin.subscription.test.ts`

- [ ] **Step 1: Write the failing admin test**

```ts
import { describe, expect, it } from 'vitest';

describe('admin reading plan', () => {
  it('extends from the live expiry and counts the grant', async () => {
    const before = Date.now() + 10 * 86400_000;
    await seedProUser({ expiresAt: before });
    const res = await grantPlan({ plan: 'pro', durationDays: 30 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.planExpiresAt).toBe(before + 30 * 86400_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/routes/admin.subscription.test.ts`
Expected: FAIL with 404 route not found.

- [ ] **Step 3: Write minimal implementation**

```ts
const readingPlanGrantSchema = z.object({
  plan: z.enum(['pro', 'free']),
  durationDays: z.number().int().min(1).max(365).optional(),
  reason: z.string().max(500).optional(),
});

adminRouter.post('/users/:id/reading-plan', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = readingPlanGrantSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid plan grant' }, 400);
  const now = Date.now();
  const durationDays = parsed.data.durationDays ?? 30;
  const durationMs = durationDays * 86400_000;
  const [row] = await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1);
  if (!row) return c.json({ error: 'user not found' }, 404);
  if (parsed.data.plan === 'free') {
    await db.transaction(async (tx) => {
      await tx.update(users).set({
        readingStatsPlan: 'free',
        readingStatsPlanExpiresAt: null,
        readingStatsGraceUntil: null,
        readingStatsPlanStatus: 'cancelled',
      }).where(eq(users.id, row.id));
      await tx.insert(subscriptionEvents).values({
        userId: row.id, type: 'revoke', actorId: c.get('caller').row.id,
        previousExpiresAt: row.readingStatsPlanExpiresAt,
        newExpiresAt: null, durationDays: null,
        reason: parsed.data.reason ?? null, occurredAt: now,
      });
    });
    return c.json({ success: true, effectivePlan: 'free', planStatus: 'cancelled' });
  }
  const base = row.readingStatsPlanExpiresAt !== null
    && row.readingStatsPlanExpiresAt > now
    ? row.readingStatsPlanExpiresAt : now;
  const expiresAt = base + durationMs;
  await db.transaction(async (tx) => {
    await tx.update(users).set({
      readingStatsPlan: 'pro',
      readingStatsPlanStartedAt: now,
      readingStatsPlanExpiresAt: expiresAt,
      readingStatsLastRenewedAt: now,
      readingStatsPlanDurationDays: durationDays,
      readingStatsPlanStatus: 'active',
      readingStatsRenewalCount: sql`${users.readingStatsRenewalCount} + 1`,
      readingStatsTotalSubscribedMs: sql`${users.readingStatsTotalSubscribedMs} + ${durationMs}`,
    }).where(eq(users.id, row.id));
    await tx.insert(subscriptionEvents).values({
      userId: row.id,
      type: row.readingStatsPlanExpiresAt !== null && row.readingStatsPlanExpiresAt > now ? 'renew' : 'grant',
      actorId: c.get('caller').row.id,
      previousExpiresAt: row.readingStatsPlanExpiresAt,
      newExpiresAt: expiresAt, durationDays,
      reason: parsed.data.reason ?? null, occurredAt: now,
    });
  });
  console.log(JSON.stringify({ event: 'reading_plan.grant', userId: row.id, plan: 'pro', durationDays, expiresAt, actor: c.get('caller').row.id }));
  return c.json({ success: true, effectivePlan: 'pro', planExpiresAt: expiresAt, planStatus: 'active' });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/routes/admin.subscription.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts src/routes/admin.subscription.test.ts
git commit -m "feat(subs): add manual grant and revoke"
```
