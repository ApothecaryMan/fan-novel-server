# Native Comments — Full Implementation Plan

**Date:** 2026-09-16
**Scope:** `fan-novel-server` (Hono + Drizzle + Neon on Cloudflare Workers) + `Fan Novel` mobile (Expo)
**Goal:** Own comments for native novels (novel-level + chapter-level, threaded replies, votes, moderation). Works **only** for our server extension (`FanNovelSource`, `sourceId='internal:published'`, `src/features/sources/sites/fanNovel.ts:41`). `site:truthnovel` keeps extension sync path; all other `site:*` / `file:import` / `bundle:preloaded` keep current behavior (mock/local).
**Status:** Plan only, no code changed.

---

## 1. Architecture

```
Expo app (CommentsDrawer)
  |-- sourceId == 'site:truthnovel' --> extension getComments/postComment (truthnovel plan, unchanged)
  |-- else (app-native / null) -----> Hono Worker --> Neon Postgres
                                          |
                                    R2 not needed, Redis optional (phase 3)
```

Why native, not Remark42 (`plans/remark42_comments_integration.md`):
- Worker is stateless (`src/worker.ts:19`), cannot run Remark42 Docker sidecar.
- Single source of truth: users/auth/admin already in Neon (`src/database/schema.ts:6`).
- One HTTP round-trip per action via `neon-http` (`src/database/db.ts:43`); no VPS/TLS/SECRET bridge ops.

---

## 2. Schema (final)

### 2.1 Drizzle (`src/database/schema.ts` append)

```ts
import { pgTable, varchar, text, integer, smallint, boolean, timestamp, uuid, bigint, uniqueIndex, index } from 'drizzle-orm/pg-core';

// helper exists: serial() -> integer generatedAlwaysAsIdentity; add bigserial():
function bigserial(name: string) {
  return bigint(name, { mode: 'number' }).generatedAlwaysAsIdentity();
}

export const comments = pgTable('comments', {
  id: bigserial('id').primaryKey(), // bigint identity: btree locality + cursor pagination
  novelId: varchar('novel_id', { length: 100 }).references(() => novels.id, { onDelete: 'cascade' }).notNull(),
  chapterNumber: integer('chapter_number'), // NULL = novel-level comment
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  parentId: bigint('parent_id', { mode: 'number' }),
  rootId: bigint('root_id', { mode: 'number' }),
  depth: smallint('depth').default(0).notNull(), // 0 root, 1..3 reply
  body: text('body').notNull(),
  bodyHash: varchar('body_hash', { length: 64 }).notNull(), // sha256(normalized) for dup check
  status: varchar('status', { length: 20 }).default('visible').notNull(), // visible|pending|hidden|deleted
  likesCount: integer('likes_count').default(0).notNull(),
  repliesCount: integer('replies_count').default(0).notNull(),
  reportsCount: integer('reports_count').default(0).notNull(),
  editCount: integer('edit_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedReason: varchar('decided_reason', { length: 500 }),
}, (t) => ({
  rootsNewIdx: index('comments_roots_new').on(t.novelId, t.chapterNumber, t.createdAt, t.id),
  rootsTopIdx: index('comments_roots_top').on(t.novelId, t.chapterNumber, t.likesCount, t.id),
  threadIdx: index('comments_thread').on(t.rootId, t.createdAt, t.id),
  parentIdx: index('comments_parent').on(t.parentId, t.createdAt, t.id),
  userIdx: index('comments_user').on(t.userId, t.createdAt, t.id),
}));

export const commentVotes = pgTable('comment_votes', {
  commentId: bigint('comment_id', { mode: 'number' }).references(() => comments.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  value: smallint('value').default(1).notNull(), // 1 | -1 (UI may expose like-only v1)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: uniqueIndex('comment_votes_pkey').on(t.commentId, t.userId),
  userLookupIdx: index('comment_votes_user').on(t.userId, t.commentId),
}));

export const commentModLog = pgTable('comment_mod_log', {
  id: bigserial('id').primaryKey(),
  commentId: bigint('comment_id', { mode: 'number' }).references(() => comments.id, { onDelete: 'cascade' }).notNull(),
  action: varchar('action', { length: 20 }).notNull(), // hide|restore|approve|delete|hard_delete|report
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  reason: varchar('reason', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

Self-FK (`parentId`/`rootId` -> `comments.id` cascade) is applied in SQL migration (Drizzle self-reference limitation); app logic treats soft-delete as default, cascade only fires on admin purge.

### 2.2 SQL migration (`drizzle/XXXX_comments.sql`)

```sql
CREATE TABLE comments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  novel_id VARCHAR(100) NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_number INT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  parent_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
  root_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
  depth SMALLINT NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 3),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  body_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'visible'
    CHECK (status IN ('visible','pending','hidden','deleted')),
  likes_count INT NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  replies_count INT NOT NULL DEFAULT 0 CHECK (replies_count >= 0),
  reports_count INT NOT NULL DEFAULT 0 CHECK (reports_count >= 0),
  edit_count INT NOT NULL DEFAULT 0 CHECK (edit_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_reason VARCHAR(500),
  CHECK ((parent_id IS NULL AND root_id IS NULL AND depth = 0)
      OR (parent_id IS NOT NULL AND root_id IS NOT NULL AND depth BETWEEN 1 AND 3)),
  CHECK ((status IN ('deleted','hidden') AND deleted_at IS NOT NULL)
      OR (status IN ('visible','pending') AND deleted_at IS NULL))
);
CREATE INDEX comments_roots_new ON comments (novel_id, chapter_number, created_at DESC, id DESC)
  WHERE parent_id IS NULL AND status = 'visible';
CREATE INDEX comments_roots_top ON comments (novel_id, chapter_number, likes_count DESC, id DESC)
  WHERE parent_id IS NULL AND status = 'visible';
CREATE INDEX comments_thread ON comments (root_id, created_at ASC, id ASC) WHERE status = 'visible';
CREATE INDEX comments_parent ON comments (parent_id, created_at ASC, id ASC) WHERE status = 'visible';
CREATE INDEX comments_user ON comments (user_id, created_at DESC, id DESC);
CREATE INDEX comments_body_hash ON comments (user_id, body_hash);

CREATE TABLE comment_votes (
  comment_id BIGINT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value SMALLINT NOT NULL DEFAULT 1 CHECK (value IN (1,-1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX comment_votes_user ON comment_votes (user_id, comment_id);

CREATE TABLE comment_mod_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  comment_id BIGINT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.3 Index -> query map

| Index | Serves |
|---|---|
| `comments_roots_new` | `WHERE novel+chapter AND parent NULL AND visible ORDER BY created DESC` |
| `comments_roots_top` | same WHERE, `ORDER BY likes DESC` (drop if write amplification hurts) |
| `comments_thread` | full thread `WHERE rootId ORDER BY created ASC` |
| `comments_parent` | reply preview `ROW_NUMBER() PARTITION BY rootId <= 2` |
| `comments_user` | cooldown `max(created_at)`, my-comments, daily cap `count` |
| `comment_votes_user` | `WHERE userId AND commentId IN (...)` liked-by-me batch |

---

## 3. API contract (base `/api/v1`, `{success,data,pagination}` like `src/routes/novels.ts:147`)

| # | Method + path | Auth | Notes |
|---|---|---|---|
| 1 | `GET /api/v1/novels/:novelId/comments?chapter&cursor&limit&sort=new\|top` | public | roots only, `Cache: max-age=60` |
| 2 | `GET /api/v1/novels/:novelId/comments/:id/replies?cursor&limit` | public | direct children, oldest-first |
| 3 | `POST /api/v1/novels/:novelId/comments` `{body, chapterNumber?, parentId?}` | `requireAuth` | 201 `{data, needsModeration?}` |
| 4 | `PATCH /api/v1/comments/:id` `{body}` | owner, 15min window | sets `editedAt`, `editCount<=5` |
| 5 | `DELETE /api/v1/comments/:id` | owner / novel-owner / admin | soft: `status=deleted`, `body=[deleted]` |
| 6 | `POST /api/v1/comments/:id/vote` `{value:1\|-1\|0}` | authed, no self-vote | 0 = unvote, returns `{score, myVote}` |
| 7 | `GET /api/v1/novels/:novelId/comments/count` | public | badge, cached 60s |
| 8 | `POST /api/v1/comments/:id/hide\|restore\|approve` `{reason?}` | novel-owner/admin | writes `commentModLog` |
| 9 | `DELETE /api/v1/admin/comments/:id/hard` | admin | GDPR/abuse purge only |
| 10 | `GET /api/v1/admin/comments?status=pending` | admin | mod queue |

Cursor: opaque base64url `{t:createdAt_ms, i:id}` (+ `{s}` when `sort=top`). First page omits cursor. Response `pagination: {limit, nextCursor|null, hasMore}`.

Zod (mirror `src/routes/novels.ts:62`):

```ts
CommentBody = z.string().transform(s=>s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').trim()).pipe(z.string().min(1).max(2000));
CreateComment = z.object({ body: CommentBody, chapterNumber: z.number().int().min(1).optional(), parentId: z.coerce.number().int().optional() }).strict();
EditComment = z.object({ body: CommentBody }).strict();
Vote = z.object({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).strict();
ListQuery = z.object({ chapter: z.coerce.number().int().min(1).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), sort: z.enum(['new','top']).default('new') }).strict();
```

Wire type:

```ts
interface Comment { id: string; novelId: string; parentId: string|null; rootId: string|null;
 chapterNumber: number|null; author: {id,name,avatarUrl?}; body: string;
 likes: number; repliesCount: number; myVote: 1|-1|0;
 isEdited: boolean; status: 'visible'|'pending';
 createdAt: string; updatedAt: string; }
```

ID wire format: `app_<bigint>` native (never collides with `site_<wpId>`).

---

## 4. Auth + moderation

PATs rejected on all comment routes (403 `PAT not allowed`); use `requireAuth` only.

| Action | Guest | Reader | Novel owner | Admin |
|---|---|---|---|---|
| read visible | yes | yes | yes | yes (+`?status`) |
| post / reply | 401 | yes | yes | yes |
| vote (not own) | 401 | yes | yes | yes |
| edit own (15min) | - | yes | yes | yes |
| delete own (soft) | - | yes | yes | yes |
| hide/restore/approve | - | no | own novel | any |
| hard delete | - | no | no | yes |

State machine: `visible -> pending (heuristic links>=2 / reports>=3) -> hidden (mod) -> deleted (soft) -> hard purge (admin, terminal)`. `visible<->hidden` via restore. All mod transitions append `commentModLog`.

---

## 5. Performance rules (Workers + `neon-http`)

1. One SQL statement per mutation (no `db.transaction()`; each drizzle call = 1 HTTP round-trip).
   - Post reply: `WITH ins AS (INSERT ...) UPDATE parents SET repliesCount+1`.
   - Vote toggle: `WITH v AS (INSERT..ON CONFLICT DO NOTHING), del AS (DELETE..WHERE NOT EXISTS v) UPDATE comments SET likes = likes + (v-del) RETURNING`.
   - Soft-delete: `WITH t AS (UPDATE..status=deleted) UPDATE parents SET repliesCount-1`.
2. Keyset pagination only: `WHERE (created_at,id) < ($t,$i) ORDER BY created DESC,id DESC LIMIT n`. `id` tiebreaker required.
3. Denormalized `likesCount/repliesCount`; never `count(*)` per open.
4. List = max 2 queries: roots + `ROW_NUMBER() PARTITION BY rootId` preview (<=2) merged in Worker memory; liked-by-me via `WHERE userId AND commentId = ANY($ids)`.
5. Plain-text storage, no HTML/markdown v1; `Content-Type: application/json; charset=utf-8`; client renders `<Text>` only.
6. `rateLimit()` (`src/middleware/rateLimit.ts:3`) is per-isolate burst gate only; authoritative limits in Postgres: 30s cooldown (`max(created_at)`), 100/day cap, IP-hash 50/hr, dup `bodyHash` vs last 3.

---

## 6. Implementation pathway

### Phase 0 — Migration (server)
1. Append tables to `src/database/schema.ts` (§2.1).
2. `npm run db:generate && npm run db:migrate` (Neon), verify in Drizzle Studio.
3. Deploy nothing yet; `GET /health` still `db:up`.

### Phase 1 — Read path (server)
1. New `src/routes/comments.ts`: `GET` roots + `GET` replies + `GET` count, `toApi()` mapper, cursor encode/decode, `Cache-Control: public, max-age=60`.
2. Mount in `src/app.ts` (`/api/v1/novels/:novelId/comments`, `/api/v1/comments`).
3. Seed script for 10 roots + 30 replies; verify indexes with `EXPLAIN (list roots, thread)`.

### Phase 2 — Write path (server)
1. `POST` (cooldown + dup + heuristic->pending + single-CTE counter bump), `PATCH` (window), `DELETE` (soft + counter decrement), `POST vote` (toggle CTE, self-vote 403).
2. Zod Arabic errors, `prodGuard(requireAuth)` on all writes.
3. `vitest` cases: post root/reply, depth>3 rejected, cross-novel parent rejected, edit window, vote toggle math, soft-delete hides.

### Phase 3 — Moderation (server)
1. `hide/restore/approve`, `admin/comments?status=pending`, `hard` + `commentModLog` writes, `ensureNovelOwner` checks.
2. Report endpoint `POST /comments/:id/report` (increments `reportsCount`, `>=3 -> pending`).

### Phase 4 — Mobile integration
1. `lib/comments/source.ts`: `isPublishedSourceId(src)` router (`sourceIdentity.ts:50`) — native API **only** when `src === 'internal:published'` (Fan Novel source); `site:truthnovel` -> extension; everything else -> existing mock/local. `CommentNode` (`app_`/`site_` prefix, `toNode` adapters).
2. `lib/comments/api.ts`: `listRoots/listReplies/post/edit/remove/vote/getCount` typed to §3.
3. `CommentsDrawer`: replace `getMockComments()` with router; roots FlatList + expandable replies (`limit` + "more replies"); badge via `getCount` 60s cache; 60s poll while open, cleanup on close; optimistic post (`app_pending_<ts>`), vote debounce 300ms, rollback on fail.

### Phase 5 — Harden + ship
1. `npx tsc --noEmit`, device test (post/vote/delete/moderate), `npx wrangler deploy`, `curl .../health` + comments smoke.
2. Optional: Upstash `REDIS_URL` sliding windows replacing DB cooldowns (same `checkCooldown()` interface); trigram search only if requested.

---

## 7. Verification

- `npm run db:generate && npm run typecheck`
- `vitest run` (new `src/routes/comments.test.ts`: pagination cursor stability, depth guard, vote toggle, edit window, mod transitions)
- Manual: novel page badge = count; open drawer -> roots + 2-reply preview; expand -> full thread; post root/reply (pending toast if flagged); vote like/unlike; edit in window; delete -> `[deleted]`; owner hide/restore; admin queue.
- `EXPLAIN` hot queries use index-only/bitmap scans, no seq scan at 100k+ rows.
- Truthnovel drawer (`sourceId site:truthnovel`) still uses extension path untouched.

---

## 8. Open items / risks

- `timestamp` without tz in old tables; new tables use `timestamptz` — do not copy old bug.
- Legacy novels with NULL `authorUserId/translatorUserId` -> admin-only moderation.
- `comments_roots_top` optional if write amplification high; ship `new` first.
- Downvotes: schema supports `-1`; UI can stay like-only v1.
