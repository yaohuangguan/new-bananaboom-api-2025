# Orion Todo Worker — staged authenticated CRUD and routine canary

**2026-11-07: code and isolated tests passed; production cutovers OFF.**

This migration retains the Vercel frontend, existing MongoDB `todos` and
`audit_logs` collections, the old Express source and the original Cloud Run
runtime for normal requests. No real user Todo was changed.

## Stage implemented in Core Worker + MongoDB Durable Object

| Method | Path | Legacy behavior mirrored |
| --- | --- | --- |
| `GET` | `/api/todos` | Existing paginated list Worker canary; unchanged |
| `GET` | `/api/todos/done/:id` | Private populated task detail, now owner-scoped and authenticated in Worker |
| `POST` | `/api/todos` | Create wish/routine, defaults, notifyUsers and recurrence, returns populated legacy list |
| `POST` | `/api/todos/done/:id` | Update task/status/reminder, returns populated legacy list |
| `POST` | `/api/todos/routine/:id/check` | Move a routine to its next timezone-aware scheduled run; no Bark send |
| `DELETE` | `/api/todos/:id` | Delete owner/family-scoped task, returns `{success:true}` |

The staged Worker does **not** yet implement
`POST /api/todos/routine/:id/test` (Bark/Socket test notification).

### Security and failure isolation

- Gateway forwards only a narrow method + exact path allowlist. Google-only
  identity is excluded; require an existing signed JWT or session cookie,
  validated again by Core via JWT HS256 + existing live MongoDB Session.
- Current role/permissions (including `TODO:USE`) and family membership are
  rechecked inside a MongoDB transaction before any mutation or receipt
  replay. Non-admin users only access their own records. Super admins may
  access only the existing `super_admin` family, never arbitrary other users.
- Notification recipients are also limited to authorized family membership;
  no caller-supplied `user`, `ownerId` or MongoDB operators are accepted.
- Safe, bounded and schema-validated payloads; creation/updates preserve
  the historical MongoDB Todo fields, Mongoose defaults, timezones, Bark
  config and public user/notifyUsers projections.
- A required `Idempotency-Key` on every write prevents a timeout from
  generating a second task, double completion or repeated check-in.
  Receipt `_id` is deterministic SHA-256 of operator, action and key;
  duplicate payloads reuse receipt; same key with different content is
  HTTP 409. Mutation, audit and receipt commit in one transaction.
- Mutations returned by Core as a 5xx, or whose result is unknown, are
  **never** replayed through Cloud Run. An end user/client must retry
  only with the **same** idempotency key after checking results.
- Original `GET /api/todos/done/:id` lacked route-local auth. New Worker
  detail path always validates live session and owner scope. Normal detail
  traffic remains legacy until the production flag and browser E2E pass.

### Production flags remain OFF

| Component | Setting | Value |
| --- | --- | --- |
| Gateway | `TODO_READ_CUTOVER` | `0` |
| Gateway | `TODO_DETAIL_READ_CUTOVER` | `0` |
| Gateway | `TODO_WRITE_CANARY` | `0` |
| Core | `TODO_REMINDERS_ENABLED` | `0` |

A planned write canary would require all of:

1. Server owner explicitly enables `TODO_WRITE_CANARY=1` temporarily.
2. Valid `x-orion-todo-write-canary: 1` plus signed user session.
3. A new per-action `Idempotency-Key` (8–128 safe characters) reused
   unchanged on retries.
4. Live owner/family RBAC and valid task schema inside Core/DO.

While the server flag is 0, *normal writes and even caller-supplied canary
headers* continue to Cloud Run. Authenticated detail GET supports an
explicit `x-orion-todo-detail-canary: 1` during verification, but default
traffic remains legacy.

The Worker also preserves the existing behavior where Cloud Run's Todo
scheduler is paused; **do not enable the native Cron without checking all
historical overdue reminders and avoiding mass sends**.

### Independent evidence

- Core Node tests: **102 pass / 1 optional skip / 0 fail**.
- Gateway Node tests: **76 pass / 0 fail**.
- Both Wrangler `deploy --dry-run` builds passed.
- Real ephemeral **localhost** MongoDB Replica Set:
  create, update, complete, delete, routine check-in, same-key retry,
  concurrent same-key creation, cross-owner denial, unauthenticated
  detail protection, live permission revocation, family-only notification
  recipients, exact persisted audit counts and rollback.
- Only synthetic users and tasks were used. **No production Todo write,
  real password/cookie login or Google auth migration is claimed.**

Repro:

    node --test cloudflare/bananaboom-worker/tests/*.test.mjs
    node --test cloudflare/orion-api-gateway/*.test.mjs
    node scripts/test-orion-todo-replset.mjs

### Remaining Todo acceptance gates before global cutover

- Real signed-in browser E2E (including current Firebase/Google auth
  variations where applicable), create/update/delete, images and reminder
  behavior, role downgrade and family membership.
- Frontend must provide an `Idempotency-Key` for mutations before
  enabling a production write cutover. Do not silently route unsafe
  clients lacking the key.
- Validate legacy array response parity for users with large task lists
  (the canary caps a populated mutation response at **500 tasks** rather
  than returning a truncated list).
- Port test-notification behavior without unexpected pushes or leaked
  Bark credentials; enable native Cron only after a safe scheduler
  rehearsal and explicit decision.
- Confirm audit and permission matrices, service-binding version parity,
  real-traffic monitoring, rollback strategy and no required Cloud Run
  calls. Only then promote this cohort.

The original Express Todo files remain untouched in Git.
