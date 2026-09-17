# Frame Store Phase 1 Security Hardening Implementation Plan

## Coordinated execution status (2026-09-17)

The task checklist below is the original proposed sequence, not evidence that each exact command or intermediate commit was executed. Implementation was delivered together in `81bbb88`; isolated PostgreSQL verification subsequently passed all 114 tests. Do not replay completed work from unchecked boxes.

- [x] Local implementation committed (`81bbb88`); 114 tests passed including four isolated PostgreSQL tests.
- [x] Two explicitly approved trial accounts deleted; post-deletion users 0, novels 1, chapters 35.
- [x] Production secrets configuration reported completed by the user; values are not independently readable from Cloudflare.
- [x] Additional approved ledger correction committed in the database: remove duplicate ledger IDs 6/7/8; correct checksums on 9/10/11. No application data/schema changes. Backup and independent post-commit verification: `/tmp/opencode/fan-novel-gate3-schema-audit/backups/2026-09-17T19-15-49-415Z/` and corresponding correction evidence JSON.
- [x] Migration 0006 applied and independently verified on Neon (ledger ID 12, canonical hash/timestamp; nullable users.google_subject and valid unique constraint; users 0, novels 1, chapters 35). Evidence: `/tmp/opencode/fan-novel-gate3-schema-audit/0006-2026-09-17T19-27-10-642Z/postcommit-evidence.json`.
- [ ] Deploy Worker and verify deployed version and health.
- [ ] Real Google sign-in smoke test from the app (operator required).

No production deployment or migration 0006 is implied by the local test results. Ledger correction was a separately approved operational scope addition, supported by a live-schema comparison against SQL migrations 0000–0005.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind accounts permanently to verified Google subjects, lock authentication email against client writes, and fail closed on production configuration or account-storage failures.

**Architecture:** Keep tokeninfo and the existing Drizzle Node/Neon HTTP boundary. Separate claim verification and single-row subject provisioning into small route-local modules; retain profile/media wire behavior and explicitly isolate development memory fixtures. Apply an additive schema migration before releasing code, with a read-only empty-table gate and no linking, backfill, or identity repair.

**Tech Stack:** Hono, TypeScript, Zod, Drizzle/PostgreSQL, jose, Vitest, Node pg pools, Neon HTTP, Cloudflare Wrangler.

---

## Execution contract and file map

- Repository: `/home/x1carbon/Projects/fan-novel-server`. Run every command from this directory, on the implementation branch/worktree approved by the primary agent. This document is a plan, not authorization to deploy.
- Source of truth: `docs/superpowers/specs/2026-09-17-frame-store-phase1-security-hardening-design.md`.
- Each numbered task has exactly one checkbox/action and is sized for 2–5 minutes of active work. Commands may wait longer for compilation or container startup. Apply code blocks literally; whole-file content blocks are complete. Edits use unified diffs. Never execute a remote command until the deployment approval gate.
- `src/database/schema.ts`, `drizzle/0006_google_identity_binding.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0006_snapshot.json`: additive permanent nullable unique identity anchor. The full snapshot below deliberately preserves every unrelated table.
- `src/routes/googleIdentity.ts`: tokeninfo boundary; `src/routes/googleAccount.ts`: subject lookup, canonical-ID checks, atomic provisioning/conflict reread, verified-email updates and redacted creation event.
- `src/routes/auth.ts`: compatible login/profile responses, verified identity, isolated memory fixtures, 401/409/503 failures.
- `src/routes/sync.ts`: email-free development provisioning; production existing-account-only resolution for push, pull **and stats**. Stats already calls the shared provisioner, so it must get the same token/body owner gate; this is not general authorization remediation.
- `src/config/env.ts`, `src/middleware/auth.ts`: explicit mode and shared signing-key policy. Remove the environment cache rather than retain a partial cache key: bindings are small, and every call revalidates its effective source. Worker bindings are authoritative, not merged with Node defaults.
- New tests: `src/config/env.test.ts`, `src/middleware/auth.test.ts`, `src/routes/googleIdentity.test.ts`, `src/routes/auth.identity.test.ts`, `src/routes/sync.identity.test.ts`, `src/routes/googleAccount.postgres.test.ts`; shared fake DB: `src/test/identityDb.ts`. Existing memory tests get explicit isolated mode. Existing comments tests already run under Vitest's explicit `NODE_ENV=test` and require no functional edits.
- `docs/superpowers/runbooks/phase1-security-release.md`: local checks, nonprinting secret/config validation, read-only emptiness gate, migration/deploy authorization, rollback caution.
- Do not change app/mobile files, `src/database/db.ts`, R2, `wrangler.toml`, dependencies, or Phase 2 features. Do not treat this hardening as a complete authorization audit.
- HTTP decisions where the spec does not prescribe one: missing/invalid Google credentials = 401; request/verified-email mismatch = 400; tokeninfo network/5xx failure = 503; malformed/non-success tokeninfo credentials = 401. Identity/unique conflicts = 409; known-good JWT but missing account = 401; account-store failure = 503. Protected unknown PATCH fields remain stripped by Zod for compatibility.
- Local PostgreSQL tests are mandatory release acceptance, not replaceable with mocks. Ordinary `npm test` skips the local-only suite without `PHASE1_PG_URL`; the final acceptance command supplies it. Docker/psql binaries exist in the inspected environment; daemon/image availability has not been tested. If unavailable, stop acceptance and obtain an isolated local PostgreSQL instance rather than use production.

## Tasks

### Task 1: Check the immutable migration baseline

- [ ] Run:

```bash
git status --short
node --input-type=module - <<'JS'
import assert from "node:assert/strict";
import fs from "node:fs";
const j = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8"));
assert.equal(j.entries.at(-1).tag, "0005_tidy_ultimates");
assert.equal(fs.existsSync("drizzle/0006_google_identity_binding.sql"), false);
console.log("MIGRATION_BASELINE_OK");
JS
```

Expected: `MIGRATION_BASELINE_OK`, exit 0; no implementation changes already present. If migration 0006 now exists, STOP and have this plan rebased to the next sequence; never overwrite another migration. Preserve any unrelated working-tree changes.

### Task 2: Add the durable subject column to the schema

- [ ] Apply this exact diff to `src/database/schema.ts` (acceptance: only the displayed hunks change):

```diff
--- a/src/database/schema.ts
+++ b/src/database/schema.ts
@@ -1,11 +1,12 @@
 import { pgTable, varchar, text, integer, smallint, real, boolean, timestamp, uuid, jsonb, bigint, uniqueIndex, index } from 'drizzle-orm/pg-core';
 
 // 1. جدول المستخدمين (Users Table)
-// externalId = stable client identity (mobile `google_<id>`). Auto-provisioned
-// on first sync so offline-first clients never need a prior signup call.
+// Production identity is google_<verified subject>; sync cannot create accounts.
+// googleSubject is the permanent verified-identity anchor, not a migration aid.
 export const users = pgTable('users', {
   id: uuid('id').defaultRandom().primaryKey(),
   externalId: varchar('external_id', { length: 255 }).unique(),
+  googleSubject: varchar('google_subject', { length: 255 }).unique(),
   email: varchar('email', { length: 255 }).unique(),
   username: varchar('username', { length: 100 }).unique(),
   displayName: varchar('display_name', { length: 100 }),
```


### Task 3: Create drizzle/0006_google_identity_binding.sql

- [ ] Create `drizzle/0006_google_identity_binding.sql` with this complete content (acceptance: file matches this block):

```sql
ALTER TABLE "users" ADD COLUMN "google_subject" varchar(255);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_google_subject_unique" UNIQUE("google_subject");
```


### Task 4: Register migration 0006

- [ ] Apply this exact diff to `drizzle/meta/_journal.json` (acceptance: only the displayed hunks change):

```diff
--- a/drizzle/meta/_journal.json
+++ b/drizzle/meta/_journal.json
@@ -43,6 +43,13 @@
       "when": 1789555576197,
       "tag": "0005_tidy_ultimates",
       "breakpoints": true
+    },
+    {
+      "idx": 6,
+      "version": "7",
+      "when": 1789603200000,
+      "tag": "0006_google_identity_binding",
+      "breakpoints": true
     }
   ]
-}
\ No newline at end of file
+}
```


### Task 5: Record the complete schema snapshot

- [ ] Create `drizzle/meta/0006_snapshot.json` with this complete content (acceptance: file matches this block):

```json
{
  "id": "c0a86b47-60d1-4ef8-a67a-6d85f2e922f0",
  "prevId": "501aa25d-996f-4d40-b700-0f3ed993c3d6",
  "version": "7",
  "dialect": "postgresql",
  "tables": {
    "public.author_api_keys": {
      "name": "author_api_keys",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true,
          "default": "gen_random_uuid()"
        },
        "user_id": {
          "name": "user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "name": {
          "name": "name",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true
        },
        "key_prefix": {
          "name": "key_prefix",
          "type": "varchar(16)",
          "primaryKey": false,
          "notNull": true
        },
        "key_hash": {
          "name": "key_hash",
          "type": "varchar(64)",
          "primaryKey": false,
          "notNull": true
        },
        "scopes": {
          "name": "scopes",
          "type": "jsonb",
          "primaryKey": false,
          "notNull": true,
          "default": "'[\"novels:write\"]'::jsonb"
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "last_used_at": {
          "name": "last_used_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": false
        },
        "revoked_at": {
          "name": "revoked_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {},
      "foreignKeys": {
        "author_api_keys_user_id_users_id_fk": {
          "name": "author_api_keys_user_id_users_id_fk",
          "tableFrom": "author_api_keys",
          "tableTo": "users",
          "columnsFrom": [
            "user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {
        "author_api_keys_key_hash_unique": {
          "name": "author_api_keys_key_hash_unique",
          "nullsNotDistinct": false,
          "columns": [
            "key_hash"
          ]
        }
      },
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.chapters": {
      "name": "chapters",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "integer",
          "primaryKey": true,
          "notNull": true,
          "identity": {
            "type": "always",
            "name": "chapters_id_seq",
            "schema": "public",
            "increment": "1",
            "startWith": "1",
            "minValue": "1",
            "maxValue": "2147483647",
            "cache": "1",
            "cycle": false
          }
        },
        "novel_id": {
          "name": "novel_id",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true
        },
        "chapter_number": {
          "name": "chapter_number",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "title": {
          "name": "title",
          "type": "varchar(255)",
          "primaryKey": false,
          "notNull": true
        },
        "content_raw": {
          "name": "content_raw",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "word_count": {
          "name": "word_count",
          "type": "integer",
          "primaryKey": false,
          "notNull": false,
          "default": 0
        },
        "views_count": {
          "name": "views_count",
          "type": "integer",
          "primaryKey": false,
          "notNull": false,
          "default": 0
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {
        "novel_chapter_idx": {
          "name": "novel_chapter_idx",
          "columns": [
            {
              "expression": "novel_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "chapter_number",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": true,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {
        "chapters_novel_id_novels_id_fk": {
          "name": "chapters_novel_id_novels_id_fk",
          "tableFrom": "chapters",
          "tableTo": "novels",
          "columnsFrom": [
            "novel_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.comment_mod_log": {
      "name": "comment_mod_log",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "bigint",
          "primaryKey": true,
          "notNull": true,
          "identity": {
            "type": "always",
            "name": "comment_mod_log_id_seq",
            "schema": "public",
            "increment": "1",
            "startWith": "1",
            "minValue": "1",
            "maxValue": "9223372036854775807",
            "cache": "1",
            "cycle": false
          }
        },
        "comment_id": {
          "name": "comment_id",
          "type": "bigint",
          "primaryKey": false,
          "notNull": true
        },
        "action": {
          "name": "action",
          "type": "varchar(20)",
          "primaryKey": false,
          "notNull": true
        },
        "actor_id": {
          "name": "actor_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": false
        },
        "reason": {
          "name": "reason",
          "type": "varchar(500)",
          "primaryKey": false,
          "notNull": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {
        "comment_mod_log_comment_id_comments_id_fk": {
          "name": "comment_mod_log_comment_id_comments_id_fk",
          "tableFrom": "comment_mod_log",
          "tableTo": "comments",
          "columnsFrom": [
            "comment_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        },
        "comment_mod_log_actor_id_users_id_fk": {
          "name": "comment_mod_log_actor_id_users_id_fk",
          "tableFrom": "comment_mod_log",
          "tableTo": "users",
          "columnsFrom": [
            "actor_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "set null",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.comment_votes": {
      "name": "comment_votes",
      "schema": "",
      "columns": {
        "comment_id": {
          "name": "comment_id",
          "type": "bigint",
          "primaryKey": false,
          "notNull": true
        },
        "user_id": {
          "name": "user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "value": {
          "name": "value",
          "type": "smallint",
          "primaryKey": false,
          "notNull": true,
          "default": 1
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {
        "comment_votes_pkey": {
          "name": "comment_votes_pkey",
          "columns": [
            {
              "expression": "comment_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "user_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": true,
          "concurrently": false,
          "method": "btree",
          "with": {}
        },
        "comment_votes_user": {
          "name": "comment_votes_user",
          "columns": [
            {
              "expression": "user_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "comment_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {
        "comment_votes_comment_id_comments_id_fk": {
          "name": "comment_votes_comment_id_comments_id_fk",
          "tableFrom": "comment_votes",
          "tableTo": "comments",
          "columnsFrom": [
            "comment_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        },
        "comment_votes_user_id_users_id_fk": {
          "name": "comment_votes_user_id_users_id_fk",
          "tableFrom": "comment_votes",
          "tableTo": "users",
          "columnsFrom": [
            "user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.comments": {
      "name": "comments",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "bigint",
          "primaryKey": true,
          "notNull": true,
          "identity": {
            "type": "always",
            "name": "comments_id_seq",
            "schema": "public",
            "increment": "1",
            "startWith": "1",
            "minValue": "1",
            "maxValue": "9223372036854775807",
            "cache": "1",
            "cycle": false
          }
        },
        "novel_id": {
          "name": "novel_id",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true
        },
        "chapter_number": {
          "name": "chapter_number",
          "type": "integer",
          "primaryKey": false,
          "notNull": false
        },
        "user_id": {
          "name": "user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": false
        },
        "parent_id": {
          "name": "parent_id",
          "type": "bigint",
          "primaryKey": false,
          "notNull": false
        },
        "root_id": {
          "name": "root_id",
          "type": "bigint",
          "primaryKey": false,
          "notNull": false
        },
        "depth": {
          "name": "depth",
          "type": "smallint",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "body": {
          "name": "body",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "body_hash": {
          "name": "body_hash",
          "type": "varchar(64)",
          "primaryKey": false,
          "notNull": true
        },
        "status": {
          "name": "status",
          "type": "varchar(20)",
          "primaryKey": false,
          "notNull": true,
          "default": "'visible'"
        },
        "likes_count": {
          "name": "likes_count",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "replies_count": {
          "name": "replies_count",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "reports_count": {
          "name": "reports_count",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "edit_count": {
          "name": "edit_count",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "updated_at": {
          "name": "updated_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "edited_at": {
          "name": "edited_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        },
        "deleted_at": {
          "name": "deleted_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        },
        "decided_by": {
          "name": "decided_by",
          "type": "uuid",
          "primaryKey": false,
          "notNull": false
        },
        "decided_reason": {
          "name": "decided_reason",
          "type": "varchar(500)",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {
        "comments_roots_new": {
          "name": "comments_roots_new",
          "columns": [
            {
              "expression": "novel_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "chapter_number",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "created_at",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        },
        "comments_roots_top": {
          "name": "comments_roots_top",
          "columns": [
            {
              "expression": "novel_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "chapter_number",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "likes_count",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        },
        "comments_thread": {
          "name": "comments_thread",
          "columns": [
            {
              "expression": "root_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "created_at",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        },
        "comments_parent": {
          "name": "comments_parent",
          "columns": [
            {
              "expression": "parent_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "created_at",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        },
        "comments_user": {
          "name": "comments_user",
          "columns": [
            {
              "expression": "user_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "created_at",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": false,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {
        "comments_novel_id_novels_id_fk": {
          "name": "comments_novel_id_novels_id_fk",
          "tableFrom": "comments",
          "tableTo": "novels",
          "columnsFrom": [
            "novel_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        },
        "comments_user_id_users_id_fk": {
          "name": "comments_user_id_users_id_fk",
          "tableFrom": "comments",
          "tableTo": "users",
          "columnsFrom": [
            "user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "set null",
          "onUpdate": "no action"
        },
        "comments_decided_by_users_id_fk": {
          "name": "comments_decided_by_users_id_fk",
          "tableFrom": "comments",
          "tableTo": "users",
          "columnsFrom": [
            "decided_by"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "set null",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.cover_blobs": {
      "name": "cover_blobs",
      "schema": "",
      "columns": {
        "filename": {
          "name": "filename",
          "type": "varchar(255)",
          "primaryKey": true,
          "notNull": true
        },
        "mime": {
          "name": "mime",
          "type": "varchar(50)",
          "primaryKey": false,
          "notNull": true
        },
        "data_base64": {
          "name": "data_base64",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.novels": {
      "name": "novels",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "varchar(100)",
          "primaryKey": true,
          "notNull": true
        },
        "title": {
          "name": "title",
          "type": "varchar(255)",
          "primaryKey": false,
          "notNull": true
        },
        "original_title": {
          "name": "original_title",
          "type": "varchar(255)",
          "primaryKey": false,
          "notNull": false
        },
        "author": {
          "name": "author",
          "type": "varchar(150)",
          "primaryKey": false,
          "notNull": true
        },
        "translator": {
          "name": "translator",
          "type": "varchar(150)",
          "primaryKey": false,
          "notNull": false
        },
        "status": {
          "name": "status",
          "type": "varchar(50)",
          "primaryKey": false,
          "notNull": true,
          "default": "'\u0645\u0633\u062a\u0645\u0631\u0629'"
        },
        "category": {
          "name": "category",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true
        },
        "tags": {
          "name": "tags",
          "type": "jsonb",
          "primaryKey": false,
          "notNull": true,
          "default": "'[]'::jsonb"
        },
        "rating": {
          "name": "rating",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 50
        },
        "readers_count": {
          "name": "readers_count",
          "type": "varchar(50)",
          "primaryKey": false,
          "notNull": true,
          "default": "'0'"
        },
        "total_chapters": {
          "name": "total_chapters",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "cover_url": {
          "name": "cover_url",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "summary": {
          "name": "summary",
          "type": "text",
          "primaryKey": false,
          "notNull": true
        },
        "featured_rank": {
          "name": "featured_rank",
          "type": "integer",
          "primaryKey": false,
          "notNull": false
        },
        "author_user_id": {
          "name": "author_user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": false
        },
        "translator_user_id": {
          "name": "translator_user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "updated_at": {
          "name": "updated_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {
        "novels_author_user_id_users_id_fk": {
          "name": "novels_author_user_id_users_id_fk",
          "tableFrom": "novels",
          "tableTo": "users",
          "columnsFrom": [
            "author_user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "set null",
          "onUpdate": "no action"
        },
        "novels_translator_user_id_users_id_fk": {
          "name": "novels_translator_user_id_users_id_fk",
          "tableFrom": "novels",
          "tableTo": "users",
          "columnsFrom": [
            "translator_user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "set null",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.reading_history": {
      "name": "reading_history",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "integer",
          "primaryKey": true,
          "notNull": true,
          "identity": {
            "type": "always",
            "name": "reading_history_id_seq",
            "schema": "public",
            "increment": "1",
            "startWith": "1",
            "minValue": "1",
            "maxValue": "2147483647",
            "cache": "1",
            "cycle": false
          }
        },
        "user_id": {
          "name": "user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "novel_id": {
          "name": "novel_id",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true
        },
        "novel_title": {
          "name": "novel_title",
          "type": "varchar(255)",
          "primaryKey": false,
          "notNull": true,
          "default": "''"
        },
        "novel_cover": {
          "name": "novel_cover",
          "type": "text",
          "primaryKey": false,
          "notNull": true,
          "default": "''"
        },
        "novel_author": {
          "name": "novel_author",
          "type": "varchar(150)",
          "primaryKey": false,
          "notNull": true,
          "default": "''"
        },
        "category": {
          "name": "category",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true,
          "default": "''"
        },
        "source_id": {
          "name": "source_id",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": false
        },
        "chapter_id": {
          "name": "chapter_id",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "chapter_number": {
          "name": "chapter_number",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "chapter_title": {
          "name": "chapter_title",
          "type": "varchar(255)",
          "primaryKey": false,
          "notNull": true,
          "default": "''"
        },
        "progress_percent": {
          "name": "progress_percent",
          "type": "real",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "read_day": {
          "name": "read_day",
          "type": "varchar(10)",
          "primaryKey": false,
          "notNull": true
        },
        "read_at": {
          "name": "read_at",
          "type": "bigint",
          "primaryKey": false,
          "notNull": true
        },
        "updated_at": {
          "name": "updated_at",
          "type": "bigint",
          "primaryKey": false,
          "notNull": true
        },
        "received_at": {
          "name": "received_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {
        "history_user_novel_chapter_idx": {
          "name": "history_user_novel_chapter_idx",
          "columns": [
            {
              "expression": "user_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "novel_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "chapter_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": true,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {
        "reading_history_user_id_users_id_fk": {
          "name": "reading_history_user_id_users_id_fk",
          "tableFrom": "reading_history",
          "tableTo": "users",
          "columnsFrom": [
            "user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.reading_sessions": {
      "name": "reading_sessions",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "integer",
          "primaryKey": true,
          "notNull": true,
          "identity": {
            "type": "always",
            "name": "reading_sessions_id_seq",
            "schema": "public",
            "increment": "1",
            "startWith": "1",
            "minValue": "1",
            "maxValue": "2147483647",
            "cache": "1",
            "cycle": false
          }
        },
        "user_id": {
          "name": "user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "client_session_id": {
          "name": "client_session_id",
          "type": "varchar(64)",
          "primaryKey": false,
          "notNull": true
        },
        "novel_id": {
          "name": "novel_id",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true
        },
        "chapter_id": {
          "name": "chapter_id",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "seconds": {
          "name": "seconds",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "words": {
          "name": "words",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "minute_of_day": {
          "name": "minute_of_day",
          "type": "integer",
          "primaryKey": false,
          "notNull": true
        },
        "read_day": {
          "name": "read_day",
          "type": "varchar(10)",
          "primaryKey": false,
          "notNull": true
        },
        "genre": {
          "name": "genre",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true,
          "default": "''"
        },
        "ts": {
          "name": "ts",
          "type": "bigint",
          "primaryKey": false,
          "notNull": true
        },
        "received_at": {
          "name": "received_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {
        "sessions_user_client_idx": {
          "name": "sessions_user_client_idx",
          "columns": [
            {
              "expression": "user_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "client_session_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": true,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {
        "reading_sessions_user_id_users_id_fk": {
          "name": "reading_sessions_user_id_users_id_fk",
          "tableFrom": "reading_sessions",
          "tableTo": "users",
          "columnsFrom": [
            "user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.role_requests": {
      "name": "role_requests",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "integer",
          "primaryKey": true,
          "notNull": true,
          "identity": {
            "type": "always",
            "name": "role_requests_id_seq",
            "schema": "public",
            "increment": "1",
            "startWith": "1",
            "minValue": "1",
            "maxValue": "2147483647",
            "cache": "1",
            "cycle": false
          }
        },
        "user_id": {
          "name": "user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "kind": {
          "name": "kind",
          "type": "varchar(20)",
          "primaryKey": false,
          "notNull": true
        },
        "status": {
          "name": "status",
          "type": "varchar(20)",
          "primaryKey": false,
          "notNull": true,
          "default": "'pending'"
        },
        "note": {
          "name": "note",
          "type": "varchar(500)",
          "primaryKey": false,
          "notNull": false
        },
        "decided_by": {
          "name": "decided_by",
          "type": "uuid",
          "primaryKey": false,
          "notNull": false
        },
        "decided_at": {
          "name": "decided_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {
        "user_kind_pending_idx": {
          "name": "user_kind_pending_idx",
          "columns": [
            {
              "expression": "user_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "kind",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "status",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": true,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {
        "role_requests_user_id_users_id_fk": {
          "name": "role_requests_user_id_users_id_fk",
          "tableFrom": "role_requests",
          "tableTo": "users",
          "columnsFrom": [
            "user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        },
        "role_requests_decided_by_users_id_fk": {
          "name": "role_requests_decided_by_users_id_fk",
          "tableFrom": "role_requests",
          "tableTo": "users",
          "columnsFrom": [
            "decided_by"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "set null",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.user_categories": {
      "name": "user_categories",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "integer",
          "primaryKey": true,
          "notNull": true,
          "identity": {
            "type": "always",
            "name": "user_categories_id_seq",
            "schema": "public",
            "increment": "1",
            "startWith": "1",
            "minValue": "1",
            "maxValue": "2147483647",
            "cache": "1",
            "cycle": false
          }
        },
        "user_id": {
          "name": "user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "name": {
          "name": "name",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true
        },
        "order_index": {
          "name": "order_index",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "is_system_default": {
          "name": "is_system_default",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {
        "user_categories_user_id_users_id_fk": {
          "name": "user_categories_user_id_users_id_fk",
          "tableFrom": "user_categories",
          "tableTo": "users",
          "columnsFrom": [
            "user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.user_library": {
      "name": "user_library",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "integer",
          "primaryKey": true,
          "notNull": true,
          "identity": {
            "type": "always",
            "name": "user_library_id_seq",
            "schema": "public",
            "increment": "1",
            "startWith": "1",
            "minValue": "1",
            "maxValue": "2147483647",
            "cache": "1",
            "cycle": false
          }
        },
        "user_id": {
          "name": "user_id",
          "type": "uuid",
          "primaryKey": false,
          "notNull": true
        },
        "novel_id": {
          "name": "novel_id",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": true
        },
        "source_id": {
          "name": "source_id",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": false
        },
        "category_ids": {
          "name": "category_ids",
          "type": "jsonb",
          "primaryKey": false,
          "notNull": true,
          "default": "'[]'::jsonb"
        },
        "last_read_chapter_id": {
          "name": "last_read_chapter_id",
          "type": "integer",
          "primaryKey": false,
          "notNull": false
        },
        "last_read_chapter_number": {
          "name": "last_read_chapter_number",
          "type": "integer",
          "primaryKey": false,
          "notNull": false
        },
        "last_read_chapter_title": {
          "name": "last_read_chapter_title",
          "type": "varchar(255)",
          "primaryKey": false,
          "notNull": false
        },
        "progress_percent": {
          "name": "progress_percent",
          "type": "real",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "last_read_at": {
          "name": "last_read_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": false
        },
        "added_at": {
          "name": "added_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "updated_at": {
          "name": "updated_at",
          "type": "bigint",
          "primaryKey": false,
          "notNull": true
        },
        "deleted_at": {
          "name": "deleted_at",
          "type": "bigint",
          "primaryKey": false,
          "notNull": false
        },
        "received_at": {
          "name": "received_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {
        "user_library_idx": {
          "name": "user_library_idx",
          "columns": [
            {
              "expression": "user_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            },
            {
              "expression": "novel_id",
              "isExpression": false,
              "asc": true,
              "nulls": "last"
            }
          ],
          "isUnique": true,
          "concurrently": false,
          "method": "btree",
          "with": {}
        }
      },
      "foreignKeys": {
        "user_library_user_id_users_id_fk": {
          "name": "user_library_user_id_users_id_fk",
          "tableFrom": "user_library",
          "tableTo": "users",
          "columnsFrom": [
            "user_id"
          ],
          "columnsTo": [
            "id"
          ],
          "onDelete": "cascade",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.users": {
      "name": "users",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true,
          "default": "gen_random_uuid()"
        },
        "external_id": {
          "name": "external_id",
          "type": "varchar(255)",
          "primaryKey": false,
          "notNull": false
        },
        "email": {
          "name": "email",
          "type": "varchar(255)",
          "primaryKey": false,
          "notNull": false
        },
        "username": {
          "name": "username",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": false
        },
        "display_name": {
          "name": "display_name",
          "type": "varchar(100)",
          "primaryKey": false,
          "notNull": false
        },
        "password_hash": {
          "name": "password_hash",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "avatar_url": {
          "name": "avatar_url",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "banner_url": {
          "name": "banner_url",
          "type": "text",
          "primaryKey": false,
          "notNull": false
        },
        "role": {
          "name": "role",
          "type": "varchar(20)",
          "primaryKey": false,
          "notNull": true,
          "default": "'reader'"
        },
        "is_author": {
          "name": "is_author",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "is_translator": {
          "name": "is_translator",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "updated_at": {
          "name": "updated_at",
          "type": "timestamp",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "google_subject": {
          "name": "google_subject",
          "type": "varchar(255)",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {},
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {
        "users_external_id_unique": {
          "name": "users_external_id_unique",
          "nullsNotDistinct": false,
          "columns": [
            "external_id"
          ]
        },
        "users_email_unique": {
          "name": "users_email_unique",
          "nullsNotDistinct": false,
          "columns": [
            "email"
          ]
        },
        "users_username_unique": {
          "name": "users_username_unique",
          "nullsNotDistinct": false,
          "columns": [
            "username"
          ]
        },
        "users_google_subject_unique": {
          "name": "users_google_subject_unique",
          "nullsNotDistinct": false,
          "columns": [
            "google_subject"
          ]
        }
      },
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    }
  },
  "enums": {},
  "schemas": {},
  "sequences": {},
  "roles": {},
  "policies": {},
  "views": {},
  "_meta": {
    "columns": {},
    "schemas": {},
    "tables": {}
  }
}
```


### Task 6: Validate and commit only the schema milestone

- [ ] Run:

```bash
npm run typecheck && npx drizzle-kit check && git diff --check
git add src/database/schema.ts drizzle/0006_google_identity_binding.sql drizzle/meta/_journal.json drizzle/meta/0006_snapshot.json
git commit -m "feat(auth): add permanent Google subject binding"
```

Expected: TypeScript and Drizzle check exit 0, no whitespace errors; commit contains exactly these four files. This does not apply migrations to any database.

### Task 7: Create src/routes/googleIdentity.test.ts

- [ ] Create `src/routes/googleIdentity.test.ts` with this complete content (acceptance: file matches this block):

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyGoogleIdToken } from './googleIdentity.js';

const good = () => ({ sub: 'subject-1', email: 'Reader@Test.com', aud: 'web-client',
  iss: 'https://accounts.google.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 600) });
beforeEach(() => {
  vi.stubGlobal('__WORKER_ENV__', undefined);
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('GOOGLE_WEB_CLIENT_ID', 'web-client');
  vi.stubEnv('GOOGLE_ANDROID_CLIENT_ID', '');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(good())));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('verified tokeninfo boundary', () => {
  it.each([true, 'true'])('accepts only normalized true: %s', async (value) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...good(), email_verified: value }));
    await expect(verifyGoogleIdToken('fixture-token')).resolves.toEqual({ sub: 'subject-1', email: 'reader@test.com' });
  });
  it('accepts the other documented issuer', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...good(), iss: 'accounts.google.com' }));
    await expect(verifyGoogleIdToken('fixture-token')).resolves.toHaveProperty('sub', 'subject-1');
  });
  it.each(['sub', 'email', 'aud', 'iss', 'exp', 'email_verified'])('rejects missing %s', async (field) => {
    const value: Record<string, unknown> = good(); delete value[field];
    vi.mocked(fetch).mockResolvedValue(Response.json(value));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    ['sub', ''], ['sub', ' '], ['email', 'invalid'], ['aud', 'wrong'], ['iss', 'wrong'],
    ['email_verified', false], ['email_verified', 'false'], ['email_verified', 'TRUE'],
    ['email_verified', 1], ['exp', '0'], ['exp', 'bad'], ['exp', -1], ['exp', null],
  ])('rejects malformed %s=%s', async (field, value) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...good(), [field as string]: value }));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 401 });
  });
  it('rejects an empty audience allowlist', async () => {
    vi.stubEnv('GOOGLE_WEB_CLIENT_ID', '');
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 401 });
  });
  it('rejects malformed JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{'));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 401 });
  });
  it.each([400, 401, 500, 503, 429])('fails closed on upstream %s', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status }));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: status >= 500 || status === 429 ? 503 : 401 });
  });
  it('fails closed on network errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('private upstream diagnostics'));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 503 });
  });
});
```


### Task 8: Observe the claim-test red baseline

- [ ] Run:

```bash
npm test -- src/routes/googleIdentity.test.ts
```

Expected: FAIL because `./googleIdentity.js` does not exist yet; do not accept unrelated setup errors as the intended red result.

### Task 9: Create src/routes/googleIdentity.ts

- [ ] Create `src/routes/googleIdentity.ts` with this complete content (acceptance: file matches this block):

```typescript
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { getEnv } from '../config/env.js';

export type VerifiedGoogleIdentity = { sub: string; email: string };
const claims = z.object({
  sub: z.string().min(1).max(248).refine((v) => v.trim() === v && v.trim().length > 0),
  email: z.string().trim().toLowerCase().email().max(255),
  aud: z.string().min(1),
  iss: z.enum(['accounts.google.com', 'https://accounts.google.com']),
  email_verified: z.union([z.literal(true), z.literal('true')]),
  exp: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .refine((v) => Number.isSafeInteger(v) && v > Date.now() / 1000),
});

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleIdentity> {
  if (!idToken.trim()) throw new HTTPException(401, { message: 'invalid Google credentials' });
  const env = getEnv();
  const audiences = [env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_ANDROID_CLIENT_ID]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  let response: Response;
  try {
    response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HTTPException(503, { message: 'identity service unavailable' });
  }
  if (response.status >= 500 || response.status === 429) {
    throw new HTTPException(503, { message: 'identity service unavailable' });
  }
  if (!response.ok) throw new HTTPException(401, { message: 'invalid Google credentials' });
  const parsed = claims.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !audiences.includes(parsed.data.aud)) {
    throw new HTTPException(401, { message: 'invalid Google credentials' });
  }
  return { sub: parsed.data.sub, email: parsed.data.email };
}
```


### Task 10: Verify the claim boundary

- [ ] Run:

```bash
npm test -- src/routes/googleIdentity.test.ts
```

Expected: all claim cases pass, exit 0; fetch is mocked, with no Google/network credentials.

### Task 11: Create src/routes/googleAccount.ts

- [ ] Create `src/routes/googleAccount.ts` with this complete content (acceptance: file matches this block):

```typescript
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Db } from '../database/db.js';
import { users } from '../database/schema.js';
import type { VerifiedGoogleIdentity } from './googleIdentity.js';

export function isUniqueConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

export function cleanMediaUrl(url?: string | null): string | undefined {
  if (typeof url !== 'string') return undefined;
  const value = url.trim();
  return /^https?:\/\//i.test(value) ? value.slice(0, 2000) : undefined;
}

type DisplayInput = { name?: string; username?: string; avatarUrl?: string; bannerUrl?: string };
export async function resolveGoogleAccount(database: Db, identity: VerifiedGoogleIdentity,
  input: DisplayInput, bootstrapAdmin: boolean, requestId: string) {
  const externalId = `google_${identity.sub}`;
  const find = async () => (await database.select().from(users)
    .where(eq(users.googleSubject, identity.sub)).limit(1))[0];
  const assertCanonical = (row: typeof users.$inferSelect) => {
    if (row.externalId !== externalId) throw new HTTPException(409, { message: 'account identity conflict' });
    return row;
  };
  let row = await find();
  if (!row) {
    try {
      const displayName = input.name || input.username || identity.email.split('@')[0];
      const inserted = await database.insert(users).values({
        externalId, googleSubject: identity.sub, email: identity.email,
        username: (input.username || displayName).slice(0, 100),
        displayName: displayName.slice(0, 100),
        avatarUrl: cleanMediaUrl(input.avatarUrl) ?? null,
        bannerUrl: cleanMediaUrl(input.bannerUrl) ?? null,
        role: bootstrapAdmin ? 'admin' : 'reader',
      }).returning();
      row = inserted[0];
      if (!row) throw new Error('account insert returned no row');
      console.info(JSON.stringify({ event: 'account.provisioned', requestId, accountId: row.id, outcome: 'created' }));
      return assertCanonical(row);
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
  }
  assertCanonical(row);
  const patch: Partial<typeof users.$inferInsert> = {};
  if (row.email !== identity.email) patch.email = identity.email;
  if (bootstrapAdmin && row.role !== 'admin') patch.role = 'admin';
  if (!cleanMediaUrl(row.avatarUrl) && cleanMediaUrl(input.avatarUrl)) patch.avatarUrl = cleanMediaUrl(input.avatarUrl);
  if (!cleanMediaUrl(row.bannerUrl) && cleanMediaUrl(input.bannerUrl)) patch.bannerUrl = cleanMediaUrl(input.bannerUrl);
  if (Object.keys(patch).length === 0) return row;
  try {
    const updated = await database.update(users).set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, row.id)).returning();
    if (!updated[0]) throw new HTTPException(401, { message: 'account not found' });
    return updated[0];
  } catch (error) {
    if (isUniqueConflict(error)) throw new HTTPException(409, { message: 'account identity conflict' });
    throw error;
  }
}
```


### Task 12: Bind login and profile routes to verified durable identity

- [ ] Apply this exact diff to `src/routes/auth.ts` (acceptance: only the displayed hunks change):

```diff
--- a/src/routes/auth.ts
+++ b/src/routes/auth.ts
@@ -1,6 +1,9 @@
 import { Hono } from 'hono';
 import { z } from 'zod';
-import { eq, or } from 'drizzle-orm';
+import { eq } from 'drizzle-orm';
+import { HTTPException } from 'hono/http-exception';
+import { verifyGoogleIdToken } from './googleIdentity.js';
+import { cleanMediaUrl, isUniqueConflict, resolveGoogleAccount } from './googleAccount.js';
 import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
 import { users } from '../database/schema.js';
 import { requireAuth, signToken } from '../middleware/auth.js';
@@ -8,7 +11,7 @@
 
 export const authRouter = new Hono();
 
-// Fallback when DB is unavailable
+// Explicit development/test fixtures only. Never consult these in production.
 const memUsers: any[] = [];
 
 const googleSchema = z.object({
@@ -24,36 +27,6 @@
 // Client display name / handle rules (mirrors the mobile app).
 const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
 
-// Only remote URLs are ever persisted. Mobile clients historically sent
-// device file URIs (file://, content://) that die with the device —
-// storing them poisons the cross-install restore path, so they are
-// dropped (never 400: old clients still send them).
-function cleanMediaUrl(url?: string | null): string | undefined {
-  if (typeof url !== 'string') return undefined;
-  const v = url.trim();
-  return /^https?:\/\//i.test(v) ? v.slice(0, 2000) : undefined;
-}
-
-/** Keep a stored remote URL; adopt an incoming remote URL when the stored
- *  one is missing or a dead device URI; never write device URIs. */
-function keepRemoteOrHeal(stored?: string | null, incoming?: string | null): string | null | undefined {
-  if (cleanMediaUrl(stored)) return undefined; // keep stored (no write)
-  const fresh = cleanMediaUrl(incoming);
-  return fresh ?? undefined; // adopt remote, or leave untouched
-}
-
-async function verifyGoogleIdToken(idToken?: string): Promise<{ verified: boolean; email?: string; aud?: string }> {
-  if (!idToken) return { verified: false };
-  try {
-    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
-    if (!res.ok) return { verified: false };
-    const info: any = await res.json();
-    return { verified: true, email: info.email, aud: info.aud };
-  } catch {
-    return { verified: false };
-  }
-}
-
 function toPublic(u: any) {
   return {
     id: u.externalId ?? u.id, externalId: u.externalId ?? u.id, email: u.email,
@@ -64,122 +37,76 @@
   };
 }
 
-// POST /api/v1/auth/google
+function accountError(c: import('hono').Context, error: unknown) {
+  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
+  if (isUniqueConflict(error)) return c.json({ error: 'account identity conflict' }, 409);
+  noteDbFailure();
+  console.warn(JSON.stringify({ event: 'account.storage', requestId: c.get('requestId') ?? 'no-id', outcome: 'unavailable' }));
+  return c.json({ error: 'account storage unavailable' }, 503);
+}
+
+// POST /api/v1/auth/google: client googleId never determines identity.
 authRouter.post('/google', async (c) => {
   const parsed = googleSchema.safeParse(await c.req.json().catch(() => null));
-  if (!parsed.success) return c.json({ error: 'البريد الإلكتروني مطلوب لتسجيل الدخول بحساب Google', issues: parsed.error.issues }, 400);
-  const { name, username, email, avatarUrl, bannerUrl, googleId, idToken } = parsed.data;
+  if (!parsed.success) return c.json({ error: 'invalid Google login payload' }, 400);
+  const input = parsed.data;
   const env = getEnv();
-
-  if (env.isProd && (!env.JWT_SECRET || env.JWT_SECRET.startsWith('web-novel-dev-') || env.JWT_SECRET === 'change-me-in-production')) {
-    return c.json({ error: 'تسجيل الدخول غير مهيأ في بيئة الإنتاج: JWT_SECRET غير مضبوط' }, 501);
+  const requestEmail = input.email.trim().toLowerCase();
+  try {
+    const identity = input.idToken !== undefined ? await verifyGoogleIdToken(input.idToken) : null;
+    if (!identity && env.isProd) return c.json({ error: 'Google token required' }, 401);
+    if (identity && identity.email !== requestEmail) return c.json({ error: 'Google email mismatch' }, 400);
+    const email = identity?.email ?? requestEmail;
+    const externalId = identity ? `google_${identity.sub}` : `dev_${email}`;
+    const bootstrapAdmin = adminEmails().includes(email);
+    if (identity && isDbAvailable()) {
+      const row = await resolveGoogleAccount(db, identity, input, bootstrapAdmin, c.get('requestId') ?? crypto.randomUUID());
+      const token = await signToken({ id: row.externalId!, email: row.email!, role: row.role });
+      return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user: toPublic(row), token });
+    }
+    if (env.isProd) return c.json({ error: 'account storage unavailable' }, 503);
+    // Absent-token fixtures cannot read or write persistent accounts even if a DB exists.
+    let user = memUsers.find((u) => u.externalId === externalId);
+    if (!user) {
+      const displayName = input.name || input.username || email.split('@')[0];
+      user = { id: externalId, externalId, googleSubject: identity?.sub ?? null, email,
+        displayName, username: input.username || displayName,
+        avatarUrl: cleanMediaUrl(input.avatarUrl) ?? null, bannerUrl: cleanMediaUrl(input.bannerUrl) ?? null,
+        role: bootstrapAdmin ? 'admin' : 'reader' };
+      memUsers.push(user);
+    } else {
+      user.email = email;
+      if (bootstrapAdmin) user.role = 'admin';
+      if (input.name) user.displayName = input.name;
+      if (input.username) user.username = input.username;
+      if (!cleanMediaUrl(user.avatarUrl)) user.avatarUrl = cleanMediaUrl(input.avatarUrl) ?? user.avatarUrl;
+      if (!cleanMediaUrl(user.bannerUrl)) user.bannerUrl = cleanMediaUrl(input.bannerUrl) ?? user.bannerUrl;
+    }
+    const token = await signToken({ id: user.externalId, email: user.email, role: user.role });
+    return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user: toPublic(user), token });
+  } catch (error) {
+    return accountError(c, error);
   }
-
-  const check = await verifyGoogleIdToken(idToken);
-  if (!idToken) {
-    if (env.isProd) return c.json({ error: 'رمز Google مطلوب لتسجيل الدخول' }, 400);
-  } else {
-    if (!check.verified) {
-      if (env.isProd) return c.json({ error: 'تعذر التحقق من هوية Google' }, 401);
-      console.warn(`[dev] idToken verification skipped for ${email}; trusting email only`);
-    } else {
-      const allowedAud = [env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_ANDROID_CLIENT_ID].filter(Boolean) as string[];
-      if (allowedAud.length > 0 && check.aud && !allowedAud.includes(check.aud)) {
-        return c.json({ error: 'رمز Google صادر لتطبيق آخر' }, 401);
-      }
-      if (check.email && check.email.toLowerCase() !== email.toLowerCase()) {
-        return c.json({ error: 'عدم تطابق البريد الإلكتروني في رمز Google' }, 400);
-      }
-    }
-  }
-
-  const externalId = `google_${googleId || email.toLowerCase()}`;
-  const displayName = name || username || email.split('@')[0];
-
-  if (isDbAvailable()) {
-    try {
-      const found = await db.select().from(users).where(or(eq(users.externalId, externalId), eq(users.email, email.toLowerCase()))).limit(1);
-      let row = found[0];
-      const bootstrapAdmin = adminEmails().includes(email.toLowerCase());
-      if (!row) {
-        const inserted = await db.insert(users).values({
-          externalId, email: email.toLowerCase(),
-          username: (username || displayName).slice(0, 100),
-          displayName: (name || displayName).slice(0, 100),
-          avatarUrl: cleanMediaUrl(avatarUrl) ?? null,
-          bannerUrl: cleanMediaUrl(bannerUrl) ?? null,
-          role: bootstrapAdmin ? 'admin' : 'reader',
-        }).returning();
-        row = inserted[0];
-      } else {
-        // Fill-or-heal only: a stored remote URL (e.g. a custom R2 avatar)
-        // is never overwritten by the fresh Google photo. Device URIs are
-        // never written.
-        const patch: Partial<typeof row> = { email: email.toLowerCase(), updatedAt: new Date() };
-        const healedAvatar = keepRemoteOrHeal(row.avatarUrl, avatarUrl);
-        if (healedAvatar !== undefined) patch.avatarUrl = healedAvatar;
-        const healedBanner = keepRemoteOrHeal(row.bannerUrl, bannerUrl);
-        if (healedBanner !== undefined) patch.bannerUrl = healedBanner;
-        if (bootstrapAdmin && row.role !== 'admin') patch.role = 'admin';
-        await db.update(users).set(patch).where(eq(users.id, row.id));
-        row = { ...row, ...patch };
-      }
-      // Stable identity: the token sub must be the stored externalId, not the
-      // freshly computed one. Finding by email with a different googleId
-      // (email-only first login, changed Google ID) otherwise mints a token
-      // that getCaller can never resolve -> 401 'غير مصرح' on every
-      // authenticated call (/me, /author/requests, /admin/*).
-      const stableExternalId = row.externalId ?? externalId;
-      const token = await signToken({ id: stableExternalId, email: row.email!, role: row.role ?? 'reader' });
-      return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user: toPublic({ ...row, externalId: stableExternalId }), token });
-    } catch (err) {
-      console.error('[auth] db login failed, memory fallback', err); noteDbFailure();
-    }
-  }
-
-  let user = memUsers.find((u) => u.email === email || u.externalId === externalId);
-  // Memory fallback must honor the same admin bootstrap as the DB path,
-  // otherwise an admin email always logs in as reader when DATABASE_URL
-  // is unset/down, and any in-memory promotion is lost on re-login.
-  const memBootstrapAdmin = adminEmails().includes(email.toLowerCase());
-  if (!user) {
-    user = { id: externalId, externalId, email, name: displayName, displayName, username: username || displayName, avatarUrl: cleanMediaUrl(avatarUrl) ?? null, bannerUrl: cleanMediaUrl(bannerUrl) ?? null, role: memBootstrapAdmin ? 'admin' : 'reader', provider: 'google', createdAt: new Date().toISOString() };
-    memUsers.push(user);
-  } else {
-    if (name) user.name = name;
-    if (username) user.username = username;
-    if (memBootstrapAdmin && user.role !== 'admin') user.role = 'admin';
-    const healedAvatar = keepRemoteOrHeal(user.avatarUrl, avatarUrl);
-    if (healedAvatar !== undefined) user.avatarUrl = healedAvatar;
-    const healedBanner = keepRemoteOrHeal(user.bannerUrl, bannerUrl);
-    if (healedBanner !== undefined) user.bannerUrl = healedBanner;
-  }
-  const token = await signToken({ id: user.externalId, email: user.email, role: user.role });
-  return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user, token });
 });
 
-// GET /api/v1/auth/me — returns the authoritative DB role plus a freshly
-// signed token, so a client holding a stale pre-grant token self-heals
-// (role upgrades included) by refetching /me on app startup.
+// GET /api/v1/auth/me: authoritative role and refreshed session.
 authRouter.get('/me', requireAuth, async (c) => {
-  const payload = c.get('authUser') as { sub?: string };
-  const sub = payload.sub ?? '';
-  if (isDbAvailable()) {
+  const sub = String(c.get('authUser').sub ?? '');
+  const env = getEnv();
+  // A dev_ fixture is never resolved through persistent storage.
+  if (isDbAvailable() && (env.isProd || !sub.startsWith('dev_'))) {
     try {
-      const found = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
-      if (found[0]) {
-        const row = found[0];
-        const fresh = await signToken({ id: row.externalId ?? sub, email: row.email!, role: row.role ?? 'reader' });
-        return c.json({ user: toPublic(row), token: fresh });
-      }
-    } catch (err) {
-      console.error('[auth] db me failed', err); noteDbFailure();
-    }
+      const [row] = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
+      if (!row) return c.json({ error: 'account not found' }, 401);
+      const token = await signToken({ id: row.externalId!, email: row.email ?? '', role: row.role });
+      return c.json({ user: toPublic(row), token });
+    } catch (error) { return accountError(c, error); }
   }
-  const user = memUsers.find((u) => u.id === sub || u.externalId === sub);
-  if (!user) return c.json({ error: 'المستخدم غير موجود' }, 404);
-  const fresh = await signToken({ id: user.externalId, email: user.email, role: user.role ?? 'reader' });
-  return c.json({ user, token: fresh });
+  if (env.isProd) return c.json({ error: 'account storage unavailable' }, 503);
+  const user = memUsers.find((u) => u.externalId === sub);
+  if (!user) return c.json({ error: 'account not found' }, 401);
+  const token = await signToken({ id: user.externalId, email: user.email, role: user.role });
+  return c.json({ user: toPublic(user), token });
 });
 
 // PATCH /api/v1/auth/me — explicit profile edit (display name, handle,
@@ -207,11 +134,11 @@
     }
   }
 
-  if (isDbAvailable()) {
+  if (isDbAvailable() && (getEnv().isProd || !sub.startsWith('dev_'))) {
     try {
       const found = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
       const row = found[0];
-      if (!row) return c.json({ error: 'المستخدم غير موجود' }, 404);
+      if (!row) return c.json({ error: 'account not found' }, 401);
       if (username !== undefined && username !== row.username) {
         const clash = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
         if (clash[0]) return c.json({ error: 'اسم المستخدم محجوز بالفعل' }, 409);
@@ -221,17 +148,17 @@
       if (name !== undefined) patch.displayName = name;
       if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl === null ? null : cleanMediaUrl(avatarUrl);
       if (bannerUrl !== undefined) patch.bannerUrl = bannerUrl === null ? null : cleanMediaUrl(bannerUrl);
-      await db.update(users).set(patch).where(eq(users.id, row.id));
-      const updated = { ...row, ...patch };
+      const [updated] = await db.update(users).set(patch).where(eq(users.id, row.id)).returning();
+      if (!updated) return c.json({ error: 'account not found' }, 401);
       return c.json({ success: true, user: toPublic({ ...updated, externalId: row.externalId }) });
-    } catch (err) {
-      console.error('[auth] db profile patch failed', err); noteDbFailure();
-      return c.json({ error: 'تعذر تحديث الملف الشخصي' }, 500);
+    } catch (error) {
+      return accountError(c, error);
     }
   }
 
-  const user = memUsers.find((u) => u.id === sub || u.externalId === sub);
-  if (!user) return c.json({ error: 'المستخدم غير موجود' }, 404);
+  if (getEnv().isProd) return c.json({ error: 'account storage unavailable' }, 503);
+  const user = memUsers.find((u) => u.externalId === sub);
+  if (!user) return c.json({ error: 'account not found' }, 401);
   if (username !== undefined) {
     if (memUsers.some((u) => u !== user && u.username === username)) {
       return c.json({ error: 'اسم المستخدم محجوز بالفعل' }, 409);
```


### Task 13: Check the identity milestone

- [ ] Run:

```bash
npm run typecheck && npm test -- src/routes/googleIdentity.test.ts src/routes/auth.admin-persist.test.ts
git diff --check
git add src/routes/googleIdentity.ts src/routes/googleIdentity.test.ts src/routes/googleAccount.ts src/routes/auth.ts
git commit -m "fix(auth): bind login to verified Google identity"
```

Expected: exit 0; claim tests and existing development memory fixtures pass; commit contains only listed identity files. Comprehensive route regressions are added below before final acceptance.

### Task 14: Remove all sync authentication-email writes and production provisioning

- [ ] Apply this exact diff to `src/routes/sync.ts` (acceptance: only the displayed hunks change):

```diff
--- a/src/routes/sync.ts
+++ b/src/routes/sync.ts
@@ -1,7 +1,7 @@
 import { Hono, type Context } from 'hono';
 import { and, eq, gt } from 'drizzle-orm';
 import { z } from 'zod';
-import { db, isDbAvailable } from '../database/db.js';
+import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
 import { users, userLibrary, readingHistory, readingSessions } from '../database/schema.js';
 import { verifySubject } from '../middleware/auth.js';
 import { getEnv } from '../config/env.js';
@@ -14,8 +14,8 @@
 // UTC epoch ms). received_at is audit/GC only and is never compared.
 // Tombstone beats live regardless of clock; else larger updatedAt wins;
 // ties union category_ids. Sessions are append-only + idempotent.
-// Auth: SYNC_OPEN=false requires Bearer JWT; default true auto-provisions
-// the user by external_id (LAN-first threat model).
+// Production: closed sync, existing authenticated accounts only.
+// Explicit development/test mode may provision fixtures without auth email.
 // ==========================================
 
 export const CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
@@ -86,28 +86,26 @@
   return [...a, ...b].map(String).filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
 };
 
-async function provisionUser(externalId: string, email?: string, name?: string) {
-  const cleanEmail = (email || '').trim().toLowerCase() || null;
-  const cleanName = (name || '').slice(0, 100) || null;
-  await db
-    .insert(users)
-    .values({
-      externalId,
-      email: cleanEmail,
-      username: `user_${externalId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'x'}`,
-      avatarUrl: null
-    })
-    .onConflictDoNothing({ target: users.externalId });
-  const row = await db.select().from(users).where(eq(users.externalId, externalId)).then((r) => r[0]);
-  if (!row) throw new Error('user provision failed');
-  if ((cleanEmail && row.email !== cleanEmail) || (cleanName && !row.avatarUrl)) {
-    await db
-      .update(users)
-      .set({ email: cleanEmail ?? row.email, updatedAt: new Date() })
-      .where(eq(users.id, row.id));
-  }
-  void cleanName;
-  return row;
+async function provisionUser(externalId: string) {
+  const [existing] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
+  if (existing || getEnv().isProd) return existing;
+  await db.insert(users).values({
+    externalId, email: null, googleSubject: null,
+    username: `user_${externalId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'x'}`,
+    avatarUrl: null,
+  }).onConflictDoNothing({ target: users.externalId });
+  return (await db.select().from(users).where(eq(users.externalId, externalId)).limit(1))[0];
+}
+
+// Catch account-resolution failures locally; never expose driver diagnostics.
+async function resolveSyncUser(c: Context, externalId: string) {
+  try {
+    const user = await provisionUser(externalId);
+    return user ?? c.json({ error: 'account not found' }, 401);
+  } catch {
+    noteDbFailure();
+    return c.json({ error: 'account storage unavailable' }, 503);
+  }
 }
 
 const num = (v: unknown, fallback = 0): number =>
@@ -139,7 +137,8 @@
     return c.json({ error: 'forbidden: token identity does not match user.externalId' }, 403);
   }
   const now = Date.now();
-  const user = await provisionUser(externalId, body.user?.email, body.user?.name);
+  const user = await resolveSyncUser(c, externalId);
+  if (user instanceof Response) return user;
 
   let appliedLibrary = 0;
   for (const e of body.library ?? []) {
@@ -272,7 +271,8 @@
     return c.json({ error: 'forbidden: token identity does not match user.externalId' }, 403);
   }
   const since = num(body?.since, 0);
-  const user = await provisionUser(externalId, body.user?.email, body.user?.name);
+  const user = await resolveSyncUser(c, externalId);
+  if (user instanceof Response) return user;
 
   const library = await db
     .select()
@@ -344,7 +344,11 @@
   const body = await c.req.json().catch(() => null);
   const externalId = typeof body?.user?.externalId === 'string' ? body.user.externalId : '';
   if (!externalId) return c.json({ error: 'user.externalId is required' }, 400);
-  const user = await provisionUser(externalId);
+  const authedSub = await authedSubject(c);
+  if (!getEnv().syncOpen && !authedSub) return c.json({ error: 'unauthorized' }, 401);
+  if (authedSub && authedSub !== externalId) return c.json({ error: 'forbidden' }, 403);
+  const user = await resolveSyncUser(c, externalId);
+  if (user instanceof Response) return user;
   const lib = await db.select({ id: userLibrary.id }).from(userLibrary).where(eq(userLibrary.userId, user.id));
   const hist = await db.select({ id: readingHistory.id }).from(readingHistory).where(eq(readingHistory.userId, user.id));
   const sess = await db.select({ id: readingSessions.id }).from(readingSessions).where(eq(readingSessions.userId, user.id));
```


### Task 15: Validate explicit modes without fallback defaults or stale cache

- [ ] Apply this exact diff to `src/config/env.ts` (acceptance: only the displayed hunks change):

```diff
--- a/src/config/env.ts
+++ b/src/config/env.ts
@@ -4,9 +4,9 @@
   PORT: z.coerce.number().default(4000),
   DATABASE_URL: z.string().min(1).optional(),
   JWT_SECRET: z.string().min(1).optional(),
-  SYNC_OPEN: z.string().default('true'),
+  SYNC_OPEN: z.enum(['true', 'false']).optional(),
   CORS_ORIGIN: z.string().default('*'),
-  NODE_ENV: z.string().default('development'),
+  NODE_ENV: z.enum(['production', 'development', 'test']),
   REDIS_URL: z.string().optional(),
   UPLOAD_MAX_MB: z.coerce.number().default(2),
   // R2 / S3-compatible object storage (optional; falls back to local disk on Node)
@@ -18,6 +18,18 @@
   ADMIN_EMAILS: z.string().default(''),
   GOOGLE_WEB_CLIENT_ID: z.string().optional(),
   GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),
+}).superRefine((value, ctx) => {
+  if (value.NODE_ENV !== 'production') return;
+  const invalid = (field: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'invalid configuration' });
+  try {
+    const url = new URL(value.DATABASE_URL ?? '');
+    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) invalid('DATABASE_URL');
+  } catch { invalid('DATABASE_URL'); }
+  if (value.SYNC_OPEN !== 'false') invalid('SYNC_OPEN');
+  if (![value.GOOGLE_WEB_CLIENT_ID, value.GOOGLE_ANDROID_CLIENT_ID].some((v) => v && v.trim().length > 0)) invalid('GOOGLE_WEB_CLIENT_ID');
+  const secret = value.JWT_SECRET ?? '';
+  if (new TextEncoder().encode(secret).length < 32 || !secret.trim() ||
+      secret.trim().startsWith('web-novel-dev-') || secret.trim() === 'change-me-in-production') invalid('JWT_SECRET');
 });
 
 export type Env = z.infer<typeof envSchema> & {
@@ -30,14 +42,10 @@
   var __WORKER_ENV__: Record<string, string | undefined> | undefined;
 }
 
-let cached: Env | null = null;
-let cachedKey = '';
-
 function readSource(): Record<string, string | undefined> {
-  const w = typeof globalThis !== 'undefined' ? (globalThis as any).__WORKER_ENV__ : undefined;
-  const proc = typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {};
-  if (w) return { ...proc, ...w };
-  return { ...proc };
+  // Do not inherit process defaults into a Worker with missing bindings.
+  if (globalThis.__WORKER_ENV__ !== undefined) return { ...globalThis.__WORKER_ENV__ };
+  return typeof process === 'undefined' ? {} : { ...process.env };
 }
 
 /** Called by the Workers entry on every request (bindings differ per env). */
@@ -47,42 +55,16 @@
     if (typeof v === 'string') flat[k] = v;
   }
   (globalThis as any).__WORKER_ENV__ = flat;
-  cached = null;
-  cachedKey = '';
 }
 
 export function getEnv(): Env {
-  const src = readSource();
-  const key = `${src.DATABASE_URL ?? ''}|${src.JWT_SECRET ?? ''}|${src.SYNC_OPEN}|${src.CORS_ORIGIN}|${src.NODE_ENV}|${src.R2_BUCKET ?? ''}|${src.ADMIN_EMAILS ?? ''}|${src.GOOGLE_WEB_CLIENT_ID ?? ''}|${src.GOOGLE_ANDROID_CLIENT_ID ?? ''}`;
-  if (cached && key === cachedKey) return cached;
-  const parsed = envSchema.safeParse(src);
+  const parsed = envSchema.safeParse(readSource());
   if (!parsed.success) {
-    console.warn('[env] invalid env, using defaults:', parsed.error.issues);
+    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'environment')))];
+    throw new Error(`Invalid environment fields: ${fields.join(', ')}`);
   }
-  const e = (parsed.success ? parsed.data : {}) as z.infer<typeof envSchema>;
-  const NODE_ENV = e.NODE_ENV ?? 'development';
-  cachedKey = key;
-  cached = {
-    PORT: e.PORT ?? 4000,
-    DATABASE_URL: e.DATABASE_URL,
-    JWT_SECRET: e.JWT_SECRET,
-    SYNC_OPEN: e.SYNC_OPEN ?? 'true',
-    CORS_ORIGIN: e.CORS_ORIGIN ?? '*',
-    NODE_ENV,
-    REDIS_URL: e.REDIS_URL,
-    UPLOAD_MAX_MB: e.UPLOAD_MAX_MB ?? 2,
-    R2_ENDPOINT: e.R2_ENDPOINT,
-    R2_BUCKET: e.R2_BUCKET,
-    R2_ACCESS_KEY: e.R2_ACCESS_KEY,
-    R2_SECRET_KEY: e.R2_SECRET_KEY,
-    R2_PUBLIC_URL: e.R2_PUBLIC_URL,
-    ADMIN_EMAILS: e.ADMIN_EMAILS ?? '',
-    GOOGLE_WEB_CLIENT_ID: e.GOOGLE_WEB_CLIENT_ID,
-    GOOGLE_ANDROID_CLIENT_ID: e.GOOGLE_ANDROID_CLIENT_ID,
-    isProd: NODE_ENV === 'production',
-    syncOpen: (e.SYNC_OPEN ?? 'true') !== 'false',
-  };
-  return cached;
+  const value = parsed.data;
+  return { ...value, isProd: value.NODE_ENV === 'production', syncOpen: (value.SYNC_OPEN ?? 'true') === 'true' };
 }
 
 export function adminEmails(): string[] {
```


### Task 16: Use one validated signing and verification policy

- [ ] Apply this exact diff to `src/middleware/auth.ts` (acceptance: only the displayed hunks change):

```diff
--- a/src/middleware/auth.ts
+++ b/src/middleware/auth.ts
@@ -5,7 +5,8 @@
 const DEV_SECRET = 'web-novel-dev-secret-change-me';
 
 function getSecretKey(): Uint8Array {
-  const s = getEnv().JWT_SECRET || process.env.JWT_SECRET || DEV_SECRET;
+  const env = getEnv();
+  const s = env.JWT_SECRET ?? (env.isProd ? '' : DEV_SECRET);
   return new TextEncoder().encode(s);
 }
 
@@ -24,6 +25,7 @@
 }
 
 export const requireAuth: MiddlewareHandler = async (c, next) => {
+  const key = getSecretKey();
   const header = c.req.header('Authorization');
   const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
 
@@ -32,15 +34,15 @@
   }
 
   try {
-    const { payload } = await jwtVerify(token, getSecretKey(), {
+    const { payload } = await jwtVerify(token, key, {
       issuer: 'web-novel',
       audience: 'web-novel-app'
     });
     c.set('authUser', payload);
-    await next();
   } catch {
     return c.json({ error: 'رمز الوصول غير صالح أو منتهي الصلاحية' }, 401);
   }
+  await next();
 };
 
 declare module 'hono' {
@@ -52,10 +54,11 @@
 /** Verify a Bearer token when present. Returns the subject or null
  *  (null = anonymous; callers decide whether that is allowed). */
 export async function verifySubject(header: string | undefined): Promise<string | null> {
+  const key = getSecretKey();
   const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
   if (!token) return null;
   try {
-    const { payload } = await jwtVerify(token, getSecretKey(), {
+    const { payload } = await jwtVerify(token, key, {
       issuer: 'web-novel',
       audience: 'web-novel-app'
     });
```


### Task 17: Check and commit the closed-policy milestone

- [ ] Run:

```bash
npm run typecheck && npm test
git diff --check
git add src/routes/sync.ts src/config/env.ts src/middleware/auth.ts
git commit -m "fix(auth): lock sync email and fail closed in production"
```

Expected: exit 0 and all existing tests pass. Vitest sets `NODE_ENV=test`; no missing-mode workaround may be added to production code.

### Task 18: Create src/test/identityDb.ts

- [ ] Create `src/test/identityDb.ts` with this complete content (acceptance: file matches this block):

```typescript
import { vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { users } from '../database/schema.js';

type Row = typeof users.$inferSelect;
export function identityDb() {
  const rows: Row[] = [];
  let unavailable = false;
  let failure: unknown = null;
  let nextInsertError: unknown = null;
  const dialect = new PgDialect();
  function matches(row: Row, condition?: SQL) {
    if (!condition) return true;
    const query = dialect.sqlToQuery(condition);
    const column = /"users"\."([a-z_]+)"/.exec(query.sql)?.[1];
    const key = ({ google_subject: 'googleSubject', external_id: 'externalId', id: 'id',
      username: 'username', email: 'email' } as Record<string, keyof Row>)[column ?? ''];
    if (!key) throw new Error('unexpected test query');
    return row[key] === query.params[0];
  }
  function check() { if (failure) throw failure; }
  function query(table: unknown, condition?: SQL): any {
    const execute = async () => { check(); return table === users ? rows.filter((r) => matches(r, condition)) : []; };
    const builder = {
      where: (value: SQL) => query(table, value),
      limit: (_value: number) => execute(),
      orderBy: (_value: unknown) => builder,
      then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) => execute().then(resolve, reject),
    };
    return builder;
  }
  const insert = vi.fn((table: unknown) => ({ values: (value: Partial<Row>) => {
    const execute = async () => {
      check();
      if (nextInsertError) { const error = nextInsertError; nextInsertError = null; throw error; }
      if (table !== users) return [];
      const row = { id: crypto.randomUUID(), email: null, googleSubject: null, externalId: null,
        username: null, displayName: null, passwordHash: null, avatarUrl: null, bannerUrl: null,
        role: 'reader', isAuthor: false, isTranslator: false, createdAt: new Date(), updatedAt: new Date(), ...value } as Row;
      for (const key of ['externalId', 'googleSubject', 'email', 'username'] as const) {
        if (row[key] !== null && rows.some((existing) => existing[key] === row[key])) throw { code: '23505' };
      }
      rows.push(row); return [row];
    };
    return { returning: execute, onConflictDoNothing: async () => {
      try { return await execute(); } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        return [];
      }
    } };
  } }));
  const update = vi.fn((_table: unknown) => ({ set: (patch: Partial<Row>) => ({ where: (condition: SQL) => {
    const execute = async () => {
      check();
      const targets = rows.filter((row) => matches(row, condition));
      for (const target of targets) {
        for (const key of ['email', 'username'] as const) {
          if (patch[key] != null && rows.some((other) => other !== target && other[key] === patch[key])) throw { cause: { code: '23505' } };
        }
      }
      targets.forEach((target) => Object.assign(target, patch)); return targets;
    };
    return { returning: execute, then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) => execute().then(resolve, reject) };
  } }) }));
  const database = { select: vi.fn(() => ({ from: (table: unknown) => query(table) })), insert, update };
  return { rows, db: database, isDbAvailable: () => !unavailable, noteDbFailure: vi.fn(),
    unavailable: (value: boolean) => { unavailable = value; },
    fail: (value: unknown) => { failure = value; },
    failNextInsert: (value: unknown) => { nextInsertError = value; },
    reset: () => { rows.length = 0; unavailable = false; failure = null; nextInsertError = null;
      insert.mockClear(); update.mockClear(); database.select.mockClear(); },
  };
}

export const productionBindings = {
  NODE_ENV: 'production', SYNC_OPEN: 'false', DATABASE_URL: 'postgresql://local:local@localhost/fixture',
  JWT_SECRET: 'fixture-production-signing-key-32-bytes-minimum', GOOGLE_WEB_CLIENT_ID: 'web-client', ADMIN_EMAILS: 'admin@test.com',
};
```


### Task 19: Create src/config/env.test.ts

- [ ] Create `src/config/env.test.ts` with this complete content (acceptance: file matches this block):

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnv, setWorkerEnv } from './env.js';
import { productionBindings } from '../test/identityDb.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function source(value: Record<string, unknown>) {
  vi.stubGlobal('__WORKER_ENV__', undefined);
  setWorkerEnv(value);
}
describe('effective environment fails closed', () => {
  it('accepts production and rejects invalid settings without values', () => {
    source(productionBindings);
    expect(getEnv()).toMatchObject({ isProd: true, syncOpen: false });
  });
  it.each([
    ['NODE_ENV', undefined], ['NODE_ENV', ''], ['NODE_ENV', 'staging'],
    ['JWT_SECRET', undefined], ['JWT_SECRET', ''], ['JWT_SECRET', 'short'],
    ['JWT_SECRET', 'web-novel-dev-' + 'x'.repeat(50)], ['JWT_SECRET', 'change-me-in-production'],
    ['JWT_SECRET', ' '.repeat(40)], ['DATABASE_URL', undefined], ['DATABASE_URL', ''],
    ['DATABASE_URL', 'https://example.com/db'], ['DATABASE_URL', 'postgresql://localhost'],
    ['GOOGLE_WEB_CLIENT_ID', ''], ['GOOGLE_WEB_CLIENT_ID', undefined],
    ['SYNC_OPEN', undefined], ['SYNC_OPEN', 'true'], ['SYNC_OPEN', 'False'], ['SYNC_OPEN', 'false '],
    ['PORT', 'private-invalid-number'], ['UPLOAD_MAX_MB', 'private-invalid-number'],
  ])('rejects invalid %s', (field, value) => {
    source({ ...productionBindings, [field as string]: value });
    expect(() => getEnv()).toThrow(String(field));
    try { getEnv(); } catch (error) {
      const message = String(error);
      expect(message).not.toContain(productionBindings.JWT_SECRET);
      expect(message).not.toContain(productionBindings.DATABASE_URL);
      expect(message).not.toContain('private-invalid-number');
    }
  });
  it('measures UTF-8 bytes, not string length', () => {
    source({ ...productionBindings, JWT_SECRET: 'é'.repeat(16) });
    expect(getEnv().isProd).toBe(true);
  });
  it.each(['development', 'test'])('allows defaults only in explicit %s', (NODE_ENV) => {
    source({ NODE_ENV }); expect(getEnv()).toMatchObject({ isProd: false, syncOpen: true });
  });
  it('invalid development input never silently opens sync', () => {
    source({ NODE_ENV: 'development', SYNC_OPEN: 'False' });
    expect(() => getEnv()).toThrow('SYNC_OPEN');
  });
  it('rechecks every field and worker binding without cached development state', () => {
    source({ NODE_ENV: 'test' }); expect(getEnv().syncOpen).toBe(true);
    setWorkerEnv(productionBindings); expect(getEnv().syncOpen).toBe(false);
    globalThis.__WORKER_ENV__!.PORT = 'private-invalid-number';
    expect(() => getEnv()).toThrow('PORT');
    setWorkerEnv({}); expect(() => getEnv()).toThrow('NODE_ENV');
  });
  it('does not inherit Node credentials into missing worker bindings', () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('JWT_SECRET', productionBindings.JWT_SECRET);
    source({}); expect(() => getEnv()).toThrow('NODE_ENV');
  });
  it('revalidates Node source changes', () => {
    vi.stubGlobal('__WORKER_ENV__', undefined);
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('SYNC_OPEN', 'false');
    expect(getEnv().syncOpen).toBe(false);
    vi.stubEnv('UPLOAD_MAX_MB', 'private-invalid-number');
    expect(() => getEnv()).toThrow('UPLOAD_MAX_MB');
  });
  it('fails before createApp returns a permissive app', async () => {
    source({ ...productionBindings, PORT: 'private-invalid-number' });
    const { createApp } = await import('../app.js');
    expect(() => createApp()).toThrow('PORT');
  });
});
```


### Task 20: Create src/middleware/auth.test.ts

- [ ] Create `src/middleware/auth.test.ts` with this complete content (acceptance: file matches this block):

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { requireAuth, signToken, verifySubject } from './auth.js';
import { setWorkerEnv } from '../config/env.js';
import { productionBindings } from '../test/identityDb.js';

beforeEach(() => { vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const user = { id: 'google_subject-1', email: 'reader@test.com', role: 'reader' };
function app() { return new Hono().get('/', requireAuth, (c) => c.json(c.get('authUser'))); }
describe('shared JWT policy', () => {
  it('signs usable production sessions', async () => {
    const token = await signToken(user);
    expect(await verifySubject(`Bearer ${token}`)).toBe(user.id);
    expect((await app().request('/', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });
  it('rejects the dev secret as production configuration for both APIs', async () => {
    setWorkerEnv({ ...productionBindings, JWT_SECRET: 'web-novel-dev-secret-change-me' });
    await expect(signToken(user)).rejects.toThrow('JWT_SECRET');
    await expect(verifySubject('Bearer invalid')).rejects.toThrow('JWT_SECRET');
  });
  it('rejects a dev-signed token under valid production configuration', async () => {
    setWorkerEnv({ NODE_ENV: 'test' });
    const token = await signToken(user);
    setWorkerEnv(productionBindings);
    expect(await verifySubject(`Bearer ${token}`)).toBeNull();
    expect((await app().request('/', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
  it.each([
    ['wrong', 'web-novel-app', '1h'], ['web-novel', 'wrong', '1h'], ['web-novel', 'web-novel-app', '-1h'],
  ])('retains issuer/audience/expiration checks: %s %s %s', async (issuer, audience, expiration) => {
    const token = await new SignJWT({ sub: user.id }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer).setAudience(audience).setExpirationTime(expiration)
      .sign(new TextEncoder().encode(productionBindings.JWT_SECRET));
    expect(await verifySubject(`Bearer ${token}`)).toBeNull();
    expect((await app().request('/', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
  it('does not fall back to a raw process secret for worker verification', async () => {
    vi.stubEnv('JWT_SECRET', productionBindings.JWT_SECRET);
    setWorkerEnv({ ...productionBindings, JWT_SECRET: undefined });
    await expect(signToken(user)).rejects.toThrow('JWT_SECRET');
  });
  it('returns 401 without a token', async () => { expect((await app().request('/')).status).toBe(401); });
});
```


### Task 21: Create src/routes/auth.identity.test.ts

- [ ] Create `src/routes/auth.identity.test.ts` with this complete content (acceptance: file matches this block):

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { signToken } from '../middleware/auth.js';

const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_target, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(), noteDbFailure: () => holder.fake!.noteDbFailure(),
}));
let app: Hono;
let claims: Record<string, unknown>;
const fake = () => holder.fake!;
async function login(body: Record<string, unknown> = {}) {
  return app.request('/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reader@test.com', idToken: 'private-google-token', name: 'Reader', ...body }) });
}
async function me(token: string, method = 'GET', body?: Record<string, unknown>) {
  return app.request('/auth/me', { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
}
beforeEach(async () => {
  holder.fake = identityDb();
  vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings);
  claims = { sub: 'subject-1', email: 'reader@test.com', aud: 'web-client', iss: 'accounts.google.com',
    email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(claims)));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { authRouter } = await import('./auth.js');
  app = new Hono().use('*', requestId()).route('/auth', authRouter);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('verified identity and failure semantics', () => {
  it('creates a canonical reader and returns a usable session with the old wire shape', async () => {
    const response = await login({ googleId: 'ignored-client-id' });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body).toMatchObject({ success: true, user: { id: 'google_subject-1', externalId: 'google_subject-1',
      email: 'reader@test.com', role: 'reader', provider: 'google' }, token: expect.any(String) });
    expect(fake().rows[0]).toMatchObject({ googleSubject: 'subject-1', externalId: 'google_subject-1', email: 'reader@test.com' });
    expect((await me(body.token)).status).toBe(200);
  });
  it('ignores different client IDs and repeats without writes or duplicate events', async () => {
    await login({ googleId: 'one' }); const uuid = fake().rows[0].id;
    await login({ googleId: 'two' });
    expect(fake().rows).toHaveLength(1); expect(fake().rows[0].id).toBe(uuid);
    expect(fake().db.insert).toHaveBeenCalledTimes(1); expect(fake().db.update).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledTimes(1);
    const event = JSON.parse(vi.mocked(console.info).mock.calls[0][0]);
    expect(event).toEqual({ event: 'account.provisioned', requestId: expect.any(String), accountId: uuid, outcome: 'created' });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/reader@test|private-google-token|signing-key/);
  });
  it('bootstraps only the verified email and rejects body mismatch', async () => {
    expect((await login({ email: 'admin@test.com' })).status).toBe(400);
    expect(fake().rows).toHaveLength(0);
    claims.email = 'ADMIN@test.com';
    expect((await login({ email: 'admin@test.com' })).status).toBe(200);
    expect(fake().rows[0].role).toBe('admin');
  });
  it('updates email and bootstrap only on a sub-matched verified login', async () => {
    await login(); const uuid = fake().rows[0].id;
    claims.email = 'admin@test.com'; await login({ email: 'ADMIN@test.com' });
    expect(fake().rows[0]).toMatchObject({ id: uuid, email: 'admin@test.com', role: 'admin' });
  });
  it('strips protected PATCH fields while allowing display edits', async () => {
    const { token }: any = await (await login()).json();
    const response = await me(token, 'PATCH', { name: 'New Name', email: 'admin@test.com',
      externalId: 'google_other', googleSubject: 'other', role: 'admin' });
    expect(response.status).toBe(200);
    expect(fake().rows[0]).toMatchObject({ displayName: 'New Name', email: 'reader@test.com',
      externalId: 'google_subject-1', googleSubject: 'subject-1', role: 'reader' });
  });
  it('does not link by email or repair a canonical-ID disagreement', async () => {
    await login(); const original = { ...fake().rows[0] };
    claims.sub = 'other';
    expect((await login()).status).toBe(409); expect(fake().rows[0]).toEqual(original);
    claims.sub = 'subject-1'; fake().rows[0].externalId = 'google_wrong';
    expect((await login()).status).toBe(409); expect(fake().db.update).not.toHaveBeenCalled();
  });
  it('rejects an external-ID collision without assigning a subject', async () => {
    await login(); fake().rows[0].googleSubject = null;
    expect((await login()).status).toBe(409); expect(fake().rows[0].googleSubject).toBeNull();
  });
  it('email-update collisions do not partially promote or mutate', async () => {
    await login(); claims.sub = 'subject-2'; claims.email = 'admin@test.com';
    await login({ email: 'admin@test.com', name: 'Admin' });
    const original = { ...fake().rows[0] }; claims.sub = 'subject-1';
    expect((await login({ email: 'admin@test.com' })).status).toBe(409);
    expect(fake().rows[0]).toEqual(original);
  });
  it('rereads an identical concurrent insert winner without mutation', async () => {
    // Force the first SELECT to see no row; the insert sees the committed winner.
    await login(); const winner = fake().rows[0];
    fake().db.select.mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) as any);
    expect((await login()).status).toBe(200);
    expect(fake().rows).toEqual([winner]); expect(fake().db.update).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledTimes(1);
  });
  it.each(['unavailable', 'query-error'])('all account routes fail 503 on %s without tokens', async (mode) => {
    const { token }: any = await (await login()).json();
    if (mode === 'unavailable') fake().unavailable(true); else fake().fail(new Error('private-db-password'));
    for (const response of [await login(), await me(token), await me(token, 'PATCH', { name: 'Changed' })]) {
      expect(response.status).toBe(503);
      const text = await response.text(); expect(text).not.toMatch(/token|private-db-password|reader@test/);
    }
    expect(fake().rows[0].displayName).toBe('Reader');
  });
  it('does not consult populated memory after switching to production', async () => {
    setWorkerEnv({ NODE_ENV: 'test', ADMIN_EMAILS: 'reader@test.com' }); fake().unavailable(true);
    const dev: any = await (await login({ idToken: undefined, googleId: 'ignored' })).json();
    expect(dev.user.externalId).toBe('dev_reader@test.com');
    setWorkerEnv(productionBindings);
    const token = await signToken({ id: dev.user.externalId, email: 'reader@test.com', role: 'admin' });
    for (const response of [await login(), await me(token), await me(token, 'PATCH', { name: 'Changed' })]) {
      expect(response.status).toBe(503); expect(await response.text()).not.toContain('token');
    }
  });
  it('missing subjects return 401, not a memory or anonymous account', async () => {
    const token = await signToken({ id: 'google_missing', email: 'reader@test.com', role: 'reader' });
    expect((await me(token)).status).toBe(401);
    expect((await me(token, 'PATCH', { name: 'Changed' })).status).toBe(401);
    expect(fake().db.insert).not.toHaveBeenCalled();
  });
  it('absent-token development fixtures never touch a configured database', async () => {
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'test' });
    const response = await login({ idToken: undefined }); expect(response.status).toBe(200);
    expect(fake().db.select).not.toHaveBeenCalled(); expect(fake().db.insert).not.toHaveBeenCalled();
  });
  it('rejects invalid supplied tokens in development without memory fallback', async () => {
    setWorkerEnv({ NODE_ENV: 'test', GOOGLE_WEB_CLIENT_ID: 'web-client' }); fake().unavailable(true);
    claims.email_verified = false;
    expect((await login()).status).toBe(401);
    expect((await login({ idToken: '' })).status).toBe(401);
  });
  it('requires production tokens', async () => { expect((await login({ idToken: undefined })).status).toBe(401); });
});
```


### Task 22: Create src/routes/sync.identity.test.ts

- [ ] Create `src/routes/sync.identity.test.ts` with this complete content (acceptance: file matches this block):

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { signToken } from '../middleware/auth.js';
import { users } from '../database/schema.js';
const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_target, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(), noteDbFailure: () => holder.fake!.noteDbFailure(),
}));
let app: Hono;
let token: string;
const fake = () => holder.fake!;
async function sync(path: string, externalId = 'google_subject-1', email = 'ADMIN@test.com', bearer: string | null = token) {
  return app.request(`/sync/${path}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  }, body: JSON.stringify({ user: { externalId, email, name: 'Untrusted' } }) });
}
beforeEach(async () => {
  holder.fake = identityDb(); vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings);
  token = await signToken({ id: 'google_subject-1', email: 'reader@test.com', role: 'reader' });
  const { syncRouter } = await import('./sync.js'); app = new Hono().route('/sync', syncRouter);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('sync cannot write authentication identity', () => {
  it.each(['push', 'pull', 'stats'])('%s rejects unknown production subjects without insertion', async (path) => {
    expect((await sync(path)).status).toBe(401); expect(fake().db.insert).not.toHaveBeenCalled();
  });
  it.each(['push', 'pull', 'stats'])('%s preserves body/token matching and requires a token', async (path) => {
    expect((await sync(path, 'google_other')).status).toBe(403);
    expect((await sync(path, 'google_subject-1', 'reader@test.com', null)).status).toBe(401);
    expect(fake().db.insert).not.toHaveBeenCalled();
  });
  it.each(['push', 'pull', 'stats'])('%s leaves existing email/name/identity untouched', async (path) => {
    await fake().db.insert(users).values({ externalId: 'google_subject-1', googleSubject: 'subject-1',
      email: 'reader@test.com', username: 'Reader', displayName: 'Reader' }).returning();
    const original = { ...fake().rows[0] }; fake().db.insert.mockClear();
    for (const email of ['admin@test.com', 'ADMIN@TEST.COM', ' reader@test.com ']) {
      expect((await sync(path, 'google_subject-1', email)).status).toBe(200);
    }
    expect(fake().rows[0]).toEqual(original);
    expect(fake().db.insert).not.toHaveBeenCalled(); expect(fake().db.update).not.toHaveBeenCalled();
  });
  it.each(['push', 'pull'])('%s dev first insert has null authentication anchors', async (path) => {
    setWorkerEnv({ NODE_ENV: 'test', SYNC_OPEN: 'true' });
    expect((await sync(path, 'dev_fixture', 'ADMIN@TEST.COM', null)).status).toBe(200);
    expect(fake().rows[0]).toMatchObject({ externalId: 'dev_fixture', email: null, googleSubject: null, role: 'reader' });
  });
  it.each(['push', 'pull', 'stats'])('%s returns controlled 503 for account lookup failures', async (path) => {
    fake().fail(new Error('private-db-password'));
    const response = await sync(path); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-db-password');
  });
});
```


### Task 23: Isolate existing development memory/admin fixtures

- [ ] Apply this exact diff to `src/routes/auth.admin-persist.test.ts` (acceptance: only the displayed hunks change):

```diff
--- a/src/routes/auth.admin-persist.test.ts
+++ b/src/routes/auth.admin-persist.test.ts
@@ -1,10 +1,18 @@
-import { describe, it, expect } from 'vitest';
+import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
 import { createApp } from '../app.js';
+
+beforeEach(() => {
+  vi.stubGlobal('__WORKER_ENV__', undefined);
+  vi.stubEnv('NODE_ENV', 'test');
+  vi.stubEnv('SYNC_OPEN', 'false');
+  vi.stubEnv('JWT_SECRET', 'development-fixture-signing-key');
+  vi.stubEnv('DATABASE_URL', undefined);
+  vi.stubEnv('ADMIN_EMAILS', 'admin@test.com');
+});
+afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
 
 describe('admin role survives app restart (re-login + /me refresh)', () => {
   it('memory fallback promotes ADMIN_EMAILS on first and repeat logins', async () => {
-    process.env.ADMIN_EMAILS = 'admin@test.com';
-    delete process.env.DATABASE_URL;
     const app = createApp();
 
     const login = await app.request('/api/v1/auth/google', {
@@ -36,8 +44,6 @@
   });
 
   it('non-admin stays reader', async () => {
-    process.env.ADMIN_EMAILS = 'admin@test.com';
-    delete process.env.DATABASE_URL;
     const app = createApp();
     const res = await app.request('/api/v1/auth/google', {
       method: 'POST',
```


### Task 24: Verify all mocked security regressions

- [ ] Run:

```bash
npm test -- src/config/env.test.ts src/middleware/auth.test.ts src/routes/googleIdentity.test.ts src/routes/auth.identity.test.ts src/routes/sync.identity.test.ts src/routes/auth.admin-persist.test.ts
npm run typecheck
```

Expected: all listed suites pass, exit 0; no raw database diagnostics or token values appear in test output. A mock test does not establish database atomicity; continue to the mandatory local suite.

### Task 25: Commit the regression-test milestone

- [ ] Run:

```bash
git diff --check
git add src/test/identityDb.ts src/config/env.test.ts src/middleware/auth.test.ts src/routes/auth.identity.test.ts src/routes/sync.identity.test.ts src/routes/auth.admin-persist.test.ts
git commit -m "test(auth): cover identity email and closed production policy"
```

Expected: exit 0; commit contains exactly the listed six files.

### Task 26: Create src/routes/googleAccount.postgres.test.ts

- [ ] Create `src/routes/googleAccount.postgres.test.ts` with this complete content (acceptance: file matches this block):

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import { resolveGoogleAccount } from './googleAccount.js';
import type { Db } from '../database/db.js';

const url = process.env.PHASE1_PG_URL;
// No URL means unit-test mode. A supplied non-local URL is a hard failure, never a skip.
if (url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/phase1_identity_test') {
    throw new Error('PHASE1_PG_URL must name the isolated local phase1_identity_test database');
  }
}
describe.skipIf(!url)('isolated PostgreSQL provisioning', () => {
  let pool: pg.Pool;
  let database: import('drizzle-orm/node-postgres').NodePgDatabase<typeof schema>;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 10 });
    database = drizzle(pool, { schema });
    await migrate(database, { migrationsFolder: './drizzle' });
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool?.end(); });
  const identity = { sub: 'pg-subject-1', email: 'pg-reader@test.com' };
  it('concurrent identical first logins converge to one durable row and one event', async () => {
    // Barrier all eight initial lookups so every call takes the insert race path.
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const racing = new Proxy(database, {
      get(target, key) {
        if (key === 'select') return () => ({ from: () => ({ where: (condition: any) => ({ limit: async (limit: number) => {
          const rows = await target.select().from(schema.users).where(condition).limit(limit);
          if (++arrivals <= 8) { if (arrivals === 8) release(); await gate; }
          return rows;
        } }) }) });
        const value = (target as any)[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Db;
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      resolveGoogleAccount(racing, identity, { name: 'PG Reader' }, false, `pg-race-${index}`)));
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    const rows = await database.select().from(schema.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: 'google_pg-subject-1', googleSubject: identity.sub, email: identity.email });
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(results.every((row) => row.googleSubject === identity.sub)).toBe(true);
  });
  it('subject uniqueness is enforced directly by PostgreSQL', async () => {
    await resolveGoogleAccount(database, identity, { name: 'First' }, false, 'pg-unique');
    await expect(database.insert(schema.users).values({ externalId: 'google_distinct', googleSubject: identity.sub,
      email: 'distinct@test.com', username: 'Distinct' })).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(await database.select().from(schema.users)).toHaveLength(1);
  });
  it('different subjects sharing verified email never merge or partially insert', async () => {
    const results = await Promise.allSettled([
      resolveGoogleAccount(database, identity, { name: 'First' }, false, 'pg-email-1'),
      resolveGoogleAccount(database, { ...identity, sub: 'pg-subject-2' }, { name: 'Second' }, true, 'pg-email-2'),
    ]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((value) => value.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect(await database.select().from(schema.users)).toHaveLength(1);
  });
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


### Task 27: Start a dedicated disposable local PostgreSQL instance

- [ ] Run:

```bash
docker run --detach --rm --name fan-novel-phase1-pg --publish 127.0.0.1:55432:5432 --env POSTGRES_USER=phase1 --env POSTGRES_PASSWORD=phase1-local-only --env POSTGRES_DB=phase1_identity_test --health-cmd='pg_isready -U phase1 -d phase1_identity_test' --health-interval=1s --health-timeout=3s --health-retries=30 postgres:16
for attempt in $(seq 1 40); do
  if docker exec fan-novel-phase1-pg pg_isready -U phase1 -d phase1_identity_test; then exit 0; fi
  sleep 1
done
exit 1
```

Expected: container ID followed by `accepting connections`, exit 0. This is local-only disposable storage with fixture credentials. If the name/port already exists, stop and confirm ownership rather than delete an existing container. If Docker is unavailable, acceptance remains blocked until the user supplies an isolated local database meeting the test URL guard.

### Task 28: Verify real migration and concurrency outcomes

- [ ] Run:

```bash
PHASE1_PG_URL='postgresql://phase1:phase1-local-only@127.0.0.1:55432/phase1_identity_test' npm test -- src/routes/googleAccount.postgres.test.ts
npx drizzle-kit check
```

Expected: four PostgreSQL tests pass (not skipped), Drizzle check exits 0. The barrier forces eight first-lookup misses and concurrent real inserts; no interactive transactions are used by provisioning. These checks exercise PostgreSQL invariants through pg; Neon HTTP uses the same statements but is not live-tested.

### Task 29: Commit mandatory local database coverage

- [ ] Run:

```bash
git diff --check
git add src/routes/googleAccount.postgres.test.ts
git commit -m "test(auth): verify provisioning races on isolated PostgreSQL"
```

Expected: exit 0 and commit contains the local-only suite.

### Task 30: Write the complete release runbook

- [ ] Create `docs/superpowers/runbooks/phase1-security-release.md` with this complete content (acceptance: file matches this block):

````markdown
# Phase 1 security release gates

## Scope and authorization

This release hardens account identity only. No app, R2, frame, entitlement, payment, or general ownership changes are included. Do not run production commands during plan review. Deployment and migration require explicit user authorization, and a live Google login smoke check requires a separate approval because it writes account data.

Production accounts bind permanently to `googleSubject` and `google_<verified sub>`. There is no legacy linking, repair, or backfill. Unexpected existing users STOP the release; do not delete them or populate subjects automatically. Do not roll back to the old permissive auth code or erase subject bindings. Prefer a fixed secure release or temporary unavailability.

## Local acceptance

From the repository root, with the dedicated local test container running:

```bash
npm run typecheck
npm test
PHASE1_PG_URL='postgresql://phase1:phase1-local-only@127.0.0.1:55432/phase1_identity_test' npm test -- src/routes/googleAccount.postgres.test.ts
npm run build
mkdir -p /tmp/opencode/fan-novel-phase1-dry-run
npx wrangler deploy --dry-run --outdir /tmp/opencode/fan-novel-phase1-dry-run
```

All commands must exit 0; four isolated PostgreSQL cases must pass, not skip. Dry-run must report successful bundling and exit without deployment. It validates neither deployed secret values nor database availability. No local test calls real Google or production storage.

Local starts must set `NODE_ENV=development` or `test` explicitly. `.env.example` already specifies development; do not copy its production-placeholder JWT secret into a deployment. Production needs explicit `NODE_ENV=production`, `SYNC_OPEN=false` exactly, at least one nonempty Google audience, a valid postgres/postgresql database URL, and a nondefault JWT secret of at least 32 UTF-8 bytes. Invalid numeric settings also stop initialization. On Node this happens before listen; on Workers it happens at request initialization, not necessarily at upload time.

## Actual production-value validation (no value output)

A release operator must provide the exact intended/current deployed `DATABASE_URL` and `JWT_SECRET` from the authorized secret source and confirm whether secret bindings override any checked-in vars, especially `ADMIN_EMAILS`. Secret-name listing cannot prove their values. If these exact values or override information are unavailable, STOP; a successful dry-run is not a substitute. Do not print, commit, or store secrets in the repository. Never run these commands under shell tracing.

After explicit release authorization, run in one Bash shell:

```bash
set +x
read -r -s -p 'Exact deployed DATABASE_URL: ' DATABASE_URL; printf '\n'
read -r -s -p 'Exact deployed JWT_SECRET: ' JWT_SECRET; printf '\n'
export DATABASE_URL JWT_SECRET
node --input-type=module - <<'JS'
import fs from 'node:fs';
import { getEnv, setWorkerEnv } from './dist/config/env.js';
const text = fs.readFileSync('wrangler.toml', 'utf8');
const vars = {};
for (const line of text.split('\n')) {
  const match = /^(NODE_ENV|SYNC_OPEN|CORS_ORIGIN|GOOGLE_WEB_CLIENT_ID|GOOGLE_ANDROID_CLIENT_ID|ADMIN_EMAILS) = "([^"]*)"$/.exec(line);
  if (match) vars[match[1]] = match[2];
}
setWorkerEnv({ ...vars, DATABASE_URL: process.env.DATABASE_URL, JWT_SECRET: process.env.JWT_SECRET });
try { getEnv(); console.log('PRODUCTION_CONFIG_VALID'); }
catch (error) { console.error(error.message); process.exitCode = 1; }
JS
```

Expected `PRODUCTION_CONFIG_VALID`, exit 0. This uses the checked-in production vars and the two exact secrets; it is valid only after the operator confirms there are no deployed secret overrides of those vars and no extra invalid numeric overrides. If overrides exist, STOP and reconcile the release configuration with the user; this plan does not authorize changing unrelated bindings. Confirm Google audiences and the administrator allowlist against the intended deployment without posting email values to logs or chat.

## Read-only emptiness and database-health gate

Keep the approved secret variables in the same shell. Run immediately before migration and again immediately before deployment. The operator must prevent registrations during this interval using the deployment's approved maintenance procedure; if that cannot be confirmed, STOP rather than race the old provisioning code.

```bash
node --input-type=module - <<'JS'
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const result = await client.query('SELECT count(*)::text AS count FROM public.users');
  await client.query('ROLLBACK');
  if (result.rows[0].count !== '0') {
    console.error('STOP: users are not empty; consult the user. No mutations authorized.');
    process.exitCode = 2;
  } else console.log('USERS_EMPTY_AND_DATABASE_REACHABLE');
} catch {
  console.error('STOP: database validation unavailable'); process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
JS
```

Expected `USERS_EMPTY_AND_DATABASE_REACHABLE`, exit 0. Nonzero count means STOP and consult the user; do not delete rows or backfill subjects. A failed connection means STOP. This check performs no account writes.

## Migration gate

After empty-table verification and explicit migration authorization:

```bash
node --input-type=module - <<'JS'
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='google_subject'");
  if (rows.length !== 1) throw new Error('missing migration column');
  const constraint = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_google_subject_unique' AND contype='u'");
  if (constraint.rows.length !== 1) throw new Error('missing migration constraint');
  console.log('IDENTITY_MIGRATION_APPLIED');
} catch {
  console.error('STOP: migration or schema verification failed; inspect through approved private diagnostics');
  process.exitCode = 1;
} finally { await pool.end(); }
JS
```

Expected `IDENTITY_MIGRATION_APPLIED`, exit 0. This uses the existing Drizzle journal workflow without printing raw SQL/driver errors or connection strings. Do not run `drizzle-kit push` or remove the nullable subject column. Stop if earlier migration history is inconsistent.

## Deployment gate

After the user authorizes the release, all local checks pass, exact production configuration is validated, and the read-only gate is rerun successfully with registrations still held:

```bash
npx wrangler deploy
unset DATABASE_URL JWT_SECRET
```

Expected successful upload/deployment of `fan-novel-server` and a version ID. Record the version ID, not secrets. Preserve `wrangler.toml` and all R2 bindings/assets unchanged. Do not run any R2 commands. Resume registrations only after the operator confirms the hardened version is active.

For read-only post-release health, enter the HTTPS deployment origin printed by Wrangler:

```bash
read -r -p 'Deployed HTTPS origin: ' PHASE1_ORIGIN
export PHASE1_ORIGIN
node --input-type=module - <<'JS'
try {
  const url = new URL('/health', process.env.PHASE1_ORIGIN);
  if (url.protocol !== 'https:') throw new Error('HTTPS required');
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || body.db !== 'up') throw new Error('unhealthy');
  console.log('DEPLOYED_DATABASE_UP');
} catch { console.error('STOP: deployed health check failed'); process.exitCode = 1; }
JS
unset PHASE1_ORIGIN
```

Expected `DEPLOYED_DATABASE_UP`, exit 0. Do not infer success merely from `status: ok`; require `db: up`. Inspect only redacted account events through approved observability access. A creation event contains `event`, `requestId`, `accountId`, and `outcome`, once per inserted account; repeated unchanged login has no account writes or provisioning event. No tokens, emails or secrets belong in these events. No live login test is included; obtain separate approval before one. On failure keep bindings/column intact and use a fixed secure release or temporary unavailability.
````


### Task 31: Commit the release documentation

- [ ] Run:

```bash
git diff --check
git add docs/superpowers/runbooks/phase1-security-release.md
git commit -m "docs(auth): document gated security release and recovery"
```

Expected: exit 0; only the runbook is committed.

### Task 32: Run final full implementation verification

- [ ] Run:

```bash
npm run typecheck && npm test && PHASE1_PG_URL='postgresql://phase1:phase1-local-only@127.0.0.1:55432/phase1_identity_test' npm test -- src/routes/googleAccount.postgres.test.ts && npm run build && npx drizzle-kit check && git diff --check
mkdir -p /tmp/opencode/fan-novel-phase1-dry-run
npx wrangler deploy --dry-run --outdir /tmp/opencode/fan-novel-phase1-dry-run
git status --short
```

Expected: all commands exit 0, full Vitest suite passes, all four PostgreSQL tests pass without skips, build succeeds, schema check succeeds, dry-run reports bundling without a real deployment, and no unintended source/config changes appear. If any gate fails, stop and fix/review the relevant scoped task before release; do not claim acceptance from mocked tests alone.

### Task 33: Remove only the disposable test container

- [ ] Run:

```bash
docker stop fan-novel-phase1-pg
```

Expected: `fan-novel-phase1-pg`, exit 0. The container was created with `--rm`; this removes only the local fixture instance created in this plan, not production storage.

### Task 34: Obtain explicit deployment authorization

- [ ] Ask the user: **“The local Phase 1 verification gates have passed. Do you authorize applying migration 0006 and deploying the hardened Worker, with registrations held during the empty-table/migration/deploy interval? This does not authorize a live login smoke test.”** Acceptance: explicit approval, operator confirmation of maintenance/secret-source access, and recorded local verification results. If approval is absent, STOP with implementation complete but deployment not performed. This is a human gate, not a shell command.

### Task 35: Validate exact release configuration

- [ ] With Task 34 approval recorded, run the complete Bash/Node block in the runbook section **Actual production-value validation (no value output)** in one persistent shell. Acceptance: operator confirms exact secrets, no undisclosed var/numeric overrides, correct admin allowlist/audiences, and `PRODUCTION_CONFIG_VALID`, exit 0. If not, STOP. Keep secret variables in this shell for the following gates; never enable shell tracing.

### Task 36: Confirm production emptiness without writes

- [ ] Run the complete Node block in the runbook section **Read-only emptiness and database-health gate**. Acceptance: operator confirms registrations are held and the command prints `USERS_EMPTY_AND_DATABASE_REACHABLE`, exit 0. Unexpected rows require consultation, not deletion or backfill.

### Task 37: Apply the authorized additive migration

- [ ] Run the complete Node block in the runbook section **Migration gate**, using the previously authorized release shell. Acceptance: `IDENTITY_MIGRATION_APPLIED`, exit 0, confirming both column and unique constraint. Stop on any failure; retain the additive schema and identity bindings.

### Task 38: Recheck emptiness immediately before upload

- [ ] Repeat the exact read-only Node block in the runbook section **Read-only emptiness and database-health gate** while registrations remain held. Acceptance: `USERS_EMPTY_AND_DATABASE_REACHABLE`, exit 0. No deployment is permitted if rows have appeared.

### Task 39: Deploy the authorized hardened Worker

- [ ] Run the first Bash block in the runbook section **Deployment gate**: `npx wrangler deploy`, followed by `unset DATABASE_URL JWT_SECRET` in the same shell. Acceptance: successful upload of `fan-novel-server` and a version ID, with unchanged R2 bindings/assets. Record only the version ID and redacted outcome. Stop on upload failure; do not revert to permissive login code.

### Task 40: Verify read-only deployed database health

- [ ] Run the complete HTTPS-origin/Node health block in the runbook section **Deployment gate**. Acceptance: `DEPLOYED_DATABASE_UP`, exit 0, then operator confirms the hardened version is active before resuming registrations. A live login smoke check is separately approval-gated and is not part of this task. On failure, keep schema/subject bindings intact and prefer a fixed secure release or temporary unavailability.

## Coverage and audit map

1. Config/mode/default/byte-length/cache/Worker isolation: `src/config/env.test.ts`; invalid app initialization tested through `createApp`.
2. Shared signing and verification, dev-key config versus dev-signed-token rejection, issuer/audience/expiry: `src/middleware/auth.test.ts`.
3. Every required tokeninfo claim, true normalization, invalid/malformed/upstream failures: `src/routes/googleIdentity.test.ts`; development invalid-token fallback denial in route tests.
4. Client ID irrelevance, verified bootstrap/body mismatch, protected PATCH fields: `src/routes/auth.identity.test.ts`.
5. Push/pull/stats existing-only production resolution, case-variant email lock, null development anchors, owner mismatch: `src/routes/sync.identity.test.ts`.
6. Single insert, repeat no writes, conflict/no-heal behavior and email-change atomicity: route suite plus mandatory barrier-driven PostgreSQL suite.
7. Availability false and post-check query failure on login/GET/PATCH, populated memory isolation, missing-account 401: route suite. DB proxy initialization failures are thrown at the same query boundary; no driver code changes are needed.
8. Compatible login wire response and usable JWT: route suite; unknown production sync subjects denied in sync suite.
9. Exactly-once redacted creation event and generic storage responses: route and PostgreSQL suites. Existing unrelated database module diagnostics are not expanded or advertised as remediated; this phase never logs raw caught auth exceptions.

Self-review notes: preserved the full generated-style snapshot and monotonic journal metadata; included stats in the shared sync invariant; rejected empty supplied tokens rather than treating them as absent; isolated `dev_` fixtures even with a configured DB; moved middleware continuation outside JWT catch; checked all environment fields without stale cache or Node-to-Worker inheritance; made PostgreSQL race testing mandatory; kept deployment, secret-value, maintenance, empty-table and live-login approvals distinct.
