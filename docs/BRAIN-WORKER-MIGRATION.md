# Second Brain read-only Worker / MCP migration

**Status (2026-11-07): implemented and integration tested; production cutover OFF.**

Existing ChatGPT/Claude OAuth connections and API keys must remain valid.
Normal requests still use Cloud Run; this canary is a migration safety gate.

## Implemented Worker routes

- `POST /api/brain/sync/v1/search` and
  `GET /api/brain/sync/v1/memories/:id` use existing Bearer `ov_` keys.
- `POST /api/brain/sync/mcp` uses the **official MCP SDK 1.32.1**
  Web Standards HTTP transport, stateless with JSON responses.
- MCP canary implements `initialize`, `tools/list`, `tools/call` for
  **search_knowledge** and **read_knowledge** only. It does not yet advertise
  `sync_knowledge`. Normal MCP clients remain on Cloud Run.
- Existing `braincredentials`, `brainconnections`, `brainmemories`, `users`
  and `roles` collections stay the source of truth. Token hashing, credential
  expiration, resource audience, revocation, scope and *current* owner
  `BRAIN:USE` permission are checked inside the MongoDB Durable Object for
  each operation. No caller-provided owner ID can grant access.
- Native Mongo reads preserve the legacy NFKC gram-search algorithm,
  escaped literal regular expressions, ascending ObjectId pagination,
  exclusion of rejected knowledge and safe public-memory projection.
- The Gateway removes the canary flag, cookies and spoofable edge headers,
  and never falls back to Cloud Run if Worker authorization or reads fail.

## Production routing switches

- `BRAIN_READ_CUTOVER="0"` keeps normal REST search and memory reads on
  Cloud Run. Canaries require `x-orion-brain-read-canary: 1` and a valid
  **existing** Bearer connection token.
- MCP routing is **always canary-only**, even if the REST cutover flag
  changes later. There is no normal MCP cutover until write parity.
- OAuth registration, PKCE authorize/approve, token exchange and rotation,
  revocation, `v1/sync` writes, owner dashboard, import/export/restore,
  and external private object storage **remain legacy**.

## Verification

- Full Core/Gateway suites and Cloudflare dry-run bundling pass.
- Official MCP SDK initialization, tool discovery, tool call, revoked-token
  and invalid-Origin tests pass.
- Local MongoDB Replica Set integration (never production) passes: old
  Mongoose collection-name parity, old search-gram algorithm parity,
  owner-scoped read/search, foreign-owner denial, resource/audience checks,
  immediate permission removal and connection revocation.
- No production knowledge was changed, copied or exported.

Repro (existing repository tooling supplies mongodb-memory-server):

    node --test cloudflare/bananaboom-worker/tests/*.test.mjs
    node --test cloudflare/orion-api-gateway/*.test.mjs
    node scripts/test-orion-brain-replset.mjs

## Still blocking Cloud Run shutdown

1. OAuth: existing clients, PKCE authorization, grant/refresh/revoke and
   discovery. Preserve ALL existing grants and refresh-token lifetimes.
2. Sync writes: same transaction, idempotency receipt, revision conflict,
   source/record/revision history, live owner scope and **private encrypted
   object-store semantics**. Determine the actual legacy blob backend before
   writing. A Mongo-only backup does not include external private blobs.
3. Owner CRUD, personal imports/exports and isolated restore verification.
4. Existing ChatGPT/Claude client E2E (both read/write tools), refresh cycles,
   no required Cloud Run calls and rollback rehearsal.

**Scope: keep Vercel frontend and all owner-written Express source folders.**
Cloud Run retirement removes the deployed GCP service, not the historical code.
