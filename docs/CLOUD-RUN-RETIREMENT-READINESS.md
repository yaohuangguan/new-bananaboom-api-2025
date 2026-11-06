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
