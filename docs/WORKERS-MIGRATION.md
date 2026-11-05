# BananaBoom / Orion API migration to Cloudflare Workers

Last verified: 2026-11-05.

## Live architecture

- `api.samyao.me` stays on the `orion-api-gateway` Worker.
- Internal Service Binding routes approved public GET requests to `bananaboom-core`.
- The MongoDB Durable Object uses the existing MongoDB database and a reusable connection.
- Every other method/path stays on Cloud Run with the existing origin secret and permission middleware.
- Core Worker's public `workers.dev` endpoint is disabled.
- Errors from the new Worker (5xx or binding exception) trigger the existing Cloud Run fallback.

## Public GET paths switched

- `/api/homepage`
- `/api/homepage/likes`
- `/api/homepage/projects`
- `/api/homepage/logs`
- `/api/projects`
- `/api/posts` (public list, pagination and search)
- `/api/tags` (public tags only, never type=private/all)

Both sets were compared against the original Cloud Run responses. The 2026-11-05
second-phase production cutover compared seven request variants with pre-cutover
SHA-256 hashes; all matched exactly, including paginated posts and tag access.

## Remaining Cloud Run dependencies

- Auth/OAuth and permissions, especially private views and writes
- Blog post details (private-post access checks), create/update/delete and likes
- Portfolio management, GitHub imports, AI rewriting and SSE
- User/admin services and personal modules (fitness, journals, menu, etc.)
- R2 media management and signed uploads
- Second Brain, encryption, backup, OAuth MCP and other private services
- Socket.IO and any long-lived transport, scheduled jobs and resume PDF generation

The API is **not fully migrated**. Keep the final `bananaboom-api` Cloud Run
service and its active Docker image until all required routes are ported and tested.
The Google Cloud Build triggers were disabled to prevent accumulating images.

## Stripe decision

Old code at `routes/payments.js` was written for `orion_english`, `ai_rpg`
and `debater` membership tiers, not the current blog. No frontend Stripe or
checkout calls were found in the active `orion-frontend` source, no `STRIPE_*`
environment bindings were found on current Cloud Run, and sampled 90-day
request logs did not return Stripe/payment endpoints. This does **not** prove
that no external webhook is configured. Stripe is intentionally **not**
reimplemented in Workers; leave the old route untouched until full retirement
is verified. Do not copy any placeholder payment API keys into the Worker.

## Rollback

Restore the last known good `orion-api-gateway` deployment from Wrangler or
remove the newly allowed paths from `shouldRouteToCoreWorker`. Cloud Run still
serves all paths and can recover the switched GET endpoints. Disable the
Cloudflare Service binding only after restoring the gateway paths.

## Phase 3: auth parity + public-post privacy

- Prepare a Worker auth adapter: HS256 verification, session `auth:<token>` DB
  allowlist and TTL, live user roles + extraPermissions, RBAC.
- Prepare private-post listing, but keep Cloud Run as its production origin
  until production JWT key rotation and end-to-end signed-in verification.
- Cloud Run signing key (checked without revealing it) is shorter than the
  new Worker's minimum security baseline. Do not copy or rotate in place.
- Gateway redacts author records on public post list and detail, including
  Cloud Run fallback responses. Only `_id`, `displayName`, `photoURL` survive.
- Public post DB projection in the Worker now limits the author fields directly.

## Anonymous public article detail cutover

- `GET /api/posts/:id`, where `:id` is a 24-character Mongo ObjectId,
  can run on Workers for requests **without** Cookie, Authorization,
  `x-auth-token` or `x-google-auth` headers.
- The Mongo query enforces `isPrivate: false`; absent/private posts return
  404 for anonymous users.
- Requests carrying credentials stay on Cloud Run; the private listing is
  intentionally not in the Worker Gateway allowlist.
- Six distinct real article detail responses were checked in local Wrangler
  against sanitized production responses, with exact JSON equality.
