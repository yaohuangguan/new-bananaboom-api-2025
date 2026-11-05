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

## Authentication foundation (not yet live on Gateway)

Private listing implementation validates signed HS256 JWTs, checks the matching
`auth:<token>` record in MongoDB `sessions` (including 30-day expiration),
loads current `users` and `roles` permissions, then checks `PRIVATE_POST:READ`.
It accepts legacy `x-auth-token`, Bearer tokens and the `orion_session` cookie.

**IMPORTANT:** `/api/posts/private/posts` intentionally stays routed to
Cloud Run until the old short JWT key can be safely rotated, the Worker
`SECRET_JWT` secret is configured, and a real signed-in session is regression
tested. Do not allowlist this endpoint prematurely. Never commit signing keys.

Public `GET /api/posts` now queries only the author fields used by the
public UI (`_id`, `displayName`, `photoURL`). The Gateway independently
redacts both Worker and fallback Cloud Run post-list/detail responses.

## Anonymous public article details

`GET /api/posts/:id` resolves only public Mongo posts and populates minimal
author fields. Credentialed requests are delegated to Cloud Run for now.

## Versioned JWT migration

`authenticateLegacyRequest` now recognizes legacy HS256 JWTs without
a key ID and v2 HS256 JWTs with `kid=orion-v2`. It requires an exact
live MongoDB session and current RBAC permissions for either key. The
Worker runtime reads `SECRET_JWT` and optional `ORION_JWT_NEXT_SECRET`.
Neither secret is provisioned for private production routing yet.
Do not allowlist authenticated routes until key provisioning, dual-key
tests and live browser checks pass. See `docs/WORKERS-MIGRATION.md`.

## Public post-like count reads

Anonymous `GET /api/posts/likes/:id` is now handled by the Worker with a
public-post constraint. Authenticated reads and write operations remain
on Cloud Run.

## Public menu and private read canary

`GET /api/menu` (including one optional `category` query) mirrors the
legacy public menu list. Writes, draw and AI menu actions stay on Cloud Run.

The Gateway has an opt-in header-based canary for
`GET /api/posts/private/posts` only. This is not general private cutover.
Server-side live session/RBAC verification and secret provisioning must pass
before any authenticated read traffic is switched by default.

The opt-in private read canary reports bounded diagnostic stages to the
Gateway if session verification or a private post query fails. It never
includes request tokens, keys, user data, or MongoDB connection information.

Authenticated article detail `GET /api/posts/:id` requires a verified JWT,
live MongoDB Session and live `PRIVATE_POST:READ` permission when the article
is private; missing or disallowed articles return 404. Public article details
remain readable without login. Writes and Google identity flows remain on
Cloud Run.

## Like mutations

`POST /api/posts/likes/:id/add` and `.../remove` use an atomic MongoDB
counter operation (remove requires `likes > 0`), do not modify
`updatedAt`, and return the legacy like-count JSON. The Gateway enforces a
30/IP/minute limit and MUST NOT replay ambiguous failed writes at Cloud Run.
See `docs/WORKERS-MIGRATION.md`.
