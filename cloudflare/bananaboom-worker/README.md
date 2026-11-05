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
