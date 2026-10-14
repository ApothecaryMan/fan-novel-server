# Stats Sync Cleanup Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a derived-only `StatCard` registry pilot in the app plus continuous cursor pull owned by `progressFlush`, with no new wire/storage fields.

**Architecture:** A pure `statCards.ts` registry beside `statsEngine.ts` holds per-card `derive` + `merge` over sanitized `StatsSessionInput[]`. `statsRepository.fullRefreshForUser` runs the registry on the same sanitized inputs it already builds, the store holds ready values, the screen reads only. A sticky-cursor `advanceCursor` in `restoreRows.ts` plus a bounded-loop `pullIncrementalReading()` in `restore.ts` fetch deltas, and `progressFlush.ts` schedules them on foreground with a dedicated per-owner `PULL_MIN_MS` throttle. Server code is untouched; the pilot card is marked `pro` until its Free aggregate ships.

**Tech Stack:** TypeScript, Expo SQLite (Drizzle), Zustand, Vitest.

**Work location:** All code tasks run in `/home/x1carbon/Projects/Fan Novel` on branch `feat/stats-sync-cleanup` (create it first). This plan file lives in `fan-novel-server` docs; implementation commits land in Fan Novel.

---

## File map

- New: `/home/x1carbon/Projects/Fan Novel/src/features/stats/statCards.ts`
- New: `/home/x1carbon/Projects/Fan Novel/src/features/stats/statCards.test.ts`
- Modify: `/home/x1carbon/Projects/Fan Novel/src/repository/statsRepository.ts` (`fullRefreshForUser` returns `cardValues`)
- Modify: `/home/x1carbon/Projects/Fan Novel/src/store/statsStore.ts` (holds `userCardValues`)
- Modify: `/home/x1carbon/Projects/Fan Novel/app/(tabs)/stats.tsx` (reads ready value, display only)
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/sync/restoreRows.ts` (`advanceCursor` takes current cursor + library page, sticky cursors)
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/sync/restoreRows.test.ts` (update `advanceCursor` tests)
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/sync/restore.ts` (`PullCursor.library`, `readPullCursor`, `pullIncrementalReading`, update old `advanceCursor` call site)
- Modify: `/home/x1carbon/Projects/Fan Novel/src/lib/progressFlush.ts` (`PULL_MIN_MS`, per-owner throttle/in-flight, Pro gate, `recover()` hook)

---

### Task 0: Branch

- [ ] **Step 1: Create the branch**

```bash
git -C "/home/x1carbon/Projects/Fan Novel" checkout -b feat/stats-sync-cleanup
git -C "/home/x1carbon/Projects/Fan Novel" status --short --branch
```
Expected: `## feat/stats-sync-cleanup`, clean tree.

---

### Task 1: StatCard registry skeleton (numbers only, YAGNI)

**Files:**
- Create: `/home/x1carbon/Projects/Fan Novel/src/features/stats/statCards.ts`
- Create: `/home/x1carbon/Projects/Fan Novel/src/features/stats/statCards.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// /home/x1carbon/Projects/Fan Novel/src/features/stats/statCards.test.ts
import { describe, expect, it } from 'vitest';
import { getStatCards, registerStatCard } from './statCards';

describe('statCards registry', () => {
  it('returns registered cards in registration order', () => {
    registerStatCard({
      key: 'test-card',
      plan: 'pro',
      derive: () => 1,
      merge: (local: number) => local,
    });
    expect(getStatCards().some((c) => c.key === 'test-card')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/stats/statCards.test.ts` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: FAIL with "Cannot find module './statCards'"

- [ ] **Step 3: Write minimal implementation**

```ts
// /home/x1carbon/Projects/Fan Novel/src/features/stats/statCards.ts
import type { StatsSessionInput } from './statsEngine';

export type StatPlan = 'free' | 'pro';

export interface StatCardDef {
  key: string;
  plan: StatPlan;
  /** Pure derivation over SANITIZED engine inputs (gate inherited, signals kept). */
  derive: (sessions: StatsSessionInput[]) => number;
  /** Server-wins for values that can decrease; max for monotonic-only values. */
  merge: (local: number, server: number | null | undefined) => number;
}

const registry: StatCardDef[] = [];

export function registerStatCard(def: StatCardDef): void {
  if (!registry.some((c) => c.key === def.key)) registry.push(def);
}

export function getStatCards(): ReadonlyArray<StatCardDef> {
  return registry;
}
```

(`statsEngine.ts` has no imports, so the type-only import creates no cycle.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/stats/statCards.test.ts` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git -C "/home/x1carbon/Projects/Fan Novel" add src/features/stats/statCards.ts src/features/stats/statCards.test.ts
git -C "/home/x1carbon/Projects/Fan Novel" commit -m "feat: add stat card registry skeleton"
```

---

### Task 2: Pilot derived card (daily average, Pro-gated)

**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/stats/statCards.ts`
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/stats/statCards.test.ts` (append; no new imports — `describe/expect/it` already imported)

Why `plan: 'pro'`: the server is untouched in this plan, and Free pull returns no rows, so a Free-labeled average would compute from post-install local sessions only and read wrong. Promoting it to Free later means adding the key to server `contracts.ts` `freeStatsShape` + `freeStore.ts` `loadFreeStatsForUser` (total ÷ distinct days).

- [ ] **Step 1: Write the failing tests (append to test file)**

```ts
import { deriveCardValues, deriveDailyAverageMinutes } from './statCards';

describe('deriveDailyAverageMinutes', () => {
  it('divides total minutes by distinct days', () => {
    expect(
      deriveDailyAverageMinutes([
        { seconds: 3600, readDay: '2026-10-01' },
        { seconds: 1800, readDay: '2026-10-01' },
        { seconds: 1800, readDay: '2026-10-02' },
      ] as never),
    ).toBeCloseTo(60, 5);
  });

  it('returns 0 for no sessions', () => {
    expect(deriveDailyAverageMinutes([])).toBe(0);
  });
});

describe('deriveCardValues', () => {
  it('runs every registered card and keys results by card key', () => {
    const values = deriveCardValues([{ seconds: 60, readDay: '2026-10-01' }] as never);
    expect(values.dailyAverageMinutes).toBeCloseTo(60, 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/stats/statCards.test.ts` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: FAIL with "deriveDailyAverageMinutes is not exported" (import of a missing module member fails the file)

- [ ] **Step 3: Write minimal implementation (append to statCards.ts)**

```ts
export function deriveDailyAverageMinutes(sessions: StatsSessionInput[]): number {
  if (sessions.length === 0) return 0;
  let totalSeconds = 0;
  const days = new Set<string>();
  for (const s of sessions) {
    totalSeconds += Math.max(0, s.seconds || 0);
    if (s.readDay) days.add(s.readDay);
  }
  return totalSeconds / 60 / Math.max(1, days.size);
}

// Server is the authority for values that can decrease (averages, streaks):
// max would pin a stale high value, so server-wins.
export const serverWinsMerge = (local: number, server: number | null | undefined): number =>
  server ?? local;

export function deriveCardValues(sessions: StatsSessionInput[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const card of getStatCards()) {
    try {
      out[card.key] = card.derive(sessions);
    } catch {
      // One bad card must never break the stats pipeline.
      out[card.key] = 0;
    }
  }
  return out;
}

registerStatCard({
  key: 'dailyAverageMinutes',
  plan: 'pro',
  derive: deriveDailyAverageMinutes,
  merge: serverWinsMerge,
});
```

Note: `merge` is registered but has no consumer in this plan (no server value exists for the new key yet). It is the contract the future pull-merge will honor — see Task 6 follow-up, not this plan.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/stats/statCards.test.ts` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git -C "/home/x1carbon/Projects/Fan Novel" add src/features/stats/statCards.ts src/features/stats/statCards.test.ts
git -C "/home/x1carbon/Projects/Fan Novel" commit -m "feat: add daily-average pilot stat card"
```

---

### Task 3: Compute in pipeline, screen reads ready value

**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/src/repository/statsRepository.ts`
- Test: `/home/x1carbon/Projects/Fan Novel/src/repository/statsRepository.test.ts` (append)
- Modify: `/home/x1carbon/Projects/Fan Novel/src/store/statsStore.ts`
- Modify: `/home/x1carbon/Projects/Fan Novel/app/(tabs)/stats.tsx`

The screen must never derive from view sessions (`ChapterReadingSession` drops `progress`/`completed`, and raw rows would bypass the write-time gate). `fullRefreshForUser` already maps rows through `rowToInput` (sanitized shape); the registry runs on that same array.

- [ ] **Step 1: Write the failing test (append to statsRepository.test.ts)**

```ts
describe('stat card values', () => {
  it('derives daily average from the same sanitized inputs as the summary', () => {
    const day = 86_400_000;
    const base = 1_782_470_400_000;
    insertSession({ clientSessionId: 'avg-1', seconds: 120, ts: base });
    insertSession({ clientSessionId: 'avg-2', seconds: 60, ts: base + day });
    const { cardValues } = statsRepository.fullRefreshForUser('owner-a');
    expect(cardValues.dailyAverageMinutes).toBeCloseTo((120 + 60) / 60 / 2, 5);
  });
});
```

(`insertSession` helper with `progressPercent: 91, completed: true` already exists in that file. Two timestamps exactly 24h apart always land on different local calendar days in any timezone.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/repository/statsRepository.test.ts -t "stat card values"` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: FAIL — `cardValues` is undefined (`undefined.dailyAverageMinutes` throws)

- [ ] **Step 3: Write minimal implementation**

In `statsRepository.ts`, add the import beside the other feature imports:

```ts
import { deriveCardValues } from '../features/stats/statCards';
```

Replace `fullRefreshForUser` (currently returns `{ summary, sessions }`):

```ts
fullRefreshForUser(userId: string): {
  summary: ReadingStatsSummary;
  sessions: ChapterReadingSession[];
  cardValues: Record<string, number>;
} {
  const rows = db
    .select()
    .from(readingSessions)
    .where(eq(readingSessions.userId, userId))
    .all();
  const inputs = rows.map(rowToInput);
  return {
    summary: fromSessions(inputs),
    sessions: rows.map(rowToView),
    cardValues: deriveCardValues(inputs),
  };
},
```

In `statsStore.ts`: add `userCardValues: Record<string, Record<string, number>>;` to `MultiUserStatsState`, init `userCardValues: {},` in the store, and in `refreshFromRepository` destructure `cardValues` and set it:

```ts
const { summary, sessions, cardValues } = statsRepository.fullRefreshForUser(uid);
```

```ts
set((state) => ({
  userSummaries: { ...state.userSummaries, [uid]: merged },
  userSessions: { ...state.userSessions, [uid]: sessions },
  userCardValues: { ...state.userCardValues, [uid]: cardValues },
}));
```

In `resetStats`'s set callback, drop the owner's entry alongside snapshots:

```ts
const userCardValues = { ...state.userCardValues };
delete userCardValues[uid];
```
(use `userCardValues` in the returned partial next to the snapshot entries.)

In `stats.tsx`, after the `topNovels` line:

```tsx
const dailyAverageMinutes = useStatsStore((s) => s.userCardValues[activeUserId]?.dailyAverageMinutes ?? 0);
```

Render a read-only card in `metricsGrid` right after the Total Time `M3Card`:

```tsx
<M3Card variant="low" style={styles.metricCard}>
  <Clock size={22} color={colors.primary} />
  <Text style={[styles.metricValue, { color: colors.onBackground }]}>{Math.round(dailyAverageMinutes)}</Text>
  <Text style={[styles.metricTitle, { color: colors.outline }]}>
    {language === 'en' ? 'Daily average (min)' : 'المتوسط اليومي (دقيقة)'}
  </Text>
</M3Card>
```

(No new i18n keys — inline bilingual label like surrounding code avoids a strings change.)

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/repository/statsRepository.test.ts src/features/stats/statCards.test.ts` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: PASS

Run: `npx tsc --noEmit -p tsconfig.json` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: PASS, no errors in `stats.tsx` / `statsStore.ts` / `statsRepository.ts`

- [ ] **Step 5: Commit**

```bash
git -C "/home/x1carbon/Projects/Fan Novel" add src/repository/statsRepository.ts src/repository/statsRepository.test.ts src/store/statsStore.ts "app/(tabs)/stats.tsx"
git -C "/home/x1carbon/Projects/Fan Novel" commit -m "feat: compute stat cards in refresh pipeline"
```

---

### Task 4: Sticky cursors (sessions + library)

**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/sync/restoreRows.ts`
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/sync/restoreRows.test.ts` (update the two `advanceCursor` tests, add library tests)
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/sync/restore.ts` (`PullCursor.library`, `readPullCursor`, old call site)

Why: sending `libraryCursor: null` every foreground re-fetches the library from the start, and the old `advanceCursor` dropped every cursor field except `sessions`. Sticky rule: an exhausted page (`null`) keeps the last known cursor, so the next pull resumes after it instead of re-scanning; only the first-ever pull sends `null`.

- [ ] **Step 1: Update the failing tests (replace the `advanceCursor` describe)**

```ts
describe('advanceCursor', () => {
  it('reports more while any page still has a cursor', () => {
    expect(advanceCursor(null, { sessionsNext: 's1' }).more).toBe(true);
    expect(advanceCursor(null, { sessionsNext: null, libraryNext: 'l1' }).more).toBe(true);
  });

  it('reports done once every page is exhausted', () => {
    expect(advanceCursor(null, { sessionsNext: null }).more).toBe(false);
  });

  it('keeps the last known cursor when a page exhausts instead of resetting to null', () => {
    const { cursor } = advanceCursor({ sessions: 's9', library: 'l4' }, { sessionsNext: null });
    expect(cursor.sessions).toBe('s9');
    expect(cursor.library).toBe('l4');
  });

  it('preserves unrelated cursor fields', () => {
    const { cursor } = advanceCursor(
      { sessions: 's1', freeDone: true, serverTotalSecondsRead: 60 },
      { sessionsNext: 's2' },
    );
    expect(cursor.sessions).toBe('s2');
    expect(cursor.freeDone).toBe(true);
    expect(cursor.serverTotalSecondsRead).toBe(60);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/sync/restoreRows.test.ts -t "advanceCursor"` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: FAIL — `advanceCursor` takes 1 argument / `sessions` access on wrong shape

- [ ] **Step 3: Write minimal implementation**

In `restoreRows.ts`, replace `advanceCursor`:

```ts
/** Next cursor after a page, plus whether anything remains unread. */
export function advanceCursor(
  current: PullCursor | null,
  page: { sessionsNext: string | null; libraryNext?: string | null },
): { cursor: PullCursor; more: boolean } {
  return {
    cursor: {
      ...(current ?? {}),
      // Sticky: an exhausted page (null) keeps the last known position so the
      // next pull resumes after it. Only a first-ever pull sends null.
      sessions: page.sessionsNext ?? current?.sessions ?? null,
      library: page.libraryNext ?? current?.library ?? null,
    },
    more: Boolean(page.sessionsNext) || Boolean(page.libraryNext),
  };
}
```

In `restore.ts`: add `library` to the cursor type and reader:

```ts
export interface PullCursor {
  sessions: string | null;
  library?: string | null;
  freeDone?: boolean;
  complete?: boolean;
  serverTotalSecondsRead?: number;
}
```

```ts
return {
  sessions: parsed.sessions ?? null,
  ...(parsed.library != null ? { library: parsed.library } : {}),
  ...(parsed.freeDone ? { freeDone: true } : {}),
  ...(parsed.complete ? { complete: true } : {}),
  ...(parsed.serverTotalSecondsRead != null
    ? { serverTotalSecondsRead: parsed.serverTotalSecondsRead }
    : {}),
};
```

Update the existing call site in `restoreFromServer` (the `advanceCursor({ sessionsNext: sessionPage.nextCursor })` line):

```ts
const advanced = advanceCursor(cursor, { sessionsNext: sessionPage.nextCursor });
```

(`cursor` is already in scope there; library stays as stored, sessions behave exactly as before on first pull.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/sync/restoreRows.test.ts src/features/sync/restore.test.ts` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: PASS (existing restore behavior preserved)

- [ ] **Step 5: Commit**

```bash
git -C "/home/x1carbon/Projects/Fan Novel" add src/features/sync/restoreRows.ts src/features/sync/restoreRows.test.ts src/features/sync/restore.ts
git -C "/home/x1carbon/Projects/Fan Novel" commit -m "feat: sticky session and library pull cursors"
```

---

### Task 5: Bounded incremental pull with behavior tests

**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/sync/restore.ts`
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/sync/restore.test.ts` (append; harness with mocked db + AsyncStorage + `stubApi` already exists)

Design: loop up to 5 pages per call (a device many pages behind catches up over successive foregrounds instead of one page per minute). Library rows are tracked but not applied — same as `restoreFromServer` today; library restore stays out of scope. `deviceId: 'restore'` matches the existing restore literal. A 409 `plan_changed` propagates to the caller (same as restore today).

- [ ] **Step 1: Write the failing tests (append to restore.test.ts)**

```ts
describe('pullIncrementalReading', () => {
  it('is exported', async () => {
    const mod = await import('./restore');
    expect(typeof mod.pullIncrementalReading).toBe('function');
  });

  it('aborts before any network or write when authorization is already lost', async () => {
    const { pullIncrementalReading } = await import('./restore');
    const api = stubApi(proResponse());
    const outcome = await pullIncrementalReading(api, {
      userId: 'user-1',
      isAuthorized: () => false,
    });
    expect(outcome).toEqual({ sessions: 0, more: true, aborted: true });
    expect(api.pullReadingSync).not.toHaveBeenCalled();
    expect(harness.inserts).toHaveLength(0);
  });

  it('advances the cursor only for pages actually written, then reports aborted', async () => {
    const { pullIncrementalReading } = await import('./restore');
    let authorized = true;
    const page1 = proResponse({ sessions: { rows: proResponse().sessions.rows, nextCursor: 's1' } });
    const api = {
      pullReadingSync: vi.fn(async () => {
        authorized = false; // auth is lost mid-pull, right after page 1 is served
        return page1;
      }),
    };
    const outcome = await pullIncrementalReading(api, {
      userId: 'user-1',
      isAuthorized: () => authorized,
    });
    expect(api.pullReadingSync).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ sessions: 1, more: true, aborted: true });
    const stored = JSON.parse(harness.storage.get(CURSOR_KEY) as string);
    expect(stored.sessions).toBe('s1');
  });

  it('marks freeDone and writes nothing on a Free answer', async () => {
    const { pullIncrementalReading } = await import('./restore');
    const api = stubApi(freeResponse());
    const outcome = await pullIncrementalReading(api, { userId: 'user-1' });
    expect(outcome).toEqual({ sessions: 0, more: false, aborted: false });
    expect(harness.inserts).toHaveLength(0);
    expect(JSON.parse(harness.storage.get(CURSOR_KEY) as string).freeDone).toBe(true);
  });

  it('pages until exhausted within the bound', async () => {
    const { pullIncrementalReading } = await import('./restore');
    const page1 = proResponse({ sessions: { rows: proResponse().sessions.rows, nextCursor: 's1' } });
    const page2 = proResponse();
    const api = { pullReadingSync: vi.fn(async () => page1).mockResolvedValueOnce(page1).mockResolvedValueOnce(page2) };
    const outcome = await pullIncrementalReading(api, { userId: 'user-1' });
    expect(api.pullReadingSync).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ sessions: 2, more: false, aborted: false });
  });
});
```

(`proResponse`, `freeResponse`, `stubApi`, `harness`, `CURSOR_KEY` already exist in that file. `beforeEach` clears storage — confirm it also resets `isAuthorized`-style locals per test by declaring them inside each test as above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/sync/restore.test.ts -t "pullIncrementalReading"` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: FAIL with "pullIncrementalReading is not exported" (dynamic import of missing export is undefined)

- [ ] **Step 3: Write minimal implementation (append to restore.ts)**

```ts
export const MAX_INCREMENTAL_PAGES = 5;

export interface IncrementalPullOutcome {
  sessions: number;
  more: boolean;
  aborted: boolean;
}

/**
 * Steady-state delta pull. Unlike restoreFromServer it runs even when the
 * cursor says complete: sticky cursors resume after the last seen position.
 * Library position is tracked but rows are not applied (same as restore).
 * A 409 plan_changed propagates — a stale entitlement must surface.
 */
export async function pullIncrementalReading(
  api: Pick<typeof ApiService, 'pullReadingSync'>,
  input: {
    userId: string;
    isAuthorized?: () => boolean;
  },
): Promise<IncrementalPullOutcome> {
  const { userId } = input;
  const authorized = (): boolean => (input.isAuthorized ? input.isAuthorized() : true);
  const aborted = (sessions: number): IncrementalPullOutcome => ({ sessions, more: true, aborted: true });

  if (!authorized()) return aborted(0);
  let cursor = await readPullCursor(userId);
  if (!authorized()) return aborted(0);

  let sessions = 0;
  for (let i = 0; i < MAX_INCREMENTAL_PAGES; i += 1) {
    if (!authorized()) return aborted(sessions);
    const response = await api.pullReadingSync({
      syncVersion: 2,
      user: { externalId: userId },
      deviceId: 'restore',
      readingStats: {
        libraryCursor: cursor.library ?? null,
        sessionCursor: cursor.sessions,
        year: new Date().getUTCFullYear(),
      },
    });
    if (!authorized()) return aborted(sessions);

    const snapshotTotal = response.stats ? snapshotSeconds(response.stats.totalSecondsRead) : null;
    if (snapshotTotal != null) {
      await writeServerTotal(userId, snapshotTotal);
    }
    if (response.plan === 'free') {
      await writePullCursor(userId, { ...cursor, freeDone: true });
      return { sessions, more: false, aborted: false };
    }

    const pro = response as ProReadingSyncPullResponse;
    const sessionPage = safePage(pro.sessions);
    const libraryPage = safePage(pro.library);
    sessions += applySessions(userId, sessionPage.rows);
    const advanced = advanceCursor(cursor, {
      sessionsNext: sessionPage.nextCursor,
      libraryNext: libraryPage.nextCursor,
    });
    cursor = advanced.cursor;
    await writePullCursor(userId, cursor);
    if (!advanced.more) return { sessions, more: false, aborted: false };
  }
  return { sessions, more: true, aborted: false };
}
```

(`ApiService` type import, `safePage`, `advanceCursor`, `applySessions`, `writePullCursor`, `writeServerTotal`, `snapshotSeconds`, `ProReadingSyncPullResponse` all already imported in `restore.ts`. No self-import.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/sync/restore.test.ts src/features/sync/restoreRows.test.ts` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C "/home/x1carbon/Projects/Fan Novel" add src/features/sync/restore.ts src/features/sync/restore.test.ts
git -C "/home/x1carbon/Projects/Fan Novel" commit -m "feat: add bounded incremental pull"
```

---

### Task 6: Foreground scheduling owned by progressFlush

**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/src/lib/progressFlush.ts`
- Modify: `/home/x1carbon/Projects/Fan Novel/src/lib/progressFlush.test.ts` (append)

Rules honored: `progressFlush` is the only network-loop owner (`restore.ts` stays a pure page-fetcher); per-owner throttle state (a global would leak one account's throttle into the next); Pro-only (a Free account sent down the Pro pull shape gets 409); serial after push in `recover()` so push and pull never overlap.

- [ ] **Step 1: Write the failing tests (append to progressFlush.test.ts)**

```ts
describe('refreshIncrementalReading', () => {
  const owner = {
    validatedSession: { canonicalId: 'pull-u', epoch: 7, credentialGeneration: 3 },
    currentUser: { id: 'pull-u' },
    sessionEpoch: 7,
    credentialGeneration: 3,
    autoSyncCloud: true,
  };

  it('exports a separate pull throttle constant', async () => {
    const mod = await import('./progressFlush');
    expect(typeof mod.PULL_MIN_MS).toBe('number');
  });

  it('coalesces concurrent calls into one pull', async () => {
    const { refreshIncrementalReading } = await import('./progressFlush');
    Object.assign(harness.state, owner);
    const { useEntitlementStore } = await import('../features/entitlements/entitlementStore');
    useEntitlementStore.getState().setPlan('pro', null);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pull = vi.fn(async () => { await gate; return { sessions: 0, more: false, aborted: false }; });
    const first = refreshIncrementalReading({}, { pull: pull as never });
    const second = refreshIncrementalReading({}, { pull: pull as never });
    release();
    await Promise.all([first, second]);
    expect(pull).toHaveBeenCalledTimes(1);
    useEntitlementStore.getState().clearPlan();
    Object.assign(harness.state, { validatedSession: null, currentUser: null });
  });

  it('throttles the second call within the window and force bypasses it', async () => {
    const { refreshIncrementalReading } = await import('./progressFlush');
    Object.assign(harness.state, { ...owner, currentUser: { id: 'pull-t' }, validatedSession: { canonicalId: 'pull-t', epoch: 7, credentialGeneration: 3 } });
    const { useEntitlementStore } = await import('../features/entitlements/entitlementStore');
    useEntitlementStore.getState().setPlan('pro', null);
    const pull = vi.fn(async () => ({ sessions: 0, more: false, aborted: false }));
    await refreshIncrementalReading({}, { pull: pull as never });
    await refreshIncrementalReading({}, { pull: pull as never });
    expect(pull).toHaveBeenCalledTimes(1);
    await refreshIncrementalReading({ force: true }, { pull: pull as never });
    expect(pull).toHaveBeenCalledTimes(2);
    useEntitlementStore.getState().clearPlan();
    Object.assign(harness.state, { validatedSession: null, currentUser: null });
  });
});
```

(Unique user ids per test isolate the per-owner throttle/in-flight maps. `harness.state` shape already exists in that file; only its fields are overwritten and restored.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/progressFlush.test.ts -t "refreshIncrementalReading"` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: FAIL — `refreshIncrementalReading` is not exported

- [ ] **Step 3: Write minimal implementation**

In `progressFlush.ts`, beside `SERVER_AGGREGATE_MIN_MS`:

```ts
/**
 * Throttle for the foreground delta pull. Separate from
 * SERVER_AGGREGATE_MIN_MS on purpose: the aggregate is display-only, the pull
 * carries rows, and sharing one throttle would delay cross-device rows up to
 * 15 minutes.
 */
export const PULL_MIN_MS = 60 * 1000;
/** Retry quickly while pages remain, so a multi-page backlog drains fast. */
const PULL_SHORT_MS = 10 * 1000;
const nextPullAttemptAt = new Map<string, number>();
const pullInFlight = new Map<string, Promise<void>>();

export interface IncrementalPullDeps {
  pull?: (
    api: unknown,
    input: { userId: string; isAuthorized: () => boolean },
  ) => Promise<{ sessions: number; more: boolean; aborted: boolean }>;
}

export function refreshIncrementalReading(
  options: { force?: boolean } = {},
  deps: IncrementalPullDeps = {},
): Promise<void> {
  const owner = captureValidatedReadingOwner();
  if (!owner) return Promise.resolve();
  // Free pull carries no rows and is already covered by the aggregate
  // throttle; only Pro pages here. A Free-shaped request would 409.
  if (useEntitlementStore.getState().plan !== 'pro') return Promise.resolve();
  const key = owner.userId;
  if (!options.force && Date.now() < (nextPullAttemptAt.get(key) ?? 0)) {
    return Promise.resolve();
  }
  const existing = pullInFlight.get(key);
  if (existing) return existing;
  const run = (async () => {
    try {
      const pull = deps.pull
        ?? (await import('../features/sync/restore')).pullIncrementalReading;
      const outcome = await pull(ApiService, {
        userId: owner.userId,
        isAuthorized: () => readingOwnerIsCurrent(owner),
      });
      nextPullAttemptAt.set(key, Date.now() + (outcome.more ? PULL_SHORT_MS : PULL_MIN_MS));
      if (!outcome.aborted && outcome.sessions > 0 && readingOwnerIsCurrent(owner)) {
        useStatsStore.getState().refreshFromRepository(owner.userId);
      }
    } catch {
      nextPullAttemptAt.set(key, Date.now() + PULL_MIN_MS);
    } finally {
      if (pullInFlight.get(key) === run) pullInFlight.delete(key);
    }
  })();
  pullInFlight.set(key, run);
  return run;
}
```

(`ApiService`, `useEntitlementStore`, `useStatsStore`, `captureValidatedReadingOwner`, `readingOwnerIsCurrent` are already imported in `progressFlush.ts`. `deps.pull` keeps tests off the real `restore` module graph; prod passes nothing and uses the dynamic import.)

In `recover()`'s `run`, after `await dispatchReadingSync({ refreshPlan });`:

```ts
      await dispatchReadingSync({ refreshPlan });
      if (disposed) return;
      // Continuous pull shares this validated gate and runs after the push
      // drain, so another device's rows land shortly after ours upload.
      await refreshIncrementalReading();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/progressFlush.test.ts` with `workdir` `/home/x1carbon/Projects/Fan Novel`
Expected: PASS (no existing test broken)

- [ ] **Step 5: Commit**

```bash
git -C "/home/x1carbon/Projects/Fan Novel" add src/lib/progressFlush.ts src/lib/progressFlush.test.ts
git -C "/home/x1carbon/Projects/Fan Novel" commit -m "feat: schedule incremental pull from progressFlush"
```

---

## Verification

- `npx vitest run src/features/stats/statCards.test.ts src/repository/statsRepository.test.ts src/features/sync/restore.test.ts src/features/sync/restoreRows.test.ts src/lib/progressFlush.test.ts` in `/home/x1carbon/Projects/Fan Novel` — all pass.
- `npx tsc --noEmit -p tsconfig.json` in `/home/x1carbon/Projects/Fan Novel` — clean.
- Manual: on device A read 2 minutes then background (session uploads); on device B foreground more than 60s after its last pull; stats match after pull.

## Out of scope (future field-backed cards)

New per-session field requires, in order: local column + `statsRepository.ts:266` + serializer + `buildPayload` + server `contracts.ts` zod key + `schema.ts` column + `freeStore.ts`/`proStore.ts` store + `calculations.ts` aggregate + registry `merge` consumer. The registry from Task 1 absorbs this without touching dispatcher or pull scheduling. Promoting `dailyAverageMinutes` to Free needs only the server aggregate (total ÷ distinct days) plus the contract key — no client change, since `plan` is data on the registry entry.
