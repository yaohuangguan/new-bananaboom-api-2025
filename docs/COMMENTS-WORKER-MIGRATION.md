# Authenticated comment mutations — Worker migration

Status: **2026-11-12, v2 route pinning implemented; live canary and default cutover not yet accepted**.

## Routes and storage

- `POST /api/comments/:postId` creates a signed-in comment.
- `POST /api/comments/reply/:commentId` appends a signed-in reply.
- `GET /api/comments/write-policy` is a private/no-store, read-only selection for **new** v2 client operations. It is availability metadata, not authentication or authorization. Core still verifies JWT, live Session and the user on every write.

MongoDB remains the source of truth: `comments`, `users`, `sessions`, `audit_logs`, and `comment_mutation_receipts`. Receipts and audit insert atomically with the mutation. Keys are scoped by actual authenticated user/action. Replays return immutable responses; conflicting bodies fail with 409. Authorization is rechecked inside the transaction and after duplicate-key races.

## Two independent routing controls

- `COMMENT_WRITE_CANARY=0` disables the Worker mutation handler. A request pinned to Worker returns 503 and is **never** executed on Cloud Run.
- `COMMENT_WRITE_CANARY=1`, `COMMENT_WRITE_CUTOVER=0` permits explicit canaries and pending Worker retries. New normal operations select legacy.
- Both flags at `1` make new eligible v2 operations select Worker. Google-only identity remains legacy.
- A v2 client persists `version:2`, its UUID, requested canary and the actual selected `route` before POST. It sends `x-orion-comment-write-route: legacy|worker` on every attempt, with the same `Idempotency-Key`. Pending operations do not fetch policy again.
- A legacy pin is honored even after cutover. A Worker pin is honored during a default-route rollback while the handler gate remains on. Missing binding, errors and ambiguous 5xx fail closed.
- Normal clients without a pin remain legacy. Old manual canaries without a pin fail with 428 when the handler is enabled; their uncertain operations must not silently move.
- Normal v1 pending client records remain legacy. Ambiguous v1 manual-canary records block locally until the original outcome is checked.

The frontend can opt into controlled acceptance using an account-scoped session preference, or a dedicated page URL with `?comment_worker_canary=1`. This is routing intent only; the server gate and live authorization remain mandatory. The policy and mutation are coalesced for concurrent identical client submissions.

## Deployment and acceptance

1. Record current Gateway/Core version IDs and flags. Deploy the Gateway policy and pin enforcement with both flags `0` before releasing the v2 frontend. Preserve original Express source.
2. Run Core/Gateway tests, the isolated Mongo Replica Set test, client browser regression, types, lint and builds.
3. Release the verified frontend on the existing Vercel project. Verify a fresh normal operation selects legacy. Do not reinterpret existing pending keys.
4. Enable only the handler gate; leave new-operation cutover off. Use a valid existing-user browser session for one isolated comment/reply canary. Confirm response compatibility, repeat the same keys without duplicate records, and inspect audit/receipt state. Test logout/revocation without exposing credentials.
5. Verify production Worker responses and no mutation fallback on uncertainty. Synthetic network responses in local browser tests do not satisfy this gate.
6. Only after acceptance, set new-operation cutover to `1` and verify new normal comment/reply operations use Worker. Older clients and existing legacy pins remain on Cloud Run intentionally.

## Rollback

For a routing rollback, set **only `COMMENT_WRITE_CUTOVER=0`**. New operations select legacy, while in-flight/pending Worker operations can safely settle on Worker with the same keys. If the handler itself is unsafe, additionally set `COMMENT_WRITE_CANARY=0`: pending Worker operations stop with 503, retain their keys and never replay to legacy. Never erase receipts or force pending operations onto another backend.

## Evidence boundary

Before this update, the full Core/Gateway suite passed **217 tests, 1 skipped** and the isolated localhost Mongo Replica Set test passed create/reply parity, atomic audit+receipt, concurrent idempotency, live owner/session checks, replay and revocation. This update adds route-pinning and rollback regression coverage. Live authenticated canary, deployment versions and default cutover must be recorded after actual execution.

Cloud Run retirement is still **NOT READY**: identity/OAuth, Second Brain writes, other owner CRUD, media, AI, scheduling, older clients and required upstream traffic remain separate gates.
