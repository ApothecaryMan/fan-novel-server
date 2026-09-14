# Web Novel App — Current State

**Date:** 2026-09-01
**Scope:** `apps/server` backend (Hono + Drizzle + PostgreSQL)

---

## 1. Overview

Web-novel reader app with an Expo (React Native) mobile frontend and a Hono-based Node.js backend. The backend is configured for PostgreSQL 16 + Redis 7 via `docker-compose.yml`, with Drizzle ORM for database access.

---

## 2. Live vs. Database — IMPORTANT DISCREPANCY

| Layer | Status |
|-------|--------|
| PostgreSQL schema (`src/database/schema.ts`) | **Defined but NOT wired** — no Drizzle client, no drizzle.config, no migrations |
| Live API data | **In-memory Maps** — `NOVELS_STORE`, `CHAPTERS_STORE`, in-memory `users[]` |
| Redis | **Configured in docker-compose but never used** in code |

The API currently serves entirely from memory. **All data is lost on server restart.** The schema is a forward definition waiting to be connected.

---

## 3. Database Schema (PostgreSQL, 6 tables)

Defined in `src/database/schema.ts`.

### 3.1 `users` — App accounts
- `id` UUID PK
- `email` varchar(255), unique, not null
- `username` varchar(100), unique, not null
- `password_hash` text, not null
- `avatar_url` text
- `created_at`, `updated_at`

### 3.2 `novels` — Novels catalog
- `id` varchar(100) PK
- `title`, `author`, `category`, `status` (default 'مستمرة')
- `original_title`, `translator`
- `tags` jsonb (array)
- `rating` integer (0–100), default 50
- `readers_count` varchar — **stored as string, not numeric**
- `total_chapters` integer
- `cover_url`, `summary`
- `featured_rank` integer
- `created_at`, `updated_at`

### 3.3 `chapters` — Chapters per novel
- `id` serial PK
- `novel_id` FK → novels (cascade)
- `chapter_number` integer
- `title` varchar
- `content_raw` text (large blob)
- `word_count`, `views_count`
- Unique index `novel_chapter_idx (novel_id, chapter_number)`

### 3.4 `user_categories` — Tachiyomi-style library categories
- `id` serial PK, `user_id` FK → users (cascade)
- `name`, `order_index`, `is_system_default`, `created_at`

### 3.5 `user_library` — Novels saved to user's library
- `id` serial PK, `user_id` FK, `novel_id` FK
- `category_ids` jsonb
- `is_currently_reading`, `added_at`
- Unique index `user_library_idx (user_id, novel_id)`

### 3.6 `user_reading_progress` — Reading position sync
- `id` serial PK, `user_id` FK, `novel_id` FK
- `chapter_id` integer — **no FK to chapters**
- `scroll_y`, `updated_at`
- Unique index `user_novel_progress_idx (user_id, novel_id)`

---

## 4. API Endpoints (all in-memory currently)

- `GET /health`
- `POST /api/v1/auth/google` — Google login (JWT issued)
- `GET /api/v1/auth/me` — authed: current user
- `GET/POST/PUT/DELETE /api/v1/novels` — in-memory CRUD + in-memory filter/search
- `GET/POST /api/v1/novels/:novelId/chapters` — in-memory
- `GET /api/v1/novels/:novelId/chapters/:chapterNumber`
- `POST /api/v1/upload/cover` — saves to local `uploads/covers/`

---

## 5. Production Readiness Assessment

**Not production-ready.** Wiring the DB alone is insufficient. Blockers & risks:

### Data layer
- Schema issues: JSONB tags/category_ids have **no GIN index**; `readers_count` is varchar; `chapter_id` missing FK; no index on `category`/`status`/`featured_rank`.
- No migrations pipeline, no drizzle.config, no connection pool config.

### Security
- CORS is `origin: '*'` with `Authorization` header allowed while issuing JWTs (`index.ts`).
- No rate limiting on auth or API endpoints.
- Google idToken verification only enforced in production; dev trusts any email.
- Upload endpoint is **unauthenticated**, no file size/content limits.

### Uploads
- Covers written to single local disk — not durable, not load-balanced, lost on redeploy. Should be object storage (S3/R2).

### Reliability / ops
- `prettyJSON()` global middleware — wasteful in production.
- No structured logging, no error tracking, no tests, no CI.
- Redis running but unused.

---

## 6. Recommended Next Steps (priority order)

1. Wire Drizzle client + connection pool + migrations; connect the live routes to Postgres.
2. Fix schema issues and add indexes (GIN on jsonb, numeric `readers_count`, missing FKs, category/status/featured indexes).
3. Tighten CORS, add rate limiting, enforce auth + size limits on uploads.
4. Move uploads to object storage.
5. Use Redis for caching (novel listings, chapter content).
6. Add tests/CI, structured logging, disable `prettyJSON` in prod.

---

*Note: This document reflects the backend only. For Docker/Infra config see `docker-compose.yml`.*
