# Profile Media Simplify — Design

Date: 2026-10-14. Scope: app (`Fan Novel/`) + server (`fan-novel-server/`).
Approved direction: Approach A — one app file + slim server, online-only, blocking upload.

## 1. Context

Avatar/banner flow is scattered: app holds `store/googleProfileMerge.ts` (167),
`store/validatedMedia.ts` (35), `features/settings/profileMediaSync.ts` (61),
`lib/uploadMime.ts` (19) plus `unconfirmedMedia`/heal branches in
`store/authStore.ts`; server holds heal helpers in `routes/googleAccount.ts`. Total ~450 lines for pick-upload-save-show.
Keep untouched: `lib/imageProxy.ts`, decorations, `GET /uploads/*` serving.

Fact: the app never talks to R2. App sends multipart to
`POST /api/v1/upload/image`; server puts to R2 (`COVERS` binding on Workers,
S3-compatible `R2_*` env on Node, local disk for LAN dev) and returns a URL
string. That string is persisted via `PATCH /api/v1/auth/me` into
`users.avatar_url/banner_url` (plain text in DB). Every read
(`/me/profile`, `/:id/profile`, comments author chip) returns the same string.

## 2. Goal / non-goals

Goal: one obvious app file `src/features/profile/profileMedia.ts` (~100 lines;
simplicity over count — up to ~120 clear lines beats forced compression) for
pick + upload + save + clear + URL resolve, and a slimmed server
(`routes/upload.ts` ~60 lines, `routes/googleAccount.ts` keeps only
`cleanMediaUrl`/`cleanBio`). After change: user picks banner/avatar once, it is
uploaded to R2 through the server, saved on the profile row, and every surface
(owner header, `ProfileViewerSheet`, comment chips) shows the same remote URL.
Non-goals: offline queue/retry, Google-photo auto-heal, optimistic `file://`
persistence, direct-to-R2 signed URLs, decoration changes, proxy changes.

## 3. Architecture

Single writer, server authority. The new module is the only place that knows
the picker aspect per kind, the ext-to-mime map, and the PATCH shape. Upload
itself is reused from `ApiService.uploadImage(uri, mime, kind)` (web FormData
and native FileSystem paths, already tested there); the server maps `kind` to
its R2 prefix. `authStore` keeps `currentUser.avatarUrl/bannerUrl` as plain
absolute-URL strings plus `updateProfile()` as a local setter; it performs no
merge, no heal, no unconfirmed tracking. Every server `avatarUrl/bannerUrl`
enters the store or a render prop through `withAbsoluteMediaUrls` once at the
boundary (login accept, `applyServerProfile`, validate/refresh accept, public
profile and comment-author mapping). Display components stay pure renderers
of those strings.

## 4. App changes

New `src/features/profile/profileMedia.ts` exports:
`toAbsoluteMediaUrl(url, origin)`, `withAbsoluteMediaUrls(obj, origin)`,
`saveProfileMedia(kind)`, `clearProfileMedia(kind)`.
`saveProfileMedia`: guard session, `ImagePicker` (avatar `[1,1]`, banner
`[14,5]`, quality 0.85), ext-to-mime inference folded in from `uploadMime`,
`ApiService.uploadImage(localUri, mime, kind)` (returns the absolute URL),
`PATCH /me` with that URL, `updateProfile()` with the confirmed remote URL,
return it.
No local `file://` is written to the store; UI shows spinner until remote
returns. `clearProfileMedia`: `PATCH /me` FIRST with the explicit field body
(`{ avatarUrl: null }` for avatar, `{ bannerUrl: null }` for banner — the
server accepts field names, not `kind`), and only on success
`updateProfile({ avatarUrl: undefined })` / `updateProfile({ bannerUrl:
undefined })`. Server authority: the store is never cleared before the server
confirms, so a failed PATCH leaves the old value in place with nothing to
revert. The existing 7-key ext map folds in as-is (jpg/jpeg/png/webp/gif plus
heic/heif, which the server allowlist still rejects exactly as today — same
error path, no new behavior). `withAbsoluteMediaUrls` maps a server user/author
object's `avatarUrl`/`bannerUrl` through `toAbsoluteMediaUrl` (legacy `file://`
and empty become `undefined`) so every boundary emits render-ready values.
Delete: `store/googleProfileMerge.ts`+test, `store/validatedMedia.ts`+test,
`features/settings/profileMediaSync.ts`+test, `lib/uploadMime.ts`+test.
`services/uploadResponse.ts` stays (`ApiService` uses it for all uploads). Edit: `AccountSettings.tsx` calls the two
functions (removes `pickImageUri`/`uploadProfileMedia` locals);
`store/authStore.ts` removes `unconfirmedMedia`, `setMediaUnconfirmed`,
merge/select/resolve imports and reassert branches, login uses accepted
server user directly; `components/auth/googleSignIn.tsx` replaces
`isReturningServerAccount` import with inline username check.

## 5. Server changes

`routes/upload.ts`: unchanged contract (`kind=cover|avatar|banner`, mime
allowlist jpeg/png/webp/gif, size cap `UPLOAD_MAX_MB`, filename
`Date.now()+rand+ext`, binding -> S3 -> local order, `{success,url,filename}`).
Slim only by deleting comments/dead branches to ~60 lines. `GET
/uploads/:folder/:filename` in `app.ts` unchanged.
`routes/googleAccount.ts`: keep `cleanMediaUrl` (http(s) or
`/uploads/covers|avatars|banners/...`, <=2000 chars) and `cleanBio`; delete
`isGoogleHostedPhoto`, `decideAvatarHeal`, and heal branches. Login creates
`avatarUrl/bannerUrl` from input once, never overwrites a stored remote URL on
later logins. `PATCH /me` keeps `cleanMediaUrl` gate, unchanged semantics.
Delete `routes/googleAccount.unit.test.ts` heal cases (keep `cleanMediaUrl` cases).

## 6. Data flow

Pick -> require `validatedSession` (else error toast, no refresh dance) ->
upload multipart -> absolute URL -> `PATCH /me` -> store set -> render. Reads:
`GET /me/profile` and `GET /:id/profile` return stored strings; app resolves
relative once when accepting into store or rendering public cards. Comments
carry the same strings; no per-surface merge.

## 7. Error handling

No session -> toast `needsSessionCheck`, return null. Upload non-2xx,
non-JSON, missing URL, or non-http(s) URL -> throw, caller toasts
`bannerSyncFailed`/`avatarSyncFailed`, store untouched (nothing was painted
before the remote returned). Remove: `PATCH` runs first, so a rejection means
the store still holds the old value — toast the error and leave it; the next
open re-reads the server via `refreshServerProfile`. Server keeps 400 (bad
mime/kind), 413 (over cap), 401 (no auth), 503 (no storage on Workers).

## 8. Display contract

Store holds absolute http(s) only. Avatar renders direct (never proxied).
Banner renders `toProxyDisplayUrl(url) ?? url`, GIFs always direct, proxy
`onError` falls back to direct once (existing `ProfileViewerSheet` logic,
unchanged). Missing URL renders placeholder/letter. Legacy rows holding
`file://` (written by the old optimistic code) resolve to `undefined` in
`toAbsoluteMediaUrl` and render the same placeholder/letter — never a broken
image. Relative strings from old rows resolve via `toAbsoluteMediaUrl` at
accept time, so no screen ever receives `file://` or bare `/uploads/...`.

## 9. Testing

Vitest: new `profileMedia.test.ts` — kind->folder map, mime fallback,
relative->absolute join, trailing-slash origin, reject `file://`/empty.
Server: `cleanMediaUrl` accepts http(s) + `/uploads/avatars|banners/*`,
rejects `file://`; upload route 400/413/401 cases kept. Manual: set avatar +
banner, reload app, confirm second account sees both in public sheet and under
its comments; remove both, confirm placeholder on both devices.

## 10. Risks

Dropping heal means a stale Google photo stays until user picks once (accepted
in review). Dropping offline queue means airplane-mode picks fail fast instead
of retrying (accepted). Deleting tests for removed modules is intentional;
equivalent coverage moves to the new test file. Replaced/removed images leave
their old R2 objects orphaned (no delete on replace/clear) — accepted for now;
revisit with a cleanup pass if bucket storage grows. Removing heal does not
break old app versions: the login request/response contract is unchanged, heal
only ever issued an optional extra avatar patch, and old clients keep their
local merge — worst case they keep showing the stored photo until the user
picks once.
