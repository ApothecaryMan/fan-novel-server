# Profile Media Simplify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered avatar/banner helpers with one app module plus a slimmed server that uploads through R2 and persists one URL string.

**Architecture:** Single writer (`profileMedia.ts`) owns pick-upload-PATCH; server stays authority for storage (`POST /upload/image` -> R2, `PATCH /me` persists text). Store holds absolute http(s) only; screens render it directly.

**Tech Stack:** TypeScript, Hono (server), Expo ImagePicker + FileSystem (app), vitest both repos.

**Spec:** `docs/superpowers/specs/2026-10-14-profile-media-simplify-design.md`

## Global Constraints

- New app file `src/features/profile/profileMedia.ts` <= 100 lines total.
- Online-only: no session -> return null + toast, no refresh dance, no offline queue, no Google-photo heal.
- Store holds absolute `http(s)` URLs only; never persist `file://` or bare `/uploads/...`.
- Avatars render direct, never proxied; banners use `toProxyDisplayUrl(url) ?? url`, GIFs always direct.
- Keep unchanged: `lib/imageProxy.ts`, decorations, `GET /uploads/:folder/:filename`, upload contract (`kind`, mime allowlist, size cap, `{success,url,filename}`).
- Server `cleanMediaUrl` gate unchanged: `http(s)` or `/uploads/covers|avatars|banners/...`, <= 2000 chars.

## Review Focus

- Relative `/uploads/avatars/x.png` + origin with trailing slash still joins to exactly one `/` — expect absolute URL.
- GIF banner URL bypasses proxy and renders direct — expect no `resize?` URL built.
- `file://` local URI passed to resolver is rejected — expect `undefined`, never stored.
- `saveProfileMedia` with null session does zero network calls — expect null return.
- Upload succeeds but `PATCH /me` rejects: store keeps old value — expect no remote URL written.

---

### Task 1: Server — remove heal, keep media gate

**Files:**
- Modify: `src/routes/googleAccount.ts`
- Test: `src/routes/googleAccount.unit.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `cleanMediaUrl(url?: string | null) -> string | undefined`, `cleanBio(...)` unchanged; `resolveGoogleAccount` creates media once, never heals on later logins (same signature).

- [ ] **Step 1: Shrink the unit test to the gate**

```ts
expect(clearly(cleanMediaUrl('/uploads/avatars/1_a.png'))).toBe('/uploads/avatars/1_a.png');
expect(cleanMediaUrl('file:///local/pick.jpg')).toBeUndefined();
expect(cleanMediaUrl('https://cdn.test/a.png')).toBe('https://cdn.test/a.png');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/routes/googleAccount.unit.test.ts`
Expected: FAIL (heal helpers still exported / referenced).

- [ ] **Step 3: Implement — delete `isGoogleHostedPhoto` + `decideAvatarHeal` and heal branches in `src/routes/googleAccount.ts`, keep `cleanMediaUrl`/`cleanBio` byte-identical**

Login creates `avatarUrl/bannerUrl` from input once; later logins patch email/role only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/routes/googleAccount.unit.test.ts`
Expected: PASS. Also run `npm run typecheck`, expected clean.

- [ ] **Step 5: Commit**

```bash
git add src/routes/googleAccount.ts src/routes/googleAccount.unit.test.ts
git commit -m "refactor(server): drop avatar heal, keep media gate"
```

### Task 2: Server — slim upload route, same contract

**Files:**
- Modify: `src/routes/upload.ts`
- Test: existing upload/route tests (no new file)

**Interfaces:**
- Consumes: `cleanMediaUrl` gate from Task 1 (unchanged).
- Produces: `POST /api/v1/upload/image` (multipart `file` + `kind=cover|avatar|banner`) -> `{success,url,filename}`; order binding -> S3 -> local; same status codes (400/413/401/503).

- [ ] **Step 1: Verify contract tests currently pass**

Run: `npm test -- src/routes/upload.ts src/routes/auth.ts`
Expected: PASS (baseline before slimming).

- [ ] **Step 2: Implement — rewrite `src/routes/upload.ts` to ~60 lines with identical validation, naming, status codes, and fallback order; delete comments and dead branches only**

- [ ] **Step 3: Run tests and typecheck**

Run: `npm test -- src/routes/upload.ts src/routes/auth.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 4: Commit**

```bash
git add src/routes/upload.ts
git commit -m "refactor(server): slim upload route without contract change"
```

### Task 3: App — new single media module (TDD)

**Files:**
- Create: `/home/x1carbon/Projects/Fan Novel/src/features/profile/profileMedia.ts`
- Test: `/home/x1carbon/Projects/Fan Novel/src/features/profile/profileMedia.test.ts`

**Interfaces:**
- Consumes: `ApiService.uploadImage(uri, mime, kind)`, `ApiService.updateMe({avatarUrl|bannerUrl})`, `API_BASE_URL`, `useAuthStore.getState()` (`validatedSession`, `currentUser`, `updateProfile`).
- Produces: `toAbsoluteMediaUrl(url: unknown, origin: string) -> string | undefined`, `saveProfileMedia(kind: 'avatar'|'banner') -> Promise<string | null>`, `clearProfileMedia(kind: 'avatar'|'banner') -> Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
expect(toAbsoluteMediaUrl('/uploads/avatars/1_a.png', 'http://10.0.2.2:4000/')).toBe('http://10.0.2.2:4000/uploads/avatars/1_a.png');
expect(toAbsoluteMediaUrl('file:///local/pick.jpg', 'http://x')).toBeUndefined();
expect(toAbsoluteMediaUrl('https://cdn.test/a.png', 'http://x')).toBe('https://cdn.test/a.png');
expect(toAbsoluteMediaUrl('', 'http://x')).toBeUndefined();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/profile/profileMedia.test.ts` (in `Fan Novel/`)
Expected: FAIL with "module not defined".

- [ ] **Step 3: Implement `profileMedia.ts` (<=100 lines): kind map (avatar `[1,1]`/`avatars`, banner `[14,5]`/`banners`), 7-entry mime map, `toAbsoluteMediaUrl`, `saveProfileMedia` (session guard, picker, `FileSystem.uploadAsync` multipart, resolve, `PATCH`, store set, return remote; nothing painted before remote), `clearProfileMedia` (explicit `avatarUrl: undefined` / `bannerUrl: undefined` then `PATCH {kind: null}`)**

- [ ] **Step 3b: Pin failure semantics with store/API mocks**

```ts
// null session: expect saveProfileMedia('avatar') toBe null with zero upload calls.
// PATCH rejects after upload ok: expect store avatarUrl unchanged (old value kept).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/profile/profileMedia.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/profile/profileMedia.ts src/features/profile/profileMedia.test.ts
git commit -m "feat(app): add single profile media module"
```

### Task 4: App — rewire call sites, delete old modules

**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/settings/AccountSettings.tsx`, `/home/x1carbon/Projects/Fan Novel/src/store/authStore.ts`, `/home/x1carbon/Projects/Fan Novel/src/components/auth/googleSignIn.tsx`
- Delete: `src/store/googleProfileMerge.ts` + test, `src/store/validatedMedia.ts` + test, `src/features/settings/profileMediaSync.ts` + test, `src/lib/uploadMime.ts` + test, `src/services/uploadResponse.ts` + test

**Interfaces:**
- Consumes: Task 3 `saveProfileMedia` / `clearProfileMedia` / `toAbsoluteMediaUrl`.
- Produces: `AccountSettings` pick/remove one-liners; `authStore.updateProfile` local setter only, no `unconfirmedMedia`; login accepts server user as-is.

- [ ] **Step 1: Rewire `AccountSettings.tsx` to call `saveProfileMedia`/`clearProfileMedia`, delete local `pickImageUri`/`uploadProfileMedia`**

- [ ] **Step 2: Strip `authStore.ts` (`unconfirmedMedia`, `setMediaUnconfirmed`, merge/select/resolve imports and reassert branches); `googleSignIn.tsx` inline username check**

- [ ] **Step 3: Delete the five modules plus their tests**

- [ ] **Step 3b: Pin GIF-direct display stays (existing `ProfileViewerSheet` branch, proxy untouched)**

Run: `npm test -- src/lib/imageProxy.test.ts src/features/profile` (in `Fan Novel/`)
Expected: PASS; `bannerIsGif` direct branch still present in `ProfileViewerSheet.tsx`.

- [ ] **Step 4: Run full app suite and typecheck**

Run: `npm test` and `npm run typecheck` (in `Fan Novel/`)
Expected: PASS, clean, zero imports of deleted modules (`grep -r googleProfileMerge|validatedMedia|profileMediaSync|uploadMime|uploadResponse src` empty).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(app): rewire profile media to single module"
```

### Task 5: Cross-repo verification

**Files:**
- Test: none (verification only)

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: green suites + manual proof both devices see the same remote URLs.

- [ ] **Step 1: Run server suite + typecheck**

Run: `npm test && npm run typecheck` (in `fan-novel-server/`)
Expected: PASS, clean.

- [ ] **Step 2: Run app suite + typecheck**

Run: `npm test && npm run typecheck` (in `Fan Novel/`)
Expected: PASS, clean.

- [ ] **Step 3: Manual proof — set avatar + banner, reload, confirm second account sees both in public sheet and under its comments; remove both, confirm placeholders**

- [ ] **Step 4: Commit nothing (no code); report results**
