# Orion API Cloud Run retirement readiness
Status 2026-11-06: NOT READY FOR CLOUD RUN SHUTDOWN.

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
- Socket.IO group chat, private chat, presence and online notifications
- Upload, photos, R2 management and Cloudinary utilities
- Backup and export using mongodump/Chromium/local filesystem
- AI, reading, drawing, voice2map, debater and RPG features
- Todo, fitness, period, footprints, comments and related CRUD
- CMS write methods beyond articles: resume, projects, menus, tags, homepage
- Stripe webhook/legacy subscriptions, cron/scheduler and external callbacks

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
