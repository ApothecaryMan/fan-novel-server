# Reading Abuse Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reading-time and view-counter abuse holes without breaking the official client's offline-first sync.

**Architecture:** Validate time evidence at the contract boundary, enforce server-derived day dimensions and daily budgets at the store layer, and decouple public view counts from content freshness. Legacy v1 is brought to v2 parity, not removed.

**Tech Stack:** TypeScript, Hono, drizzle-orm (node-postgres + neon-http), Zod contracts, Vitest (`npm test` = `vitest run`).

**Spec:** This plan implements the audit findings from the 2026-10-22 reading-time abuse review (no separate spec doc; the audit's P0/P1/P2 list in chat is the spec and travels with this plan).

## Global Constraints

- `npm test` (`vitest run`) must stay green; Postgres-gated tests boot a throwaway cluster via `src/test/pgGlobalSetup.ts`.
- `npm run typecheck` (`tsc --noEmit`) must stay clean.
- v2 batch limit stays `MAX_SESSIONS_PER_PUSH = 500` (`src/features/readingSync/contracts.ts:16`).
- Completion boundary stays `COMPLETION_THRESHOLD = 85` (`contracts.ts:15`).
- View dedup window stays 12 hours (`VIEW_REVISIT_WINDOW_MS`, `src/routes/chapters.ts:426`, SQL `interval '12 hours'`).
- Never store raw IP; anonymous viewer key stays `ip:<sha256(ip|ua)>` until the device-id task lands.
- `noteDbFailure()` is for real storage failures only, never for client validation errors.

## Review Focus

- A `ts` of `8640000000000001` must return 400, not 503, and must not trip the 30s DB breaker.
- A legacy v1 push with `seconds: 2000000000` and no `syncVersion` must be capped/rejected, not stored.
- 500 sessions x 86400s in one push must not reach lifetime totals; the daily budget must clamp it.
- A session with `seconds: 0, progressPercent: 100, completed: true` on a fabricated `(novelId, chapterId)` must not rank on the leaderboard.
- Rotating `X-Forwarded-For` must not grant a fresh 60/min budget or a fresh viewer key on Workers.

---

### Task 1: Time-evidence guard (ts range + fail-closed day derivation)

**Files:**
- Modify: `src/features/readingSync/contracts.ts:39-40`
- Modify: `src/features/readingSync/freeStore.ts:51-54`
- Modify: `src/routes/sync.ts:318-332` (remove `noteDbFailure()` from the validation-error path if touched)
- Test: `src/features/readingSync/freeStore.timeGuard.test.ts` (new)

**Interfaces:**
- Consumes: `epochMilliseconds()` (contracts.ts:40), `utcDayFromTs(ts: number): string` (freeStore.ts:51).
- Produces: `utcDayFromTs(ts): string` returning `''` for out-of-range input (never throws); `epochMilliseconds` bounded to `0..8_640_000_000_000_000` (max valid `Date`); sync push mapping a bad `ts` to 400 without calling `noteDbFailure()`.

- [ ] **Step 1: Write the failing test**

```ts
it('rejects ts beyond the valid Date range without tripping the breaker', async () => {
  const res = await postFreePush([{ ...goodSession(), ts: 8640000000000001 }]);
  expect(res.status).toBe(400);
  expect(await secondGoodPush()).toBe(200);
});
it('utcDayFromTs never throws', () => {
  expect(utcDayFromTs(8640000000000001)).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/readingSync/freeStore.timeGuard.test.ts`
Expected: FAIL (currently 503 via breaker / throws RangeError).

- [ ] **Step 3: Implement bounded `epochMilliseconds` in `src/features/readingSync/contracts.ts` and fail-closed `utcDayFromTs` in `src/features/readingSync/freeStore.ts`**

Bound the schema to the valid-Date range; make `utcDayFromTs` return `''` on anything outside it. Ensure the push route treats this as a contract 400, never `noteDbFailure()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/readingSync/freeStore.timeGuard.test.ts src/routes/readingStats.plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/readingSync/contracts.ts src/features/readingSync/freeStore.ts src/routes/sync.ts src/features/readingSync/freeStore.timeGuard.test.ts
git commit -m "fix: bound session ts and fail-closed day derivation"
```

### Task 2: Legacy v1 session parity caps

**Files:**
- Modify: `src/routes/sync.ts:77-92` (legacy `sessionRowSchema`), `src/routes/sync.ts:480-501` (legacy write)
- Test: `src/routes/readingStats.plan.test.ts` (extend) or new `src/routes/sync.legacyCaps.test.ts`

**Interfaces:**
- Consumes: `MAX_SECONDS_PER_SESSION = 86_400`, `MAX_WORDS_PER_SESSION = 1_000_000` from `contracts.ts:19-20`; Task 1's bounded ts.
- Produces: legacy pushes without `syncVersion` enforcing the same per-field bounds as v2 (finite safe integers, `seconds <= 7200`, `words <= 1_000_000`, `progressPercent 0..100` — exact cap values locked in this task).

- [ ] **Step 1: Write the failing test**

```ts
it('caps legacy v1 session seconds and words like v2', async () => {
  const res = await postLegacyPush([{ clientSessionId: 'x', seconds: 2000000000, words: 999999999 }]);
  expect(res.status).toBe(400);
});
it('caps legacy batch at 500 sessions', async () => {
  expect(await postLegacyPush(mkSessions(501))).toMatchObject({ status: 400 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/sync.legacyCaps.test.ts`
Expected: FAIL (legacy currently stores unbounded values, allows 5000 rows).

- [ ] **Step 3: Implement strict legacy session validation in `src/routes/sync.ts:77-92`**

Replace the loose `z.number().optional()` fields with bounded finite-integer schemas mirroring v2; cap the array at 500. Reuse the contract constants, do not invent new ones.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/sync.legacyCaps.test.ts src/routes/readingStats.plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/sync.ts src/routes/sync.legacyCaps.test.ts
git commit -m "fix: cap legacy v1 session writes to v2 bounds"
```

### Task 3: Per-session cap + per-day budget + server-derived day

**Files:**
- Modify: `src/features/readingSync/contracts.ts:19,68` (per-session cap constant)
- Modify: `src/features/readingSync/freeStore.ts:220-326` (`storeFreeSessions`)
- Modify: `src/features/readingSync/proStore.ts:64-153` (`storeProSessions`)
- Modify: `src/features/readingSync/calculations.ts:485-487,761-796` (aggregate clamp)
- Test: `src/features/readingSync/freeStore.dayBudget.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's validated `ts`; `readingSessions` table.
- Produces: `MAX_SESSION_SECONDS = 7200`; per-user/day budget `MAX_DAY_SECONDS = 57600` (16h) enforced at write (reject or clamp the excess — decision locked in this task, one behavior only) and mirrored in `calculateProStats`/`loadFreeStatsForUser` aggregates; `readDay`/`minuteOfDay` derived from validated `ts`, client values ignored or required-equal.

- [ ] **Step 1: Write the failing test**

```ts
it('clamps a 500x86400s push to the daily budget', async () => {
  const totals = await pushAndTotals(mkSessions(500, { seconds: 86400 }));
  expect(totals.totalSecondsRead).toBeLessThanOrEqual(57600);
});
it('derives readDay from ts, ignoring client readDay', async () => {
  await pushPro({ ...goodPro(), ts: FIXED_TS, readDay: '1999-01-01' });
  expect(storedReadDay()).toBe('2026-10-22');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/readingSync/freeStore.dayBudget.test.ts`
Expected: FAIL (currently sums 43.2M seconds, stores client readDay verbatim).

- [ ] **Step 3: Implement `MAX_SESSION_SECONDS`, `MAX_DAY_SECONDS`, and server-derived day in `freeStore.ts` / `proStore.ts` / `calculations.ts`**

Cap per-session seconds, enforce the daily budget per `(userId, readDay)` at write, derive day/hour from `ts`. Mirror the clamp in the SQL/JS aggregates so reads and writes cannot drift.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/readingSync/freeStore.dayBudget.test.ts src/routes/readingStats.plan.test.ts src/features/readingSync/calculations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/readingSync/contracts.ts src/features/readingSync/freeStore.ts src/features/readingSync/proStore.ts src/features/readingSync/calculations.ts src/features/readingSync/freeStore.dayBudget.test.ts
git commit -m "fix: enforce session cap and daily reading budget"
```

### Task 4: Completion integrity

**Files:**
- Modify: `src/features/readingSync/contracts.ts:118-135` (`withCompletionConsistency`)
- Modify: `src/routes/chapters.ts` (chapter-existence lookup helper) or `src/features/readingSync/freeStore.ts` (write gate)
- Modify: `src/features/readingSync/leaderboardStore.ts:51-53` (completion filter)
- Test: `src/features/readingSync/completionIntegrity.test.ts` (new)

**Interfaces:**
- Consumes: `COMPLETION_THRESHOLD`, Task 3's daily budget, `chapters` table.
- Produces: completions require `seconds > 0`; `(novelId, chapterId)` validated against published chapters where known (external-source rule: cap distinct completions per day, exact value locked here, suggested 50); leaderboard counts only gated completions.

- [ ] **Step 1: Write the failing test**

```ts
it('rejects zero-second completions', async () => {
  expect(await push({ seconds: 0, progressPercent: 100, completed: true })).toBe(400);
});
it('ignores completions for unknown chapters on the leaderboard', async () => {
  await push({ novelId: 'fake', chapterId: 999999, seconds: 60, progressPercent: 100, completed: true });
  expect(await leaderboard()).not.toContain('fake');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/readingSync/completionIntegrity.test.ts`
Expected: FAIL (zero-second completions currently accepted and ranked).

- [ ] **Step 3: Implement the completion gate in `contracts.ts` + store/leaderboard filter**

Add `seconds > 0` to the consistency rule; gate unknown `(novelId, chapterId)` pairs at write or at leaderboard read (one place, not both).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/readingSync/completionIntegrity.test.ts src/routes/stats.leaderboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/readingSync/contracts.ts src/features/readingSync/leaderboardStore.ts src/features/readingSync/completionIntegrity.test.ts
git commit -m "fix: require positive seconds and known chapters for completions"
```

### Task 5: Proxy-safe client identity + per-user rate limit

**Files:**
- Modify: `src/middleware/rateLimit.ts:31-34`
- Modify: `src/routes/chapters.ts:443-449` (`resolveViewerKey`)
- Modify: `src/app.ts:41-55` (per-user limiter wiring)
- Test: `src/middleware/rateLimit.test.ts` (new or extend `src/app.rateLimit.test.ts`)

**Interfaces:**
- Consumes: `CF-Connecting-IP` header on Workers, `getEnv()` proxy config on Node; JWT `sub` via `verifySubject`.
- Produces: `clientIp(c): string` preferring `CF-Connecting-IP`, then configured trusted-proxy XFF, else `local`; rate-limit key `sub:<userId>` when authed, else `ip:<ip>:<path>`; existing 60/min budgets unchanged.

- [ ] **Step 1: Write the failing test**

```ts
it('ignores spoofed XFF when CF-Connecting-IP is present', async () => {
  const res = await hitWith({ 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '9.9.9.9' });
  expect(rateKeyFor(res)).toContain('9.9.9.9');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/middleware/rateLimit.test.ts`
Expected: FAIL (currently trusts first XFF entry).

- [ ] **Step 3: Implement `clientIp()` and per-user keys in `rateLimit.ts` + `resolveViewerKey`**

One helper, used by both the limiter and the view dedup. No behavior change to budgets or windows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/middleware/rateLimit.test.ts src/app.rateLimit.test.ts src/routes/chapters.views.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/rateLimit.ts src/routes/chapters.ts src/app.ts src/middleware/rateLimit.test.ts
git commit -m "fix: trust proxy-safe client IP and key limits per user"
```

### Task 6: Decouple view counts from novel freshness

**Files:**
- Modify: `src/routes/chapters.ts:489-493` (view CTE)
- Modify: `src/database/schema.ts:102-103` (add `lastViewedAt` nullable, no default)
- Create: `drizzle/0022_novel_last_viewed.sql`
- Test: `src/routes/chapters.views.test.ts` (extend)

**Interfaces:**
- Consumes: existing 12-hour dedup CTE.
- Produces: view CTE sets `last_viewed_at = now()`, never touches `novels.updated_at`; `GET /novels` `latest` sort unchanged (still `updatedAt`).

- [ ] **Step 1: Write the failing test**

```ts
it('counted view does not bump novels.updated_at', async () => {
  const before = await novelUpdatedAt();
  await postView({ readSeconds: 20 });
  expect(await novelUpdatedAt()).toBe(before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/chapters.views.test.ts`
Expected: FAIL (`updated_at` currently moves on every counted view).

- [ ] **Step 3: Implement CTE change + `last_viewed_at` migration in `chapters.ts` / `schema.ts` / `drizzle/0022_novel_last_viewed.sql`**

Catalog-only migration (nullable, no default, no rewrite). Run `npm run db:generate` if the repo flow requires it, then verify `npm run db:check`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/chapters.views.test.ts && npm run typecheck && npm run db:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/chapters.ts src/database/schema.ts drizzle/0022_novel_last_viewed.sql src/routes/chapters.views.test.ts
git commit -m "fix: stop bumping novels.updated_at on view counts"
```

### Task 7: Pro stats aggregation + retention

**Files:**
- Modify: `src/features/readingSync/proStore.ts:273-305` (`loadProStats`)
- Create: `drizzle/0023_reading_retention.sql` (retention index/job hook; exact mechanism locked here)
- Test: `src/features/readingSync/proStore.retention.test.ts` (new, postgres-gated like `leaderboardStore.postgres.test.ts`)

**Interfaces:**
- Consumes: Task 3's budget-clamped rows.
- Produces: `loadProStats` aggregated in SQL (no full-row scan); rows older than the retention window (suggested 365 days, locked here) roll up or delete via the scheduled job; `calculateProStats` pure function unchanged.

- [ ] **Step 1: Write the failing test**

```ts
it('loads pro totals without scanning all rows', async () => {
  await seedSessions(2000);
  expect(queryCount(() => loadProStats(user))).toBeLessThanOrEqual(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/readingSync/proStore.retention.test.ts`
Expected: FAIL (currently `select()`s every row).

- [ ] **Step 3: Implement SQL aggregation in `proStore.ts:273-305` mirroring `loadFreeStatsForUser`**

Two aggregates (`totalSeconds`, `completedChapters`-equivalent + day/hour rollups); keep the calculation boundary identical so SQL and `calculations.ts` cannot drift.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/readingSync/proStore.retention.test.ts src/routes/readingStats.plan.postgres.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/readingSync/proStore.ts drizzle/0023_reading_retention.sql src/features/readingSync/proStore.retention.test.ts
git commit -m "perf: aggregate pro stats in SQL with retention"
```

### Task 8: Close the latent gates (SYNC_OPEN default + unlock evaluation note)

**Files:**
- Modify: `src/config/env.ts:82`
- Test: `src/config/env.test.ts` (extend)

**Interfaces:**
- Consumes: `DATABASE_URL`, `NODE_ENV`.
- Produces: `syncOpen` defaults to `false` whenever `DATABASE_URL` is set unless `SYNC_OPEN=true` is explicit; achievement unlocks stay client-evaluated and cosmetic (no reward path added in this plan — server-side verification is a precondition for any future reward task, stated here so no later task assumes otherwise).

- [ ] **Step 1: Write the failing test**

```ts
it('defaults syncOpen to false with a real database and no explicit flag', () => {
  expect(envWith({ DATABASE_URL: 'postgres://x', SYNC_OPEN: undefined }).syncOpen).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL (currently defaults to `true`).

- [ ] **Step 3: Implement fail-closed default in `src/config/env.ts:82`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/config/env.test.ts src/routes/sync.identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "fix: default SYNC_OPEN to closed with a real database"
```


**Files:**
- Modify: `src/features/readingSync/proStore.ts:273-305` (`loadProStats`)
- Create: `drizzle/0023_reading_retention.sql` (retention index/job hook; exact mechanism locked here)
- Test: `src/features/readingSync/proStore.retention.test.ts` (new, postgres-gated like `leaderboardStore.postgres.test.ts`)

**Interfaces:**
- Consumes: Task 3's budget-clamped rows.
- Produces: `loadProStats` aggregated in SQL (no full-row scan); rows older than the retention window (suggested 365 days, locked here) roll up or delete via the scheduled job; `calculateProStats` pure function unchanged.

- [ ] **Step 1: Write the failing test**

```ts
it('loads pro totals without scanning all rows', async () => {
  await seedSessions(2000);
  expect(queryCount(() => loadProStats(user))).toBeLessThanOrEqual(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/readingSync/proStore.retention.test.ts`
Expected: FAIL (currently `select()`s every row).

- [ ] **Step 3: Implement SQL aggregation in `proStore.ts:273-305` mirroring `loadFreeStatsForUser`**

Two aggregates (`totalSeconds`, `completedChapters`-equivalent + day/hour rollups); keep the calculation boundary identical so SQL and `calculations.ts` cannot drift.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/readingSync/proStore.retention.test.ts src/routes/readingStats.plan.postgres.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/readingSync/proStore.ts drizzle/0023_reading_retention.sql src/features/readingSync/proStore.retention.test.ts
git commit -m "perf: aggregate pro stats in SQL with retention"
```
