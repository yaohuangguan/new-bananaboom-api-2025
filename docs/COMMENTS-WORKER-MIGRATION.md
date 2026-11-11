# Authenticated comment mutations — Worker migration

Status: **2026-11-11, implementation staged, production mutation routing OFF**.

## Covered legacy routes

- `POST /api/comments/:postId` creates a signed-in user comment.
- `POST /api/comments/reply/:commentId` appends a signed-in reply.

The current Cloud Run implementation remains the default for both. Existing public comment GETs stay on the Worker. This work does not migrate identity, Google/Firebase login, media uploads, or AI routes.

## New implementation

- Core: `commentHttp.js`, `commentMutations.js`, `MongoDBConnection.commentMutate`, `repository.commentMutate`.
- Gateway: exact legacy POST path allowlist. Both `COMMENT_WRITE_CANARY=1` **on the server** and `x-orion-comment-write-canary: 1` **on the request** are required. The committed default is `COMMENT_WRITE_CANARY=0`.
- Uses existing JWT HS256 keyring, checks live Session on entry and **again inside the MongoDB transaction**, checks user existence, rejects Google-only auth, enforces trusted Origin for cookies, and limits body size/fields.
- Uses stable `Idempotency-Key` (8–128 safe chars), a per-user/action SHA-256 receipt, immutable replay responses, and atomic comment/reply + audit + receipt. Content is not logged in the audit details.
- A missing binding, exception or ambiguous Worker 5xx fails closed with 503. The Gateway must **never repeat a comment mutation to Cloud Run** after forwarding to Core.
- Returns the legacy comment adapter shape (single comment on create, array on reply). The pre-existing public-read normalization is shared.
- The source of truth remains MongoDB `comments`, `users`, `sessions`, and `audit_logs` collections.

## Verification

- `node --test cloudflare/bananaboom-worker/tests/commentMutations.test.mjs cloudflare/orion-api-gateway/commentWriteCanary.test.mjs` — **8 passed**.
- Complete Core and Gateway tests — **217 passed, 1 skipped, 0 failed**.
- `node scripts/test-orion-comments-replset.mjs` — isolated localhost Mongo Replica Set **passed**, using only synthetic records, verified create/reply/receipt/audit, owner/session checks, replay and revocation.
- Core and Gateway `wrangler deploy --dry-run` — both **passed** (non-fatal unenv/whatwg-url warning).
- **No production comment write, production authentication or live client parity yet.**

## Production acceptance gate

1. Deploy Core RPC before the Gateway, allow Durable Object code adoption.
2. Verify the running Gateway default remains `COMMENT_WRITE_CANARY=0` and forged canary headers are ignored.
3. Ensure the actual frontend sends a stable, per-action `Idempotency-Key` on comment/reply POST. Existing frontend callers without a key must not be globally redirected.
4. Use a controlled valid existing-user browser session (including cookie Origin and logout/revocation), run a one-comment/reply real E2E canary, inspect response compatibility and audit records. Do not rely on a fake JWT.
5. Verify a repeated request returns the saved response without a duplicate; test an unknown-commit result and safe same-key retry. Observe logs and confirm no double sends or Cloud Run fallbacks.
6. Roll back via `COMMENT_WRITE_CANARY=0`, preserve the original Express source and the already-written Worker receipts.

Cloud Run retirement remains **NOT READY** until identity/OAuth, Second Brain MCP/writes, Todo, footprints, gallery/media, remaining personal CRUD, AI and scheduled jobs have production parity and zero required Cloud Run traffic.
