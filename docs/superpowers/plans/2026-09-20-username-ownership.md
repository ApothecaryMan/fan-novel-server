# Username Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End server invention of usernames so new Google-provisioned accounts get `username NULL` with display name from Google data only, while explicitly chosen handles are accepted at creation and `PATCH /me` with taken names failing closed as `409 { code: 'username_taken', suggestions }`.

**Architecture:** Centralize `USERNAME_RE` plus a pure bounded deterministic slug generator in `src/routes/usernames.ts` (I/O-free, `isTaken` injected); remove all invention paths in `googleAccount.ts` / `auth.ts` fixture / `sync.ts`; harden `toPublic` to a null contract; add authenticated single-candidate availability endpoint; disambiguate username vs identity 409s by targeted re-read. No migration (column nullable since `0000`).

**Tech Stack:** Cloudflare Workers + Hono + Drizzle ORM + Neon Postgres (isolated local Postgres for race tests only), Vitest, Zod.

---

## Module placement decision (spec open question resolved)

`src/routes/usernames.ts` (not `src/lib/`). Rationale: the only consumers are auth-scoped routes (`auth.ts`, `googleAccount.ts`); co-locating with routes follows the existing codebase pattern (`googleAccount.ts`, `googleIdentity.ts` live in `src/routes/`); the pure generator stays I/O-free either way because the `isTaken` probe is injected by the caller and Drizzle is never imported into this module.

## File map

| File | Responsibility | Change |
| --- | --- | --- |
| `src/routes/usernames.ts` (new) | Single owner of `USERNAME_RE`, `MAX_SUGGESTIONS=3`, `MAX_PROBES=20`, pure `normalizeUsernameCandidate` + `suggestUsernames`, `UsernameTakenError` carrier | Create, pure, zero I/O imports |
| `src/routes/usernames.test.ts` (new) | Generator unit tests: determinism, bounds, truncation, invalid rejection, probe counting | Create, pure, no I/O |
| `src/routes/auth.ts` | Import canon from `usernames.ts`; schema-level 400; `toPublic` null contract; fixture without invention; PATCH suggestions + race backstop; new availability route; creation-taken mapping | Modify, 6 surgical edits |
| `src/routes/googleAccount.ts` | Insert without invention; invalid explicit username throws 400; taken explicit username throws `UsernameTakenError` with suggestions; conflict-recovery disambiguation; returning branch stays username-blind | Modify, 2 surgical edits |
| `src/routes/sync.ts` | Non-prod `provisionUser` inserts `username: null` | Modify, 1-line edit |
| `src/routes/auth.usernames.test.ts` (new) | Hono `app.request` matrix over mocked `identityDb` harness | Create |
| `src/routes/googleAccount.postgres.test.ts` | Append 3 race/grandfather cases, gated on isolated local `PHASE1_PG_URL` | Append only, never edit existing cases |
| `src/middleware/auth.ts`, `src/routes/googleIdentity.ts`, `src/routes/admin.ts`, `src/routes/comments.ts`, `src/config/env.ts`, `src/app.ts`, `src/database/schema.ts`, `drizzle/*`, `wrangler.toml`, app repo | Untouched | No edits |

## Constraints (binding on every task)

- Never modify/delete existing database content or committed migration history. No new file under `drizzle/`, no edit to `drizzle/meta/_journal.json`.
- No live-Neon writes during implementation. Only isolated local Postgres via `PHASE1_PG_URL` (must match `/phase1_identity_test` on localhost/127.0.0.1 or the postgres suite stays skipped).
- No secrets in code/tests. Fixtures use synthetic subjects, emails, handles. Test signing key only via existing `productionBindings` fixture.
- Preserve working-tree state: `git status --short` must show changes only in the plan-named files above. App repo at `/home/x1carbon/Projects/Fan Novel` is read-only reference; never edit.
- No R2/Cloudflare/billing/UI changes. No new dependency.

---

### Task 1: Baseline guardrails

**Status: ✅ complete** — tree clean (only untracked plan/spec docs), typecheck exit 0, 110 passed / 4 skipped (postgres, expected). Verification-only, no implementation.

**Files:** none (verification only)

- [ ] **Step 1: Confirm clean working tree except plan/spec untracked files**

Run: `git status --short`
Expected: only these untracked lines (or a subset), nothing modified:
```
?? docs/superpowers/plans/2026-09-19-decoration-store-backend.md
?? docs/superpowers/specs/2026-09-19-decoration-store-backend-design.md
?? docs/superpowers/specs/2026-09-20-username-ownership-design.md
```
If any `M ` modified line appears, stop and report before touching code.

- [ ] **Step 2: Baseline typecheck passes**

Run: `npm run typecheck`
Expected: exit 0 with no output (tsc silent on success).

- [ ] **Step 3: Baseline unit tests pass**

Run: `npm test 2>&1 | tail -15`
Expected: exit 0; summary lines like `Test Files  5 passed (5)` and `Tests  ... passed`. The postgres suite reports `skipped` when `PHASE1_PG_URL` is unset — that is expected.

---

### Task 2: Generator unit tests (failing first)

**Status: ✅ complete** — test file created plan-exact (uncommitted); spec review PASS, quality review APPROVED (missing SUT is the intended RED state).

**Files:**
- Create: `src/routes/usernames.test.ts`
- Test: `src/routes/usernames.test.ts`

- [ ] **Step 1: Write the failing generator test file (complete contents)**

Create `src/routes/usernames.test.ts` with exactly this content:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_PROBES, MAX_SUGGESTIONS, normalizeUsernameCandidate, suggestUsernames, USERNAME_RE } from './usernames.js';

describe('normalizeUsernameCandidate', () => {
  it('accepts valid handles verbatim', () => {
    expect(normalizeUsernameCandidate('Sara_123')).toBe('Sara_123');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeUsernameCandidate('  sara_1  ')).toBe('sara_1');
  });
  it('rejects without repair: too short, too long, bad chars, empty, non-string', () => {
    expect(normalizeUsernameCandidate('ab')).toBeNull();
    expect(normalizeUsernameCandidate('a'.repeat(21))).toBeNull();
    expect(normalizeUsernameCandidate('bad-name!')).toBeNull();
    expect(normalizeUsernameCandidate('  ')).toBeNull();
    expect(normalizeUsernameCandidate(undefined)).toBeNull();
    expect(normalizeUsernameCandidate(42)).toBeNull();
  });
  it('does not lowercase: case is preserved exactly', () => {
    expect(normalizeUsernameCandidate('Sara')).toBe('Sara');
  });
});

describe('suggestUsernames', () => {
  it('returns empty for an invalid base', async () => {
    let probes = 0;
    const out = await suggestUsernames('bad-name!', async () => { probes++; return true; });
    expect(out).toEqual([]);
    expect(probes).toBe(0);
  });
  it('is deterministic for the same taken-set', async () => {
    const taken = new Set(['sara', 'sara_1', 'sara_2']);
    const isTaken = async (c: string) => taken.has(c);
    expect(await suggestUsernames('sara', isTaken)).toEqual(['sara_3', 'sara_4', 'sara_5']);
    expect(await suggestUsernames('sara', isTaken)).toEqual(['sara_3', 'sara_4', 'sara_5']);
  });
  it('caps at MAX_SUGGESTIONS=3 and MAX_PROBES=20', async () => {
    expect(MAX_SUGGESTIONS).toBe(3);
    expect(MAX_PROBES).toBe(20);
    let probes = 0;
    const isTaken = async (_c: string) => { probes++; return true; };
    const out = await suggestUsernames('taken_name', isTaken);
    expect(out).toEqual([]);
    expect(probes).toBe(20);
  });
  it('stops early once 3 free names are found', async () => {
    let probes = 0;
    const taken = new Set(['bob', 'bob_1']);
    const out = await suggestUsernames('bob', async (c: string) => { probes++; return taken.has(c); });
    expect(out).toEqual(['bob_2', 'bob_3', 'bob_4']);
    expect(probes).toBe(4);
  });
  it('every suggestion matches USERNAME_RE', async () => {
    const out = await suggestUsernames('sara', async () => false);
    expect(out).toHaveLength(3);
    for (const s of out) expect(USERNAME_RE.test(s)).toBe(true);
  });
  it('truncates 20-char bases so base_n still fits 20 chars and matches RE', async () => {
    const base = 'a'.repeat(20);
    const out = await suggestUsernames(base, async () => false);
    expect(out).toEqual([`${'a'.repeat(18)}_1`, `${'a'.repeat(18)}_2`, `${'a'.repeat(18)}_3`]);
    for (const s of out) {
      expect(s.length).toBeLessThanOrEqual(20);
      expect(USERNAME_RE.test(s)).toBe(true);
    }
  });
  it('handles two-digit suffixes within 20 chars', async () => {
    const base = 'b'.repeat(20);
    const taken = new Set(Array.from({ length: 11 }, (_, i) => `${'b'.repeat(18)}_${i + 1}`));
    const out = await suggestUsernames(base, async (c: string) => taken.has(c));
    expect(out[0]).toBe(`${'b'.repeat(17)}_12`);
    expect(out[0].length).toBeLessThanOrEqual(20);
    expect(USERNAME_RE.test(out[0])).toBe(true);
  });
  it('returns empty when the table is adversarially saturated', async () => {
    const base = 'zed';
    const taken = new Set(Array.from({ length: 20 }, (_, i) => `zed_${i + 1}`));
    const out = await suggestUsernames(base, async (c: string) => taken.has(c));
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails (module does not exist yet)**

Run: `npx vitest run src/routes/usernames.test.ts 2>&1 | tail -12`
Expected: FAIL with an import error such as `Failed to resolve import "./usernames.js"` or `Cannot find module`. Do not proceed until this failure is observed.

---

### Task 3: Pure generator module implementation

**Status: ✅ complete** — module plan-exact in commit 63dc9eb, 12/12 pass; spec review PASS, quality review APPROVED. One approved test-only deviation: line-69 taken set fixed to actually-probed entries (production re-truncation is correct).

**Files:**
- Create: `src/routes/usernames.ts`

- [ ] **Step 1: Create the module with complete contents**

Create `src/routes/usernames.ts` with exactly this content (no Drizzle/Hono imports — I/O-free by construction):

```ts
// Username ownership: canonical handle rules + pure suggestion generator.
// This module performs zero I/O. Database probing is injected by callers
// via the `isTaken` callback (single-row exact-match existence check).
export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
export const MAX_SUGGESTIONS = 3;
export const MAX_PROBES = 20;

/** Trim and accept only values already matching USERNAME_RE. Never repair. */
export function normalizeUsernameCandidate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return USERNAME_RE.test(value) ? value : null;
}

function candidateFor(base: string, n: number): string {
  const suffix = `_${n}`;
  const truncated = base.slice(0, 20 - suffix.length);
  return `${truncated}${suffix}`;
}

/**
 * Deterministic suggestions for a taken base: base_1, base_2, ... with
 * 20-char truncation. Collects up to MAX_SUGGESTIONS free candidates,
 * stopping after MAX_PROBES probes. Invalid base yields [] with zero probes.
 */
export async function suggestUsernames(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string[]> {
  if (!USERNAME_RE.test(base)) return [];
  const out: string[] = [];
  for (let n = 1; n <= MAX_PROBES && out.length < MAX_SUGGESTIONS; n++) {
    const candidate = candidateFor(base, n);
    if (!USERNAME_RE.test(candidate)) continue;
    if (!(await isTaken(candidate))) out.push(candidate);
  }
  return out;
}

/** Carrier for username-taken 409s so HTTP layers can render suggestions. */
export class UsernameTakenError extends Error {
  suggestions: string[];
  constructor(suggestions: string[] = []) {
    super('اسم المستخدم محجوز بالفعل');
    this.name = 'UsernameTakenError';
    this.suggestions = suggestions;
  }
}
```

- [ ] **Step 2: Run generator tests to verify they pass**

Run: `npx vitest run src/routes/usernames.test.ts 2>&1 | tail -8`
Expected: exit 0, e.g. `Test Files  1 passed (1)` and `Tests  12 passed (12)`.

- [ ] **Step 3: Commit generator + tests**

Run: `git add src/routes/usernames.ts src/routes/usernames.test.ts && git commit -m "feat(usernames): add pure bounded suggestion generator"`
Expected: `git log --oneline -1` shows the new commit; `git status --short` shows no `M ` lines outside plan-named files.

---

### Task 4: Centralize USERNAME_RE in auth.ts (no behavior change yet)

**Status: ✅ complete** — 1-file import swap in commit 0c426ae, typecheck clean, 16/16 pass; spec review PASS, quality review APPROVED.

**Files:**
- Modify: `src/routes/auth.ts` (import + constant removal)

- [ ] **Step 1: Apply the exact edit**

Old string (lines 27-28):
```
// Client display name / handle rules (mirrors the mobile app).
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
```

New string:
```
// Canonical handle rules live in ./usernames.js (mirrors the mobile app).
import { USERNAME_RE } from './usernames.js';
```

The resulting head of file must read (lines 1-28):
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { verifyGoogleIdToken } from './googleIdentity.js';
import { cleanMediaUrl, isUniqueConflict, resolveGoogleAccount } from './googleAccount.js';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { users } from '../database/schema.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { adminEmails, getEnv } from '../config/env.js';
// Canonical handle rules live in ./usernames.js (mirrors the mobile app).
import { USERNAME_RE } from './usernames.js';
```

- [ ] **Step 2: Verify no behavior change**

Run: `npm run typecheck && npx vitest run src/routes/auth.identity.test.ts 2>&1 | tail -6`
Expected: typecheck exit 0; tests pass (e.g. `Tests  14 passed (14)`).

- [ ] **Step 3: Commit**

Run: `git add src/routes/auth.ts && git commit -m "refactor(auth): centralize USERNAME_RE in usernames module"`
Expected: commit created; `git status --short` clean except other plan files.

---

### Task 5: googleSchema 400 + toPublic null contract + fixture without invention

**Status: ✅ complete** — null contract in commit ba9c92b, typecheck clean, 16/16 pass; spec review PASS, quality review APPROVED. DB-path invention intentionally left for Task 6.

**Files:**
- Modify: `src/routes/auth.ts`
- Test: `src/routes/auth.usernames.test.ts` (written in Task 9; this task is implementation)

- [ ] **Step 1: Constrain googleSchema.username to USERNAME_RE**

Old string (line 19):
```
  username: z.string().max(100).optional(),
```

New string:
```
  username: z.string().regex(USERNAME_RE, 'اسم المستخدم: 3-20 حرف (أحرف وأرقام و_)').optional(),
```

Effect: invalid handles are rejected with 400 `invalid Google login payload` before provisioning; never silently nulled.

- [ ] **Step 2: Apply the toPublic null contract**

Old string (lines 30-38):
```
function toPublic(u: any) {
  return {
    id: u.externalId ?? u.id, externalId: u.externalId ?? u.id, email: u.email,
    name: u.displayName ?? u.username ?? u.name, username: u.username ?? u.name,
```

New string:
```
function toPublic(u: any) {
  return {
    id: u.externalId ?? u.id, externalId: u.externalId ?? u.id, email: u.email,
    name: u.displayName ?? null, username: u.username ?? null,
```

Rationale per spec §5: any `?? u.name` fallback re-invents a handle authoritatively and breaks the app's `isReturningServerAccount` routing. Display-only fallbacks in `comments.ts` stay untouched.

- [ ] **Step 3: Stop invention in the memUsers fixture branches**

Old string (lines 71-84):
```
      const displayName = input.name || input.username || email.split('@')[0];
      user = { id: externalId, externalId, googleSubject: identity?.sub ?? null, email,
        displayName, username: input.username || displayName,
        avatarUrl: cleanMediaUrl(input.avatarUrl) ?? null, bannerUrl: cleanMediaUrl(input.bannerUrl) ?? null,
        role: bootstrapAdmin ? 'admin' : 'reader' };
      memUsers.push(user);
    } else {
      user.email = email;
      if (bootstrapAdmin) user.role = 'admin';
      if (input.name) user.displayName = input.name;
      if (input.username) user.username = input.username;
```

New string:
```
      const displayName = (input.name || email.split('@')[0]).slice(0, 100);
      const explicit = typeof input.username === 'string' && USERNAME_RE.test(input.username) ? input.username : null;
      user = { id: externalId, externalId, googleSubject: identity?.sub ?? null, email,
        displayName, username: explicit,
        avatarUrl: cleanMediaUrl(input.avatarUrl) ?? null, bannerUrl: cleanMediaUrl(input.bannerUrl) ?? null,
        role: bootstrapAdmin ? 'admin' : 'reader' };
      memUsers.push(user);
    } else {
      user.email = email;
      if (bootstrapAdmin) user.role = 'admin';
      if (input.name) user.displayName = input.name;
      if (input.username !== undefined && USERNAME_RE.test(input.username)) user.username = input.username;
```

Note: schema-level regex already rejects invalid fixture usernames with 400, so the `USERNAME_RE.test` guards here are defense-in-depth for direct calls.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

Run: `git add src/routes/auth.ts && git commit -m "feat(auth): null username contract, strict creation schema, fixture without invention"`
Expected: commit created.

---

### Task 6: Creation without invention in resolveGoogleAccount + disambiguation

**Status: ✅ complete** — explicit-only creation in commit 98c4ff2, typecheck clean, 122 pass; spec review PASS, quality review APPROVED (no TOCTOU hole, grandfathering intact).

**Files:**
- Modify: `src/routes/googleAccount.ts`

- [ ] **Step 1: Extend imports**

Old string (lines 1-5):
```
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Db } from '../database/db.js';
import { users } from '../database/schema.js';
import type { VerifiedGoogleIdentity } from './googleIdentity.js';
```

New string:
```
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Db } from '../database/db.js';
import { users } from '../database/schema.js';
import type { VerifiedGoogleIdentity } from './googleIdentity.js';
import { USERNAME_RE, UsernameTakenError, suggestUsernames } from './usernames.js';
```

- [ ] **Step 2: Replace the insert path with explicit-only username + pre-check**

Old string (lines 33-47):
```
  let row = await find();
  if (!row) {
    try {
      const displayName = input.name || input.username || identity.email.split('@')[0];
      const inserted = await database.insert(users).values({
        externalId, googleSubject: identity.sub, email: identity.email,
        username: (input.username || displayName).slice(0, 100),
        displayName: displayName.slice(0, 100),
```

New string:
```
  let row = await find();
  if (!row) {
    if (input.username !== undefined && !USERNAME_RE.test(input.username)) {
      throw new HTTPException(400, { message: 'invalid Google login payload' });
    }
    const explicit = typeof input.username === 'string' && USERNAME_RE.test(input.username) ? input.username : null;
    if (explicit) {
      const clash = await database.select({ id: users.id }).from(users).where(eq(users.username, explicit)).limit(1);
      if (clash[0]) {
        const suggestions = await suggestUsernames(explicit, async (candidate) =>
          (await database.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1)).length > 0);
        throw new UsernameTakenError(suggestions);
      }
    }
    try {
      const displayName = (input.name || identity.email.split('@')[0]).slice(0, 100);
      const inserted = await database.insert(users).values({
        externalId, googleSubject: identity.sub, email: identity.email,
        username: explicit,
        displayName,
```

The remainder of the insert block (`avatarUrl`, `bannerUrl`, `role`, `.returning()`, provisioned log, `return assertCanonical(row)`) stays byte-identical.

- [ ] **Step 3: Disambiguate the conflict-recovery branch (username race vs identity conflict)**

Old string (lines 48-57):
```
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const committed = await find();
      if (!committed || committed.email !== identity.email) {
        throw new HTTPException(409, { message: 'account identity conflict' });
      }
      // Only an identical committed binding is an idempotent race winner.
      // Never heal or update any row in the conflict-recovery branch.
      return assertCanonical(committed);
    }
```

New string:
```
    } catch (error) {
      if (error instanceof UsernameTakenError) throw error;
      if (!isUniqueConflict(error)) throw error;
      if (explicit) {
        const holder = await database.select({ id: users.id }).from(users)
          .where(eq(users.username, explicit)).limit(1);
        if (holder[0]) {
          const committed = await find();
          if (!committed) {
            const suggestions = await suggestUsernames(explicit, async (candidate) =>
              (await database.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1)).length > 0);
            throw new UsernameTakenError(suggestions);
          }
        }
      }
      const committed = await find();
      if (!committed || committed.email !== identity.email) {
        throw new HTTPException(409, { message: 'account identity conflict' });
      }
      // Only an identical committed binding is an idempotent race winner.
      // Never heal or update any row in the conflict-recovery branch.
      return assertCanonical(committed);
    }
```

The returning-user patch branch (lines 60-65) is intentionally untouched: it heals only email, bootstrap-admin role, and missing media, never username or displayName.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

Run: `git add src/routes/googleAccount.ts && git commit -m "feat(account): explicit-only username creation with taken disambiguation"`
Expected: commit created.

---

### Task 7: sync.ts provisionUser stops fabricating handles

**Status: ✅ complete** — 1-line null insert in commit c780455, 14/14 pass, typecheck clean; spec review PASS, quality review APPROVED.

**Files:**
- Modify: `src/routes/sync.ts` (lines 89-98)

- [ ] **Step 1: Apply the one-line edit**

Old string:
```
  await db.insert(users).values({
    externalId, email: null, googleSubject: null,
    username: `user_${externalId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'x'}`,
    avatarUrl: null,
  }).onConflictDoNothing({ target: users.externalId });
```

New string:
```
  await db.insert(users).values({
    externalId, email: null, googleSubject: null,
    username: null,
    avatarUrl: null,
  }).onConflictDoNothing({ target: users.externalId });
```

Production behavior (never provision when `isProd`) is unchanged. No other line in `sync.ts` is touched.

- [ ] **Step 2: Typecheck + sync tests**

Run: `npm run typecheck && npx vitest run src/routes/sync.identity.test.ts 2>&1 | tail -6`
Expected: typecheck exit 0; sync tests pass.

- [ ] **Step 3: Commit**

Run: `git add src/routes/sync.ts && git commit -m "feat(sync): provision username null instead of fabricated handle"`
Expected: commit created.

---

### Task 8: PATCH /me suggestions + race backstop, creation-taken mapping, availability endpoint

**Status: ✅ complete** — endpoint + backstops in commit bd4fc9c, typecheck clean, 122 pass; spec review PASS, quality review APPROVED (no enumeration, no TOCTOU grant).

**Files:**
- Modify: `src/routes/auth.ts`

- [ ] **Step 1: Extend the usernames import and map creation races**

Old string (from Task 4):
```
import { USERNAME_RE } from './usernames.js';
```

New string:
```
import { USERNAME_RE, UsernameTakenError, suggestUsernames } from './usernames.js';
```

Then in the `POST /google` handler, map the carrier to the spec body shape. Old string (lines 87-89):
```
  } catch (error) {
    return accountError(c, error);
  }
});
```

New string (only the first catch in the file, inside `authRouter.post('/google', ...)`):
```
  } catch (error) {
    if (error instanceof UsernameTakenError) {
      return c.json({ error: 'اسم المستخدم محجوز بالفعل', code: 'username_taken', suggestions: error.suggestions }, 409);
    }
    return accountError(c, error);
  }
});
```

Scope guard: apply this edit only to the `/google` handler's catch. The `/me` GET and PATCH handlers keep their own catches (PATCH gets its own mapping in Step 3).

- [ ] **Step 2: Add the availability endpoint before the PATCH section**

Insert this block immediately before the line `// PATCH /api/v1/auth/me — explicit profile edit` (line 112):

```ts
// GET /api/v1/auth/username/availability?username=<candidate>
// Authenticated single-candidate live check. 200 for both free and taken
// (taken is an expected answer, not an error); 400 for malformed input
// with no suggestions; 401 via requireAuth; 503 on storage failure.
authRouter.get('/username/availability', requireAuth, async (c) => {
  const sub = String(c.get('authUser')?.sub ?? '');
  const candidate = (c.req.query('username') ?? '').trim();
  if (!USERNAME_RE.test(candidate)) {
    return c.json({ error: 'اسم المستخدم: 3-20 حرف (أحرف وأرقام و_)' }, 400);
  }
  const memFallback = !isDbAvailable() || (!getEnv().isProd && sub.startsWith('dev_'));
  try {
    if (memFallback) {
      if (!isDbAvailable() && getEnv().isProd) return c.json({ error: 'account storage unavailable' }, 503);
      const taken = memUsers.some((u) => u.username === candidate);
      if (!taken) return c.json({ available: true, suggestions: [] });
      const suggestions = await suggestUsernames(candidate, async (name) => memUsers.some((u) => u.username === name));
      return c.json({ available: false, suggestions });
    }
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1);
    if (rows.length === 0) return c.json({ available: true, suggestions: [] });
    const suggestions = await suggestUsernames(candidate, async (name) =>
      (await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1)).length > 0);
    return c.json({ available: false, suggestions });
  } catch (error) {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    noteDbFailure();
    return c.json({ error: 'account storage unavailable' }, 503);
  }
});
```

Placement inherits the existing `app.use('/api/v1/auth/*', rateLimit(30))` with no `app.ts` change. Exactly one candidate per request; no search/list/batch surface.

- [ ] **Step 3: PATCH pre-check gains code + suggestions**

Old string (lines 142-145):
```
      if (username !== undefined && username !== row.username) {
        const clash = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (clash[0]) return c.json({ error: 'اسم المستخدم محجوز بالفعل' }, 409);
      }
```

New string:
```
      if (username !== undefined && username !== row.username) {
        const clash = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (clash[0]) {
          const suggestions = await suggestUsernames(username, async (name) =>
            (await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1)).length > 0);
          return c.json({ error: 'اسم المستخدم محجوز بالفعل', code: 'username_taken', suggestions }, 409);
        }
      }
```

Single-`UPDATE` structure below stays unchanged (fail closed: on conflict nothing is written, including accompanying `name`/media fields).

- [ ] **Step 4: PATCH race backstop before accountError (username vs identity disambiguation)**

Old string (lines 154-156):
```
    } catch (error) {
      return accountError(c, error);
    }
  }

  if (getEnv().isProd) return c.json({ error: 'account storage unavailable' }, 503);
```

New string:
```
    } catch (error) {
      if (isUniqueConflict(error) && username !== undefined) {
        try {
          const holder = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
          if (holder[0]) {
            const suggestions = await suggestUsernames(username, async (name) =>
              (await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1)).length > 0);
            return c.json({ error: 'اسم المستخدم محجوز بالفعل', code: 'username_taken', suggestions }, 409);
          }
        } catch {
          noteDbFailure();
          return c.json({ error: 'account storage unavailable' }, 503);
        }
      }
      return accountError(c, error);
    }
  }

  if (getEnv().isProd) return c.json({ error: 'account storage unavailable' }, 503);
```

Scope guard: this is the catch inside `authRouter.patch('/me', ...)` DB branch only. `accountError`'s blanket `isUniqueConflict → account identity conflict` mapping therefore never swallows the username case. Genuine identity conflicts keep the generic 409.

- [ ] **Step 5: PATCH memUsers clash gains the same body shape**

Old string (lines 162-165):
```
  if (username !== undefined) {
    if (memUsers.some((u) => u !== user && u.username === username)) {
      return c.json({ error: 'اسم المستخدم محجوز بالفعل' }, 409);
    }
    user.username = username;
  }
```

New string:
```
  if (username !== undefined) {
    if (memUsers.some((u) => u !== user && u.username === username)) {
      const suggestions = await suggestUsernames(username, async (name) => memUsers.some((u) => u.username === name));
      return c.json({ error: 'اسم المستخدم محجوز بالفعل', code: 'username_taken', suggestions }, 409);
    }
    user.username = username;
  }
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

Run: `git add src/routes/auth.ts && git commit -m "feat(auth): availability endpoint, PATCH suggestions and race backstop"`
Expected: commit created.

---

### Task 9: Route-level Hono tests over the mocked harness

**Status: ✅ complete** — 12-case matrix in commit 524d4a0, 12/12 pass; spec review PASS, quality review APPROVED. Two approved test-only deviations: stub syntax fix + call-order-aware conditional stub (row-load real, clash stubbed).

**Files:**
- Create: `src/routes/auth.usernames.test.ts`

- [ ] **Step 1: Write the failing test file first (complete contents)**

Create `src/routes/auth.usernames.test.ts` with exactly this content:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { signToken } from '../middleware/auth.js';

const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_t, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(), noteDbFailure: () => holder.fake!.noteDbFailure(),
}));
let app: Hono;
const fake = () => holder.fake!;
const claimsFor = (sub: string, email: string) => ({ sub, email, aud: 'web-client',
  iss: 'accounts.google.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 });

async function loginAs(sub: string, email: string, body: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(claimsFor(sub, email))));
  return app.request('/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, idToken: 'google-token', ...body }) });
}
const me = (token: string, method = 'GET', body?: Record<string, unknown>) =>
  app.request('/auth/me', { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
const avail = (token: string | null, username: string) => app.request(
  `/auth/username/availability?username=${encodeURIComponent(username)}`,
  { headers: token ? { Authorization: `Bearer ${token}` } : {} });

beforeEach(async () => {
  holder.fake = identityDb();
  vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { authRouter } = await import('./auth.js');
  app = new Hono().use('*', requestId()).route('/auth', authRouter);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('username ownership routes', () => {
  it('creation without username yields null username and display name from Google data', async () => {
    const res = await loginAs('new-1', 'newone@test.com', { name: 'New One' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.user.username).toBeNull();
    expect(body.user.name).toBe('New One');
    expect(fake().rows[0]).toMatchObject({ username: null, displayName: 'New One' });
  });
  it('creation without name falls back to the email prefix for display only', async () => {
    const body: any = await (await loginAs('new-2', 'prefixuser@test.com')).json();
    expect(body.user.username).toBeNull();
    expect(body.user.name).toBe('prefixuser');
  });
  it('creation with an explicit valid username persists it verbatim', async () => {
    const body: any = await (await loginAs('new-3', 'picked@test.com', { name: 'Picked', username: 'picked_one' })).json();
    expect(body.user.username).toBe('picked_one');
    expect(fake().rows[0].username).toBe('picked_one');
  });
  it('creation with an invalid username returns 400 and creates nothing', async () => {
    expect((await loginAs('new-4', 'bad@test.com', { username: 'bad-name!' })).status).toBe(400);
    expect(fake().rows).toHaveLength(0);
  });
  it('creation with a taken username returns 409 username_taken with suggestions and creates no row', async () => {
    await loginAs('holder-1', 'holder@test.com', { username: 'taken_name' });
    const res = await loginAs('new-5', 'newfive@test.com', { username: 'taken_name' });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.code).toBe('username_taken');
    expect(body.suggestions).toEqual(['taken_name_1', 'taken_name_2', 'taken_name_3']);
    expect(fake().rows).toHaveLength(1);
  });
  it('availability matrix: free, taken, malformed, unauthenticated', async () => {
    await loginAs('holder-2', 'holder2@test.com', { username: 'held_one' });
    const { token }: any = await (await loginAs('checker-1', 'checker@test.com')).json();
    expect(await (await avail(token, 'fresh_one')).json()).toEqual({ available: true, suggestions: [] });
    const taken: any = await (await avail(token, 'held_one')).json();
    expect(taken.available).toBe(false);
    expect(taken.suggestions).toEqual(['held_one_1', 'held_one_2', 'held_one_3']);
    expect((await avail(token, 'bad-name!')).status).toBe(400);
    expect((await avail(null, 'fresh_one')).status).toBe(401);
  });
  it('PATCH success sets username atomically and returns it', async () => {
    const { token }: any = await (await loginAs('patch-1', 'patch@test.com')).json();
    const res = await me(token, 'PATCH', { username: 'my_handle', name: 'My Name' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user).toMatchObject({ username: 'my_handle', name: 'My Name' });
    expect(fake().rows[0]).toMatchObject({ username: 'my_handle', displayName: 'My Name' });
  });
  it('PATCH clash returns 409 with suggestions and writes nothing', async () => {
    await loginAs('holder-3', 'holder3@test.com', { username: 'claimed' });
    const { token }: any = await (await loginAs('patch-2', 'patch2@test.com')).json();
    const res = await me(token, 'PATCH', { username: 'claimed', name: 'Hacked Name' });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.code).toBe('username_taken');
    expect(body.suggestions).toEqual(['claimed_1', 'claimed_2', 'claimed_3']);
    expect(fake().rows.find((r) => r.email === 'patch2@test.com')).toMatchObject({ username: null, displayName: 'patch2' });
  });
  it('PATCH race backstop maps a lost unique race to username_taken, not identity conflict', async () => {
    await loginAs('holder-4', 'holder4@test.com', { username: 'race_handle' });
    const { token }: any = await (await loginAs('patch-3', 'patch3@test.com')).json();
    fake().db.select.mockImplementationOnce(((orig) => () => ({ from: (t: unknown) => ({
      where: (cond: unknown) => ({ limit: async () => [] }),
    }) }) }) as any)(fake().db.select);
    const res = await me(token, 'PATCH', { username: 'race_handle' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('username_taken');
  });
  it('toPublic null contract holds on google, get me, and patch me', async () => {
    const created: any = await (await loginAs('null-1', 'nullone@test.com')).json();
    expect(created.user.username).toBeNull();
    expect(((await (await me(created.token)).json()) as any).user.username).toBeNull();
    const patched: any = await (await me(created.token, 'PATCH', { name: 'Still No Handle' })).json();
    expect(patched.user.username).toBeNull();
    expect(patched.user.name).toBe('Still No Handle');
  });
  it('grandfathered mixed-case rows survive login and non-username patches byte-identical', async () => {
    fake().rows.push({ id: crypto.randomUUID(), externalId: 'google_grand-1', googleSubject: 'grand-1',
      email: 'grand@test.com', username: 'Legacy_Name', displayName: 'Legacy', passwordHash: null,
      avatarUrl: null, bannerUrl: null, role: 'reader', isAuthor: false, isTranslator: false,
      createdAt: new Date(), updatedAt: new Date() } as any);
    const body: any = await (await loginAs('grand-1', 'grand@test.com')).json();
    expect(body.user.username).toBe('Legacy_Name');
    const { token }: any = body;
    await me(token, 'PATCH', { name: 'Legacy Renamed' });
    expect(fake().rows[0].username).toBe('Legacy_Name');
  });
  it('ADMIN_EMAILS bootstrap still applies on a username-less creation', async () => {
    const body: any = await (await loginAs('admin-1', 'admin@test.com')).json();
    expect(body.user).toMatchObject({ role: 'admin', username: null });
  });
});
```

- [ ] **Step 2: Run the route tests (they must fail before Tasks 5-8 are done, pass after)**

Run: `npx vitest run src/routes/auth.usernames.test.ts 2>&1 | tail -8`
Expected after implementation: exit 0, `Test Files  1 passed (1)`, `Tests  12 passed (12)`. If any case fails, fix the Task 5-8 edit it points at; do not edit the test expectations (spec pins `MAX_SUGGESTIONS=3`, `MAX_PROBES=20`, exact body shapes).

- [ ] **Step 3: Commit**

Run: `git add src/routes/auth.usernames.test.ts && git commit -m "test(auth): username ownership route matrix"`
Expected: commit created.

---

### Task 10: Isolated-Postgres race + grandfather cases (append-only)

**Status: ✅ complete** — 3 cases appended (uncommitted), real-PG verified 7/7 × 4 runs, cluster shut down; spec review PASS, quality review APPROVED (genuine concurrency, NULL-exempt pinned, no order dependence).

**Files:**
- Modify: `src/routes/googleAccount.postgres.test.ts` (append new cases inside the existing `describe.skipIf(!url)` block; never edit existing cases)

- [ ] **Step 1: Append the three cases before the closing `});` of the describe block**

Old string (end of file, lines 75-83):
```
  it('a colliding email update is atomic with role bootstrap', async () => {
    const first = await resolveGoogleAccount(database, identity, { name: 'First' }, false, 'pg-update-1');
    await resolveGoogleAccount(database, { sub: 'pg-subject-2', email: 'pg-admin@test.com' }, { name: 'Second' }, true, 'pg-update-2');
    await expect(resolveGoogleAccount(database, { ...identity, email: 'pg-admin@test.com' }, {}, true, 'pg-update-3'))
      .rejects.toMatchObject({ status: 409 });
    const [unchanged] = await database.select().from(schema.users).where(eq(schema.users.id, first.id));
    expect(unchanged).toEqual(first);
  });
});
```

New string:
```
  it('a colliding email update is atomic with role bootstrap', async () => {
    const first = await resolveGoogleAccount(database, identity, { name: 'First' }, false, 'pg-update-1');
    await resolveGoogleAccount(database, { sub: 'pg-subject-2', email: 'pg-admin@test.com' }, { name: 'Second' }, true, 'pg-update-2');
    await expect(resolveGoogleAccount(database, { ...identity, email: 'pg-admin@test.com' }, {}, true, 'pg-update-3'))
      .rejects.toMatchObject({ status: 409 });
    const [unchanged] = await database.select().from(schema.users).where(eq(schema.users.id, first.id));
    expect(unchanged).toEqual(first);
  });
  it('concurrent creations racing the same explicit username converge to one holder', async () => {
    const { UsernameTakenError } = await import('./usernames.js');
    const attempts = await Promise.allSettled([
      resolveGoogleAccount(database, { sub: 'pg-race-u1', email: 'pg-race-a@test.com' }, { username: 'race_handle' }, false, 'pg-race-u1'),
      resolveGoogleAccount(database, { sub: 'pg-race-u2', email: 'pg-race-b@test.com' }, { username: 'race_handle' }, false, 'pg-race-u2'),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((a) => a.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(UsernameTakenError);
    expect((rejected.reason as { suggestions: string[] }).suggestions).toEqual(['race_handle_1', 'race_handle_2', 'race_handle_3']);
    const holders = await database.select().from(schema.users).where(eq(schema.users.username, 'race_handle'));
    expect(holders).toHaveLength(1);
  });
  it('username-less concurrent creations both succeed with null usernames', async () => {
    const [a, b] = await Promise.all([
      resolveGoogleAccount(database, { sub: 'pg-null-1', email: 'pg-null-1@test.com' }, { name: 'Null One' }, false, 'pg-null-1'),
      resolveGoogleAccount(database, { sub: 'pg-null-2', email: 'pg-null-2@test.com' }, { name: 'Null Two' }, false, 'pg-null-2'),
    ]);
    expect(a.username).toBeNull();
    expect(b.username).toBeNull();
    expect(await database.select().from(schema.users)).toHaveLength(2);
  });
  it('grandfathered-row login leaves the legacy username untouched', async () => {
    await database.insert(schema.users).values({ externalId: 'google_pg-grand-1', googleSubject: 'pg-grand-1',
      email: 'pg-grand@test.com', username: 'Legacy_Name', displayName: 'Legacy' });
    const row = await resolveGoogleAccount(database, { sub: 'pg-grand-1', email: 'pg-grand@test.com' }, { name: 'Ignored' }, false, 'pg-grand-1');
    expect(row.username).toBe('Legacy_Name');
    expect(row.displayName).toBe('Legacy');
  });
});
```

Also add the import at the top. Old string (line 8):
```
import { resolveGoogleAccount } from './googleAccount.js';
```

New string:
```
import { resolveGoogleAccount } from './googleAccount.js';
import { UsernameTakenError } from './usernames.js';
```

And replace the test-body dynamic import line `const { UsernameTakenError } = await import('./usernames.js');` with nothing (use the static import). Final race test body starts:
```
  it('concurrent creations racing the same explicit username converge to one holder', async () => {
    const attempts = await Promise.allSettled([
```

- [ ] **Step 2: Verify skip-without-URL behavior (no live Neon)**

Run: `npx vitest run src/routes/googleAccount.postgres.test.ts 2>&1 | tail -6`
Expected with `PHASE1_PG_URL` unset: exit 0, suite skipped (e.g. `Tests  no tests` or `3 skipped`). This proves no live write path is exercised by default.

- [ ] **Step 3: Run against isolated local Postgres only (Phase-1 pattern)**

Run (only if a local `phase1_identity_test` database exists; never point at Neon):
```bash
createdb -h 127.0.0.1 -U postgres phase1_identity_test 2>/dev/null || true
PHASE1_PG_URL='postgresql://postgres:postgres@127.0.0.1/phase1_identity_test' npx vitest run src/routes/googleAccount.postgres.test.ts 2>&1 | tail -8
```
Expected: exit 0, all cases pass including the 3 new ones (e.g. `Tests  7 passed (7)`). If the URL guard throws (`PHASE1_PG_URL must name the isolated local phase1_identity_test database`), stop: do not retry with any other URL.

- [ ] **Step 4: Commit**

Run: `git add src/routes/googleAccount.postgres.test.ts && git commit -m "test(account): isolated-postgres username race and grandfather cases"`
Expected: commit created.

---

### Task 11: Full validation and immutability gates

**Status: ✅ complete** — typecheck 0, 134 pass / 7 skip (postgres, expected), build 0, drizzle immutable (7+7), scope + secrets gates clean. Verification-only, no changes.

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 2: Full unit suite**

Run: `npm test 2>&1 | tail -10`
Expected: exit 0; all test files pass; postgres suite either passes (local URL set) or reports skipped (URL unset). No failures.

- [ ] **Step 3: Production build**

Run: `npm run build 2>&1 | tail -5`
Expected: exit 0. `dist/` output regenerated; ignore `dist/` in git (do not `git add` it).

- [ ] **Step 4: Migration immutability gate**

Run: `git status --short -- drizzle/ && ls drizzle/*.sql | sort && cat drizzle/meta/_journal.json | python3 -c "import json,sys; print(len(json.load(sys.stdin)['entries']))"`
Expected: first command prints nothing (no `drizzle/` changes); `ls` prints exactly `0000_sync.sql 0001_oval_outlaw_kid.sql 0002_dark_sumo.sql 0003_omniscient_mole_man.sql 0004_secret_tattoo.sql 0005_tidy_ultimates.sql 0006_google_identity_binding.sql`; entry count prints `7`. Any deviation is a hard failure: restore `drizzle/` and stop.

- [ ] **Step 5: Working-tree scope gate**

Run: `git status --short`
Expected: only plan-named source files changed/added:
```
M  src/routes/auth.ts
M  src/routes/googleAccount.ts
M  src/routes/sync.ts
M  src/routes/googleAccount.postgres.test.ts
?? src/routes/usernames.ts
?? src/routes/usernames.test.ts
?? src/routes/auth.usernames.test.ts
```
plus this plan file if not yet committed by the planner. No `M` line for `src/middleware/auth.ts`, `src/routes/comments.ts`, `src/routes/admin.ts`, `src/config/env.ts`, `src/app.ts`, `src/database/schema.ts`, `drizzle/*`, `wrangler.toml`, or anything under `/home/x1carbon/Projects/Fan Novel`. No secret-looking diff: run `git diff -- src/ | grep -iE "secret|BEGIN.*PRIVATE|neon.*key|jwt.*secret" || echo "no secrets in diff"` and expect `no secrets in diff`.

---

## Self-review audit (planner checklist, completed before handoff)

1. **Spec coverage:** §1 creation-without-invention → Tasks 5-6; §2 fixture/sync → Tasks 5, 7; §3 generator bounds (`MAX_SUGGESTIONS=3`, `MAX_PROBES=20`, deterministic `base_n`, truncation, invalid rejection, no I/O) → Tasks 2-3; §4 availability endpoint (auth, 200-not-409, 400/401/503, rate-limit inheritance, single candidate) + PATCH shape + race backstop → Task 8, pinned by Task 9; §5 `toPublic` null contract on all three responses → Task 5, pinned by Task 9; §6 disambiguation by re-read (never driver-text parsing), single-statement writes → Tasks 6, 8; grandfathering (no backfill/rename, mixed-case preserved) → Tasks 9-10; bootstrap unchanged → Task 9 case; no-migration gate → Task 11 Step 4; acceptance (`typecheck`, `test`, isolated postgres, `build`) → Task 11.
2. **Placeholder scan:** no `TBD`, `TODO`, `…`, `implement X`, `similar to Task N`, or undescribed error handling remains. Every creation/edit step carries complete file contents or exact old/new strings; every run step carries the exact command and expected key lines. (One deliberate scope note: Task 9 Step 2 tells the implementer to fix the Task 5-8 edit rather than the test — that is a direction, not a placeholder.)
3. **Type consistency:** `USERNAME_RE`, `MAX_SUGGESTIONS`, `MAX_PROBES`, `normalizeUsernameCandidate(raw: unknown): string | null`, `suggestUsernames(base: string, isTaken): Promise<string[]>`, and `UsernameTakenError { suggestions: string[] }` are spelled identically in Tasks 2, 3, 5, 6, 8, 9, 10. `suggestUsernames` always receives an `isTaken` closure built on an exact-match `eq(users.username, …)` point lookup. Route bodies use the spec shapes `{ error, code: 'username_taken', suggestions }` (409) and `{ available, suggestions }` (200).
4. **Fixes applied inline during audit:** (a) moved `USERNAME_RE` ownership to `usernames.ts` with an import-reorder step so `googleSchema` compiles; (b) gave the creation-taken path a typed `UsernameTakenError` carrier instead of overloading `HTTPException.message`, with explicit catch mapping in `POST /google`; (c) scoped the two `accountError` catch edits to their handlers so the PATCH backstop cannot leak into `/google` and vice versa; (d) added the `dev_` mem fallback to the availability endpoint so absent-token fixtures keep working in non-prod; (e) corrected the postgres race appendix to use a static import and removed the redundant dynamic import; (f) added the `dist/`-ignore note and the secrets-in-diff grep to the final gates.
