# Store-save device failure — diagnostic plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find why one device's `PUT /store/equip` deterministically fails with "couldn't save" while the server is proven healthy, then fix it.

**Architecture:** Evidence-first triage. The server path (auth → getCaller → equipItem → DB) is already exonerated by two successful reproductions; the remaining suspect area is the phone↔server link and the app's request pipeline. No code changes until device evidence picks a branch.

**Tech Stack:** React Native (Expo, Hermes) client, Hono on Cloudflare Workers, Neon Postgres.

**Spec:** The reported symptom (no separate spec doc): signed-in user taps remove on a profile effect → toast `store.saveFailed` ("تعذّر الحفظ. حاول مجددًا."), reproducibly, across reinstalls. The effect has since been cleared server-side during diagnosis, so the device's current state is itself evidence (see Task 1).

## Established evidence (do not re-prove)

- Direct `equipItem(db, {userId: good, slot: 'profile_effect', itemId: null, ...})` on prod data → success.
- Full local stack (`dist` app + prod pooler URL, token minted with the user's real `externalId` sub `google_116558073860079264635`) → `PUT /api/v1/store/equip` → HTTP 200, equipped row gone, decorations rewritten correctly.
- Prod health at diagnosis time: `GET /store/catalog` → 200, `GET /app/version` → 200.
- Server auth fails closed as 401 (never 5xx); the app maps 401 → sign-in message, 402 → not-enough-points, timeout → offline message. Only 5xx / transport abort / non-JSON response produce the observed toast.
- Timeout path is already classified offline (15s abort → `ApiError('offline')`), so the observed toast is NOT a plain timeout.

## Global Constraints

- Never write prod data without the user's literal go-ahead (migration/backfill rule extends to all prod writes).
- Repro scripts run the `dist` build against the pooler with `NODE_ENV=development`; rebuild via `npm run build` after touching `src/`.
- Kill any local repro server when done (`pkill -f "dist/index.js"`); verify the port is closed.
- One variable per experiment; a failed hypothesis gets replaced, not patched over.

## Review Focus

- A timed-out PUT surfacing as generic saveFailed: `fetchApi` maps its own 15s abort to offline, but a caller-side abort (React Query/navigation teardown) propagates raw `AbortError` → classified `server`. If the sheet unmounts mid-flight, the user sees "couldn't save" for a request that may still land.
- A non-JSON 200 (captive portal, carrier proxy page, Cloudflare challenge): `safeJson` throws `ApiError('server', status 200)` → saveFailed. Deterministic per network, invisible in logs.
- A transient 503 from the DB circuit breaker (`noteDbFailure` → `isDbAvailable()` false): every store write fails while reads served from cache/edge may look fine. Check `wrangler tail` for `store unavailable` around the tap time.
- Token minted for the wrong subject: `getCaller` matches `users.externalId`, not the uuid. Any client that puts the uuid in `sub` gets 401 → sign-in message (a different symptom, but the adjacent trap).
- Expo Go/dev builds resolving `API_BASE_URL` to a LAN address while release builds use `PROD_API_URL`: a device symptom that reproduces across reinstalls of the same binary is a build-flavor clue, not a server clue.

---

### Task 1: Collect the three device facts

**Files:** none (user-operated).

**Interfaces:**
- Consumes: current prod state (effect already cleared server-side for `good`).
- Produces: answers A/B/C that select Task 2 or Task 3 — no code until then.

- [ ] **Step 1:** Ask the user to reopen the account page (fresh open, no reinstall) and report: is the profile effect gone or still shown?
  - Gone → reads/sync work; only writes fail → go to Task 2.
  - Still shown → even `GET /store/sync` + profile refresh fail → go to Task 3.
- [ ] **Step 2:** Ask the user to open the avatar sheet and report: price numbers under unowned frames, or "–" dashes?
  - Numbers → public `GET /store/catalog` succeeds from that device → go to Task 2.
  - Dashes → public reads fail too → go to Task 3.
- [ ] **Step 3:** Ask whether WiFi and mobile data behave identically.
  - Only one fails → network-specific (carrier proxy, DNS, captive portal) → go to Task 3 with that network named.
  - Both fail identically → device/app-specific → go to Task 2.

### Task 2: Branch — reads work, writes fail (PUT-specific)

**Files:**
- Inspect: `src/services/api.ts:185-211` (`fetchApi`), `src/services/api.ts:1179-1197` (`equipDecoration`), `src/features/settings/AccountSettings.tsx` (`pushDecorations`, `toastPushOutcome`).
- Server logs, not code, first.

- [ ] **Step 1:** During a live tap, tail the worker and filter for the equip call.

Run: `npx wrangler tail --format pretty` (in `/home/x1carbon/Projects/fan-novel-server`), then have the user tap remove once and note the clock time.
Expected: a `PUT /api/v1/store/equip` entry with its status.
  - No entry at all → the request never leaves the phone → the bug is in the app's request pipeline (go to Step 3).
  - Entry with 4xx/5xx → the status names the layer (go to Step 2).

- [ ] **Step 2:** Map the observed status to a cause.
  - 401 → token invalid/expired at tap time despite fresh login: inspect `authStore` token persist/restore (`src/store/authStore.ts`, `setApiToken` call sites) for a path where login succeeds but the module-level `apiToken` stays null.
  - 503 with `store unavailable` → DB circuit breaker was open: correlate with Neon/pooler blips at that timestamp; transient, retry is the fix.
  - 500 → capture the worker exception message; reproduce that exact call locally before touching code.
- [ ] **Step 3:** If no request arrives, instrument the app side: confirm `API_BASE_URL` in the installed binary (user reads it from the same sheet that shows prices — prices present means the base URL and GETs work) and confirm the PUT body shape `{"slot":"profile_effect","itemId":null}` matches `equipSchema` (`src/routes/store.ts:82-85`).

### Task 3: Branch — reads fail too (network-level)

**Files:** none (environment, not code).

- [ ] **Step 1:** Have the user retry on the other network (WiFi ↔ data), with any VPN off.
Expected: one network works → the failing path has a proxy/DNS/captive portal interfering; the fix is environmental, not a code change.
- [ ] **Step 2:** If both fail, compare from a second device on the same network.
Expected: second device works → device-specific (OS network stack, date/time skew breaking TLS, private-DNS setting); second device fails → network-specific → escalate to Cloudflare WAF/Access events for the user's ASN around the tap time.
- [ ] **Step 3:** Rule out build flavor: confirm the installed binary is the release build (version visible in-app), not an Expo Go/dev build pointing at a LAN URL.

### Task 4: Fix (gated — only the branch winner)

**Files:** TBD by Task 2/3 outcome. No file is pre-approved for modification.

- [ ] **Step 1:** Write the failing test (or one-off repro script) that captures the proven cause — e.g. a test asserting the observed status maps to the observed toast, or a script replaying the exact failing request.
- [ ] **Step 2:** Run it; confirm it fails for the right reason.
- [ ] **Step 3:** Implement the single minimal fix; no adjacent refactoring.
- [ ] **Step 4:** Re-run test plus the full suites (`npm test` in `Fan Novel`, `vitest` in `fan-novel-server`); confirm green.
- [ ] **Step 5:** Commit with a conventional-commit one-liner; push only the branch that was approved.

### Task 5: Verify from the device

- [ ] **Step 1:** User taps remove/equip on the device and reports the toast.
Expected: the honest success toast, and the choice persists after reopening the page.
- [ ] **Step 2:** Run the ledger check.

Run: `npm run economy:reconcile` (in `/home/x1carbon/Projects/fan-novel-server`)
Expected: `{"checked":N,"mismatches":0,"rows":[]}`.

## Self-review

- Spec coverage: the "spec" is the symptom; every plausible layer (client pipeline, auth, service, DB, network) has an owning task or an exonerating evidence entry above. No orphan requirement.
- Step scan: each step names one action and its checkable result; branch steps route explicitly to the next step.
- Type consistency: file paths and symbol names (`fetchApi`, `equipDecoration`, `pushDecorations`, `toastPushOutcome`, `equipSchema`, `getCaller`, `setApiToken`) match the current codebase.
- Proportion: diagnostic plan, so commands dominate by design; no implementation bodies are pre-written, per the no-fix-without-evidence rule.
