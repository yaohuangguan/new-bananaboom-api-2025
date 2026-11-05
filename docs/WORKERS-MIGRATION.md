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
