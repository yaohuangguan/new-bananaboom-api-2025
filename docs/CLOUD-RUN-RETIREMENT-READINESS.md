# Orion API Cloud Run retirement readiness
Status 2026-11-07: NOT READY FOR CLOUD RUN SHUTDOWN.
Current and target diagrams: [ARCHITECTURE.md](ARCHITECTURE.md).
The Cloudflare R2 database backup and résumé PDF are live; auth, MCP and
other legacy route dependencies still prevent safe shutdown.

## Native Worker completed
Public homepage, project, menu, tag and article GETs; selected private
article reads with JWT + live Session; public likes updates; incremental
admin audit feed; Durable Object Mongo connection and scheduled Bark outbox.
Blog article create, update and delete are now implemented with a single
MongoDB transaction and an idempotency receipt, but production Gateway
cutover requires signed-in end-to-end verification.

## Still handled by Cloud Run
- Legacy and Google sign-in, registration, password reset, roles/sessions,
  legacy OAuth, Vault OAuth and Second Brain sync/import/export/restore
- Obsolete human chat/Socket.IO paths are blocked (410) at Gateway; the
  legacy code still exists pending final resource retirement.
- Upload, photos, R2 management and Cloudinary utilities
- The old mongodump/PDF implementation remains in Cloud Run only as legacy
  source/rollback; normal database backup and public résumé PDF already
  use Cloudflare Worker/R2 and Browser Run respectively.
- AI, reading, drawing, voice2map, debater and RPG features
- Todo, fitness, period, footprints, comments and related CRUD
- CMS write methods beyond articles: resume, projects, menus, tags, homepage
- Retired Stripe/human chat routes are blocked (410) at Gateway; remaining
  native Cron migration and any external callbacks must still be audited.

## Current architecture owner and hard stop

The **single current route ownership source** is
`cloudflare/orion-api-gateway/src/index.js` plus its `wrangler.toml`
cutover flags. Only `BACKUP_R2_CUTOVER=1` and `PDF_BROWSER_CUTOVER=1`
are globally cut over for these two flows. The other private route flags
remain off. An implemented Worker handler alone is not acceptance.

Critical path: live login/OAuth, Second Brain MCP and sync,
owner-scoped personal CRUD, media uploading, AI/history streaming, native
Todo Cron without duplicate reminders. The Vercel frontend remains unchanged.
Record a complete route/method/auth inventory and a representative zero-
required-upstream observation period before the Cloud Run off switch.

## Runtime platform blocking factor
Cloudflare 7199 account currently returns Unauthorized for wrangler
containers list: Cloudflare Containers requires Workers Paid plan for this
account. The WSL environment also has no Docker CLI. A Worker + Container
compatibility backend is a possible alternative to rewriting every native
business route, but it IS NOT currently provisioned or deployed.

## Shutdown gate
Do not delete the final Cloud Run service, its revisions or its image until:
1) all used methods on all paths have Cloudflare parity;
2) authentication, OAuth, payments/webhooks, WebSocket, Cron and background
   backups have E2E tests and a reachable recovery endpoint;
3) production monitoring shows no Cloud Run upstream traffic across a
   representative usage period (including rare/weekly jobs);
4) service shutdown has been first rehearsed reversibly, rollback tested,
   and any necessary DB export/recovery artifact preserved.

A Cloudflare Worker gateway is already in front of the service; that DOES
NOT mean the legacy business process can be turned off.

## Footprint record ownership hardening (2026-11-06)

Legacy Express footprint detail GET, PUT and DELETE are now restricted to
`{ _id, user: authenticatedUser.id }` in the source; updates and deletes
use single, owner-scoped database operations, and missing/foreign records
receive the same 404 response. Integration tests cover unauthorized IDs,
legitimate owner operations, and successful audit persistence.

**Source merge alone does not patch an already running Cloud Run revision.**
Until a controlled Cloud Run revision is deployed, or these methods are
replaced with fully parity-tested owner-scoped Worker methods, the original
production implementation may still permit cross-user record-ID access.
Treat this as a migration security gate; do not declare full Cloud Run
retirement or ownership remediation complete from a Git merge alone.


## Production R2 MongoDB backup verified (2026-11-07)

Private R2 owner-authenticated snapshot and isolated restore succeeded:
36 collections, 1,271 documents, 32 parts, 7,220,817 bytes; all chunk
SHA-256 checks and 65 secondary-index checks passed.
The Gateway now routes normal POST /api/backup/database to Core Worker by
BACKUP_R2_CUTOVER=1, with NO retry to Cloud Run on a Worker failure.
The old Cloud Run backup implementation may still exist as emergency fallback,
but normal API Gateway traffic no longer uses it. Preserve Cloud Run for other
routes and do not claim whole-service migration complete.


## Safe Cloud Run dependency observation (2026-11-07)

Gateway now emits an aggregate-category log ONLY when it actually forwards an
API request to Cloud Run: orion-legacy-upstream + category + HTTP method.
It does not log path IDs, query strings, user IDs, cookies, tokens, bodies,
sessions or IPs. LEGACY_UPSTREAM_AUDIT=1 enables this metric.
An actual read fallback to Cloud Run is counted; a Worker-successful request
is not. A short empty log cannot prove zero legacy dependencies: observe
enough time to cover rarely used OAuth, MCP, administrative and scheduled jobs.

## Owner-scoped infrastructure decision

The React/Vite frontend stays on Vercel and keeps its edge CDN and deployment pipeline. The final target replaces only Cloud Run execution with Cloudflare Workers. Historical owner-written Express code stays in Git, even after Cloud Run has no live traffic. PASSWORD_AUTH_CUTOVER remains 0 until real-user browser E2E parity; Google/Firebase and Second Brain OAuth cannot be dropped or silently re-authenticated.

## Second Brain read-only canary (2026-11-07)

The official MCP SDK Web Standards read transport and REST search/read use
existing Brain credentials, permission and resource checks. They passed local
and isolated Replica Set tests. BRAIN_READ_CUTOVER stays 0 and all normal MCP
and sync_knowledge writes remain Cloud Run. Existing OAuth/PKCE/refresh,
private encrypted blob storage and transaction parity remain blockers.
See [BRAIN-WORKER-MIGRATION.md](BRAIN-WORKER-MIGRATION.md).

## MongoDB Durable Object code-update caveat

Cloudflare's October 2026 deferred Durable Object code updates can leave an
active DO serving old RPC methods temporarily after a Worker deploy.
Brain canary returned 503 on RPC method mismatch and returned the expected
401 for a fake test token after one-off immediate Core deployment.
Do not permanently force immediate updates: active backups may be disrupted.
Deploy new DO APIs before Gateway cutover, verify adoption, and fail closed
on version mismatch instead of bypassing owner validation.

## Second Brain encrypted originals and write/OAuth milestone

The source GCS memory vault contained **66 encrypted objects / 148,905 bytes**; a separate *private* R2 bucket now holds all 66 with read-after-write SHA-256 parity, preserving GCS originals. Worker `sync_knowledge` transaction and OAuth authorization-code/refresh grants passed isolated Replica Set and HTTP tests. All normal traffic and canary flags still target Cloud Run because the original private encryption key has not been safely provisioned into Core and discovery/DCR/consent/import/export/restore plus authorized client acceptance remain. See [BRAIN-WRITE-OAUTH-MIGRATION.md](BRAIN-WRITE-OAUTH-MIGRATION.md). Never treat an encrypted-object copy as proof of restore without a controlled decryption check.


## Active GCS moved to US free-tier region (2026-11-07)

A private, uniform-IAM, public-access-prevention GCS Standard bucket
`orion-brain-vault-us-242273127238` in `us-central1` now contains
**66/66 byte-identical encrypted originals / 148,905 bytes**.
The SHA-256 summary matches Taiwan and private R2. The original GCS
HMAC service account has bucket-scoped `storage.objectUser` permission;
the Cloud Run service was updated to the US bucket and returned Ready.
Public endpoints, OAuth discovery and existing MCP search passed
post-deploy smoke checks. However, authorized `getPrivate` decrypt
and actual legacy write→read with the new bucket have **not** yet
been exercised. The Taiwan bucket is retained pending rollback
acceptance; the new bucket's free-tier eligibility alone does not
guarantee zero cross-region operation or Cloud Run charges.
See [GCS US migration](ORION-GCS-US-MIGRATION.md).

## Todo owner mutations staged (2026-11-07)

Core/DO now has owner-scoped Todo detail, create, update, delete and
routine check with live RBAC, strict payloads and transactional audit
plus idempotency receipts. Core suite **102 pass, 1 skip**; Gateway
**76 pass**; isolated localhost MongoDB CRUD/concurrency/role
tests passed. **TODO_WRITE_CANARY=0** and
**TODO_DETAIL_READ_CUTOVER=0**: no normal production Todo mutation
has been switched. User-facing browser E2E, large legacy-list parity,
notification-test endpoint, and paused reminder Cron acceptance are
still prerequisites. See [Todo Worker migration](TODO-WORKER-MIGRATION.md).

**Retirement verdict remains FAIL**: many owner CRUD, AI and OAuth routes
still require Cloud Run. Neither the US bucket move nor a successful
Todo canary should be mistaken for shutting Cloud Run down.


## OAuth discovery and real Todo route correction (2026-11-07)

Source inspection found that the original Express `index.js` mounts
`routes/todo.js` at **`/api/todo`** (singular), while earlier staged
Core/Gateway implementations and tests used `/api/todos`. Both mounts
are now supported by Core and Gateway, with explicit contract tests
that assert the ACTUAL legacy route. `TODO_WRITE_CANARY` and
`TODO_DETAIL_READ_CUTOVER` remain **0**; this correction alone does
not enable a production mutation. The plural alias remains only for
compatibility, not as evidence of migration success.

The two existing *public* Orion Brain OAuth discovery documents have
also been implemented in native Core (no credential or MongoDB access):
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/api/brain/sync/mcp`.
Gateway has an explicit `x-orion-brain-metadata-canary: 1` path and
`BRAIN_METADATA_CUTOVER` flag. OAuth `authorize`, `token`, `register`,
`revoke`, consent and existing ChatGPT/Claude connections are
**unchanged**, still on Cloud Run. Public metadata can be cut over
independently after production exact-JSON parity is verified.


### Live public OAuth discovery cutover (2026-11-07)

Two **read-only, public** discovery documents were compared with the
existing Cloud Run SDK through the production Gateway canary:
authorization metadata had **12/12 matching JSON fields**, and MCP
protected-resource metadata had **4/4 matching fields**. Both were
explicitly verified to carry `x-bananaboom-origin: worker` on canary,
while ordinary requests still carried legacy origin during comparison.

On this evidence `BRAIN_METADATA_CUTOVER` was promoted to **1**,
routing only GET requests without queries to these exact paths:

- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource/api/brain/sync/mcp`

No authorization codes, credentials, user knowledge, refresh tokens,
DCR client registration or revocations were read or modified.
`POST /token`, `/authorize`, `/register`, `/revoke` and the Second Brain
API/MCP authenticated operations remain on Cloud Run. On a genuine
Core metadata read failure, Gateway can safely retry the unchanged
read-only Cloud Run SDK document. Revert the single `BRAIN_METADATA_CUTOVER`
flag to `0` if production metadata behavior diverges.


## Owner-scoped Footprint writes staged (2026-11-07)

New Cloudflare Core/DO handlers for the existing
`POST /api/footprints`, `PUT /api/footprints/:id` and
`DELETE /api/footprints/:id` preserve the existing Mongo collection
and legacy JSON responses. All writes enforce live signed user Session,
`FOOTPRINT:USE`, record-owner equality, field allowlists and request
origin; record/audit/idempotency receipt commit atomically. Gateway
canary `FOOTPRINT_WRITE_CANARY=0` remains disabled. The backend test
suite reports Core **109 pass / 1 skip**, Gateway **85 pass**; a
real isolated localhost Mongo Replica Set verified cross-owner denial,
concurrent same-key writes, audit consistency and revocation. Two
Wrangler dry-run builds passed. **No production user footprint write
was performed.** See [Footprint Worker migration](FOOTPRINT-WRITE-MIGRATION.md).

The existing Cloud Run deployment must independently be verified to
contain the owner-scoped source fix before deleting the legacy
route. Until real user/browser parity and stable idempotency keys
are confirmed, it remains a Cloud Run dependency.


## Native public reads expanded after production request audit (2026-11-07)

A bounded Cloud Run request log sample (350 HTTP requests from last 48 hours)
contained currently used Second Brain `POST /api/brain/sync/mcp`, OAuth
`POST /token`, and profile requests. Thus Cloud Run **must remain on**.
The sample is not a full traffic histogram, and may contain direct-origin
access and automated traffic.

Two already-defined PUBLIC read routes were reconciled with real clients:
- `GET /api/posts?page=1&limit=1000` was historically rejected by
  Gateway's overly narrow 50-item limit and fell back to Cloud Run.
  Live data has **24 public posts**, so the existing Worker can return all
  24 with original `perPage:1000` metadata. The public-only MongoDB filter
  stays `isPrivate:false`, as before. The limit stays hard-bounded at 1000.
- Existing `GET /api/comments/:postId` and
  `GET /api/comments/reply/:commentId` now support signed-in clients in
  Core. The previous Gateway switched only anonymous comments; legitimate
  JWT-bearing readers fell back to Cloud Run. The Core verifies a carried
  JWT's signature and expiry, then checks the live Session if one exists;
  invalid/expired tokens get HTTP 401 (not an anonymous bypass) and a
  valid JWT whose Session expired retains the legacy **public guest**
  behavior. Google-only login continues through Cloud Run.

Both operations are GET-only and read shared PUBLIC data. No authenticated
comments or private article records become readable. Write paths are not
changed. Worker 5xx on GET can safely fall back to Cloud Run during rollout;
Cloud Run code and all existing auth mutations remain intact.
