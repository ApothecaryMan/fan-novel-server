# Global Readers Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public global readers leaderboard: server aggregates completed chapters per user across all devices, app displays it in the rank view with device-local fallback when offline.

**Architecture:** New `statsRouter` on the server with one public `GET /api/v1/stats/leaderboard` backed by a single `GROUP BY user_id` query plus a partial index on `reading_sessions(read_day)`; app adds `ApiService.getLeaderboard` + `useGlobalLeaderboard` (TanStack React Query) and the rank view prefers server data, falling back to `useDeviceLeaderboard` on error/offline. UI component `ReadersLeaderboard` stays presentational.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (server), Expo React Native + TanStack React Query + expo-sqlite (app), vitest both sides.

**Spec:** `GET /api/v1/stats/leaderboard?period=week|month|all&limit=10` (limit default 10, max 50). Rank key = `COUNT(DISTINCT (novel_id, chapter_id))` where completion boundary holds: `completion_signal_present AND progress_percent >= 85 AND trim(novel_id) <> '' AND chapter_id > 0`. Windows reuse server convention (`activityTierWindow` UTC today-6d for week; month = UTC today-29d; all = unbounded). Response entries: `{ user: toPublic projection (id, name, username, avatarUrl — email never), chapters, trend }` where `trend = current window count minus previous equal-length window count` (`all` trend = 0). Public, no auth guard, `Cache-Control: public, max-age=60, stale-while-revalidate=60`, rate-limited like other public reads.

## Global Constraints

- Server is `fan-novel-server` (Hono + Drizzle + PG); app is `Fan Novel` (Expo). Do not mix changes in one commit; one task = one repo.
- Completion boundary is exactly `completion_signal_present AND progress_percent >= 85 AND trim(novel_id) <> '' AND chapter_id > 0` (`COMPLETION_THRESHOLD=85` in contracts).
- Public user projection is `toPublic` in `src/domain/accountProjection.ts` — email never leaves the server.
- Migration flow: edit `src/database/schema.ts` → `npm run db:generate` → `npm run db:migrate`; latest is `0020_economy_ledger.sql`; `migrationIntegrity.test.ts` must stay green.
- App rank view keeps `Period = week | month | all` and `Reader` shape; offline/error falls back to device-local board, never a blank screen.

## Review Focus

- `limit=0`, `limit=999`, unknown `period` — expect 400 on bad period, clamped limit, never a full-table dump.
- A user with sessions but zero completed chapters — expect excluded from rows (or zero-count row sorted last), never ranked above a real reader.
- Two readers tie on chapters — expect deterministic tiebreak (e.g. `user_id ASC`), stable order across pages.
- `read_day` is device-local `YYYY-MM-DD` while server windows use UTC days — expect the plan's window helper documented as UTC-day convention matching `activityTierWindow`, same as profile `activityTier`.
- Offline app open — expect device-local board renders, server error swallowed, no crash and no stuck loader.

---

### Task 1: Server partial index migration

**Files:**
- Modify: `fan-novel-server/src/database/schema.ts:156-178`
- Create: `fan-novel-server/drizzle/0021_leaderboard_window.sql` (via `db:generate`)
- Test: existing `fan-novel-server/src/database/migrationIntegrity.test.ts`

**Interfaces:**
- Consumes: `reading_sessions` table definition
- Produces: index `leaderboard_read_day_idx ON reading_sessions (read_day, user_id) WHERE completion_signal_present AND progress_percent >= 85` (partial, keeps the global `GROUP BY user_id` off a seq scan)

- [ ] **Step 1: Add the partial index to `reading_sessions` in `src/database/schema.ts`**

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: new `drizzle/0021_*.sql` containing `CREATE INDEX ... WHERE ...`

- [ ] **Step 3: Run migration integrity + related tests**

Run: `npx vitest run src/database/migrationIntegrity.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/database/schema.ts drizzle/0021_*.sql drizzle/meta/_journal.json
git commit -m "feat: add leaderboard window index"
```

### Task 2: Server leaderboard query

**Files:**
- Create: `fan-novel-server/src/features/readingSync/leaderboardStore.ts`
- Test: `fan-novel-server/src/features/readingSync/leaderboardStore.postgres.test.ts`

**Interfaces:**
- Consumes: `db` drizzle client, `reading_sessions`, `users`, `toPublic` from `src/domain/accountProjection.ts`, window helper in the same file `leaderboardWindow(period: 'week'|'month'|'all') -> { from: string|null, prevFrom: string|null, prevTo: string|null }`
- Produces: `loadLeaderboard(period, limit) -> Promise<Array<{ user: PublicUser, chapters: number, trend: number }>>` ordered chapters DESC, tiebreak user id ASC. Single round trip: one `GROUP BY user_id` with two `COUNT(DISTINCT (novel_id, chapter_id)) FILTER (WHERE ...)` aggregates (current + previous window); trend computed in code (`all` trend 0, previous query skipped). Every expression column gets an explicit `AS` alias — unnamed duplicate aggregates collapse in some drivers' row mapping.

- [ ] **Step 1: Write the failing test**

```ts
it('ranks users by distinct completed chapters in the window', async () => {
  const rows = await loadLeaderboard('week', 10);
  expect(rows[0].chapters).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/readingSync/leaderboardStore.postgres.test.ts`
Expected: FAIL with "loadLeaderboard is not defined"

- [ ] **Step 3: Implement `loadLeaderboard` in `src/features/readingSync/leaderboardStore.ts`**

One `GROUP BY user_id` + `JOIN users` with `FILTER` aggregates for both windows (not two round trips); join trend = current − previous in code.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/readingSync/leaderboardStore.postgres.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/readingSync/leaderboardStore.ts src/features/readingSync/leaderboardStore.postgres.test.ts
git commit -m "feat: add global leaderboard query"
```

### Task 3: Server public route

**Files:**
- Create: `fan-novel-server/src/routes/stats.ts`
- Modify: `fan-novel-server/src/app.ts:132-149` (register `app.route('/api/v1/stats', statsRouter)` + rate limit + endpoint list `:151-184`)
- Test: `fan-novel-server/src/routes/stats.leaderboard.test.ts` (mocked-DB unit in the `novels.rank.test.ts` / `profile.test.ts` style) + extend postgres test for HTTP shape

**Interfaces:**
- Consumes: `loadLeaderboard` from Task 2
- Produces: `GET /api/v1/stats/leaderboard?period&limit -> { success: true, data: [{ user, chapters, trend }], period, limit }`; 400 on unknown period; `Cache-Control: public, max-age=60, stale-while-revalidate=60`

- [ ] **Step 1: Write the failing route test**

```ts
it('returns 400 for an unknown period', async () => {
  const res = await app.request('/api/v1/stats/leaderboard?period=year');
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/stats.leaderboard.test.ts`
Expected: FAIL (router/route missing)

- [ ] **Step 3: Implement `statsRouter` + registration in `src/app.ts`**

No auth guard (public like `/:id/profile`); zod `period` enum + clamped limit; DB-unavailable fallback returns `{ success: true, data: [], period, limit }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/stats.leaderboard.test.ts src/features/readingSync/leaderboardStore.postgres.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/stats.ts src/routes/stats.leaderboard.test.ts src/app.ts
git commit -m "feat: add public leaderboard endpoint"
```

### Task 4: App server-backed hook + rank view wiring

**Files:**
- Modify: `Fan Novel/src/services/api.ts` (add `ApiService.getLeaderboard(period, limit)`)
- Create: `Fan Novel/src/features/stats/useGlobalLeaderboard.ts`
- Modify: `Fan Novel/app/(tabs)/stats.tsx` (prefer server data, fallback device-local)
- Test: `Fan Novel/src/features/stats/useGlobalLeaderboard.test.ts` + `Fan Novel/src/services/api.readingSync.test.ts` extension for the new method

**Interfaces:**
- Consumes: `GET /api/v1/stats/leaderboard` (Task 3), existing `Reader`/`Period` types, `useDeviceLeaderboard` fallback, shared `queryClient` from `src/lib/queryClient.ts`
- Produces: `useGlobalLeaderboard(period: Period) -> { readers: Reader[], loading: boolean, source: 'server' | 'device' }`

- [ ] **Step 1: Write the failing test**

```ts
it('falls back to device readers when the server fails', async () => {
  const { readers, source } = await renderHookOffline();
  expect(source).toBe('device');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/stats/useGlobalLeaderboard.test.ts`
Expected: FAIL with "useGlobalLeaderboard is not defined"

- [ ] **Step 3: Implement `ApiService.getLeaderboard` + `useGlobalLeaderboard`**

`useQuery({ queryKey: ['leaderboard', period], queryFn: () => ApiService.getLeaderboard(period, 10), staleTime: 60_000 })`; on `isError` or empty data return device readers with `source: 'device'`; map server `{user, chapters, trend}` to `Reader` (avatar passthrough).

- [ ] **Step 4: Wire into `app/(tabs)/stats.tsx` rank branch**

Replace `useDeviceLeaderboard` with `useGlobalLeaderboard(rankPeriod)`; keep empty-state card; pass `readers` through unchanged.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/features/stats/useGlobalLeaderboard.test.ts src/features/stats/deviceLeaderboard.test.ts src/repository/statsRepository.leaderboard.test.ts`
Run: `npx tsc --noEmit` (touched files must be clean; pre-existing `M3 Expressive/SubscriptionScreen.tsx` errors are out of scope)
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/api.ts src/features/stats/useGlobalLeaderboard.ts src/features/stats/useGlobalLeaderboard.test.ts "app/(tabs)/stats.tsx"
git commit -m "feat: show global leaderboard with offline fallback"
```
