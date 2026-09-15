# Author Publish Pipeline — PATs + MCP (full plan)

Date: 2026-09-16
Repos: `fan-novel-server` (PATs, MCP package), `Fan Novel` (token UI)
Context: Google login is prod-ready (JWT HS256, 7d expiry — `middleware/auth.ts:17-24`).
Novel writes today require a session JWT + grant flags (`routes/novels.ts:187-199`).
Goal: let authors publish via the AI agent without the JWT-copy dance.

## Phase 0 — Interim (today, zero server changes)

For the TOHG publish and any urgent upload:
- Agent-side script (`fan-novel-server/scripts/publish-novel.mjs`, gitignored token via env `FAN_NOVEL_JWT`):
  args: `--novel meta.json --chapters dir/ --cover x.png --strip-tail --title-template "الفصل {n}"`.
  Steps: upload cover → `POST /novels` → `POST /:id/chapters` × N → verify `GET` + spot-checks.
- Flow: user pastes fresh JWT (7d, from in-app login) into the session; agent exports it for the script run only, never commits it.
- Keep the temp "copy session token" dev button out — user pastes from wherever they can read it; revisit if JWT proves unreadable (then add dev-only copy button as planned).

Done when: TOHG (30 ch) live, verified via `GET /novels` + chapter spot-checks.

## Phase 1 — Author API tokens (PATs), server — code done 2026-09-16 (`adb45b9`, tests 3/3, `tsc` clean)

Pending: apply `drizzle/0003` to Neon, deploy, live curl verification.

1. Migration `drizzle/00XX_author_api_keys.sql`:
   `author_api_keys(id uuid pk default gen_random_uuid(), user_id uuid → users.id cascade,
   name varchar(100), key_prefix varchar(16), key_hash char(64) unique (sha256),
   scopes jsonb default '["novels:write"]', created_at, last_used_at, revoked_at)`.
   Add to `src/database/schema.ts`.
2. `src/routes/authorKeys.ts` (behind `requireAuth`):
   - `POST /api/v1/author/keys {name}` → generate `fn_pat_<32B base64url>`, store `{prefix: first 8, sha256}`,
     return plaintext **once**. Cap 5 active keys/user.
   - `GET /api/v1/author/keys` → list (prefix, name, created, last_used; never hashes).
   - `DELETE /api/v1/author/keys/:id` → revoke (set `revoked_at`).
3. `src/middleware/authorToken.ts`: `resolveAuthorCaller(c)`:
   - If Bearer starts `fn_pat_`: sha256 → lookup key + join user; reject revoked/missing (401);
     enforce `scopes` includes `novels:write`; set `c.set('authUser', {sub: externalId, pat: true})`;
     touch `last_used_at` (fire-and-forget).
   - Else fall through to existing JWT `requireAuth`.
   - Wire into authoring routes only: `POST/PUT /novels`, `POST /novels/:id/chapters`,
     `PUT/DELETE /chapters`, `POST /upload/cover`. Explicitly NOT `/admin/*`, `/sync/*`, `/auth/*`.
   - Grant check stays: PAT caller must still have `isAuthor`/`isTranslator`/admin row flags
     (reuse `routes/novels.ts:199` logic) — a leaked key can't escalate beyond the owner's grants.
4. Rate limit: extend `app.ts` limiter — authoring with PAT: 60/min/IP+key (covers batch chapter uploads).
5. Tests (`vitest` in server): create→use→revoke→401; wrong scope→403; JWT path unchanged;
   revoked key→401; key of non-author→403 on `POST /novels`.
6. Env/docs: no new env needed; document in `README.md` + `.env.example` comment.

Done when: `typecheck` + tests green; curl: PAT creates novel+chapter, revoked PAT → 401,
admin route with PAT → 401/403.

## Phase 2 — MCP server (`fan-novel-server/packages/author-mcp`)

- Runtime: Node 20, MCP TypeScript SDK (`@modelcontextprotocol/sdk`), stdio transport.
- Config: `FAN_NOVEL_API_URL` (default prod Workers URL), `FAN_NOVEL_PAT` (required).
- Tools (all call REST with `Authorization: Bearer $PAT`):
  - `listMyNovels {}` → id/title/status/totalChapters.
  - `createNovel {title, author?, translator?, category, status?, summary, coverPath?, tags?}`
    (uploads cover first if `coverPath` given).
  - `addChapter {novelId, chapterNumber, title, contentPath|content}`.
  - `addChaptersBatch {novelId, chaptersDir, titleTemplate, stripTail}` — glob `*.md`,
    optional tail-strip (`---` + `### Suggested Glossary Updates` … end), sequential POSTs
    with per-chapter results; idempotent-ish via `(novelId, chapterNumber)` unique index
    (409 → reported as skipped).
  - `getNovel {novelId}` → novel + chapter list (verification).
- Errors: map 401 → "token invalid/revoked — re-issue in app"; 403 → "missing grant";
  409 → "chapter exists, skipped". Never log the PAT (redact in errors).
- Ship: `package.json` bin `fan-novel-author-mcp`, README with opencode `mcp.json` snippet.
- Test: against local dev server (`npm run dev`) with a dev PAT — create + 3 chapters + revoke → 401.

Done when: fresh checkout + PAT publishes a test novel end-to-end via an MCP client.

## Phase 3 — App UI (token management)

- Account/Security screen section: list keys (name, prefix, created, last used), create (name input →
  show-once sheet with copy button), revoke (confirm dialog). Reuse existing M3 sheets/dialogs.
- Strings: `auth.pat*` keys in `en.ts` + `ar.ts`.
- Gate: visible only when logged in; no token plaintext stored on device (show-once only).

Done when: create → use via curl → revoke → 401; Arabic + English strings render.

## Phase 4 — Docs & rollout

- `fan-novel-server/README.md`: author-token guide (create, scope, revoke, rotation).
- Mobile: short "Publish with AI" help entry pointing at token screen.
- Rotate any PAT ever pasted into chat/logs. Deploy server, publish MCP usage snippet for opencode.

## Security notes (non-negotiable)

- Store only sha256 hashes; plaintext exists only in the create response.
- PATs never authorize admin/sync/auth routes; grant flags still enforced per owner.
- Revocation is immediate (DB check per request; `last_used_at` async).
- Rate limits on key management (10/min) + authoring (60/min).

## Acceptance

- [ ] TOHG live via Phase 0.
- [ ] PAT lifecycle (create/use/revoke) verified by curl + tests.
- [ ] MCP publishes a novel end-to-end from a clean checkout.
- [ ] Token UI works in both languages; no plaintext persisted on device.
- [ ] No PAT reaches admin/sync routes; revoked keys fail closed.
