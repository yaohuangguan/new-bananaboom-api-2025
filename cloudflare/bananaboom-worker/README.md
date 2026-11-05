# BananaBoom Workers migration — phase 1

Standalone Cloudflare Workers origin based on **openmesh-node 0.5.0**.
The existing Cloud Run API and the `api.samyao.me` gateway remain untouched.

Migrated read-only routes: GET /health, GET /, GET /api/homepage,
GET /api/homepage/likes, GET /api/homepage/projects, GET /api/homepage/logs.

Install and test in this directory: `npm ci && npm test && npx wrangler deploy --dry-run`.

Production MongoDB connectivity requires a Workers secret named `MONGO_URI`.
Set via `npx wrangler secret put MONGO_URI`; never commit it.

Writes, authentication, Stripe, Socket.IO, backups, and other routes remain
on Cloud Run pending separate migration and security parity tests.

All four read endpoints have been compared against the current production gateway
using the same MongoDB; their parsed JSON responses matched exactly (2026-11-05).
No production traffic has been switched. The first iteration uses one MongoDB
connection per request (roughly 1.2-1.4s on local WSL smoke tests).

## MongoDB connection pooling

The `MongoDBConnection` SQLite-backed Durable Object now owns a reusable
MongoDB client. Only the four public, read-only RPC methods are exposed.
It is named deterministically and located near the database (North America East
hint), and resets to a fresh connection if the Durable Object is evicted.
BSON values are converted to the legacy JSON shape before crossing the RPC
boundary. No SQL tables are created in the Durable Object.

After the first production gateway cutover, direct workers.dev access is disabled.
Production requests must enter via api.samyao.me and its Cloudflare Service binding.

## Production first-batch cutover (2026-11-05)

`api.samyao.me` continues to run through the existing `orion-api-gateway`.
The Gateway has a Cloudflare Service binding to this Worker and forwards only
these four public GET routes:
- `/api/homepage`
- `/api/homepage/likes`
- `/api/homepage/projects`
- `/api/homepage/logs`

All other paths, including writes, authorization, OAuth, media and backups,
continue to be served by the original Cloud Run backend. If the Worker fails
with a 5xx response or a service-binding exception on a migrated GET,
the Gateway falls back to Cloud Run.

The public `bananaboom-core.nzs.workers.dev` route is intentionally disabled,
so requests cannot bypass the Gateway's rate limit. Read responses retain
CORS support for `samyao.me` origins. Compare source via the response header
`x-bananaboom-origin: worker`.

The Google Cloud Build trigger for `bananaboom-api` is disabled while migrating,
to avoid rebuilding Docker images on every commit. Reactivate or redeploy manually
if you need a new Cloud Run revision before the complete migration.

## Additional public reads
- `GET /api/projects`: visible portfolio projects (order descending)
- `GET /api/posts`: only isPrivate=false posts, with paging/search/tags
- `GET /api/tags`: public tag counts only; private/all tag queries remain on Cloud Run

These routes are read-only. Protected post details and all write endpoints stay
on the existing Node backend until the authentication/permissions adapter is ready.
