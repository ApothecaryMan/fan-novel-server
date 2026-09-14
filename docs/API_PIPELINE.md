# API Request Pipeline

The single order every request flows through. Deliberately small: this API has
~15 endpoints, so the pipeline is five stages, not a framework.

```
requestId → logger → cors → route match → validate → session → policy → handler → envelope
```

Dropped from the original proposal (documented so nobody re-adds them):
- **ExpressAdapter** — nothing to adapt; Hono is the server. The platform edge
  (`@hono/node-server` `serve`) wraps the whole pipeline once in `index.ts`.
- **Rendering stage** — JSON API, there is no rendering. Handlers return domain
  objects; `prettyJSON` only formats.

## Stage contract

| # | Stage | Where | Rule |
|---|-------|-------|------|
| 1 | Identify + log | `index.ts`: `requestId()`, `logger()` | Every log line carries the id; first so nothing executes unlogged. |
| 2 | CORS | `index.ts`: `cors(...)` | Before anything that can reject — preflights never hit formatting or auth. |
| 3 | Match | Hono router | Public routes (`/health`, `/api/v1` docs) stop here: no session cost. |
| 4 | Validate | zod `safeParse` per route (`sync.ts` schemas) | Malformed input → **400**, never 500. The mobile outbox drops 400s and moves on; 500s would retry forever and wedge the queue. |
| 5 | Session | `verifySubject` (open) / `requireAuth` (closed) | `SYNC_OPEN=false` requires a valid Bearer JWT; default true is anonymous (LAN-first). Session is route-scoped, never global. |
| 6 | Policy | inline owner check (`sync.ts`) | One policy exists: **a caller touches only its own `externalId`**. An authenticated caller whose token `sub` differs from `body.user.externalId` gets **403**. Anonymous callers on open deployments skip it (nothing to compare). |
| 7 | Handler | route files | Domain logic only: no shape-checking, no envelope-building. |
| 8 | Envelope | `prettyJSON` + `app.onError` | Success: existing `{success, …}` shapes. Any throw → `{error, requestId}` 500, jamás HTML. |

## Status-code contract (clients rely on this)

| Code | Meaning | Client action |
|------|---------|---------------|
| 200 | Applied / data | Advance cursors, delete acked ops |
| 400 | Invalid payload (zod `issues` included) | Drop the op, do not retry |
| 401 | Missing/invalid token (closed mode) | Pause sync, keep queue, never log out |
| 403 | Token valid but not the owner | Drop the op, surface once |
| 500 | Server fault (`requestId` included) | Retry with backoff |

## Ordering authority (sync-specific, restated here because the pipeline must not change it)

Client edit-time clocks (`updated_at`/`read_at`/`deleted_at`, UTC epoch ms)
order everything. `received_at` is audit/GC only. Tombstone beats live
regardless of clock; else larger `updatedAt` wins; ties union categories.
Sessions merge additively over `client_session_id` (`ON CONFLICT DO NOTHING`).
