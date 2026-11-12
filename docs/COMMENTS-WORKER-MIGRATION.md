# Authenticated comment mutations — Worker migration

Status: **2026-11-12, real authenticated canary accepted and handler-OFF rollback exercised; default promotion is prepared and awaiting its final authenticated check**.

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

## Real production acceptance — 2026-11-12

The owner completed password login in an isolated browser profile. Gateway canary version `9ca1f11f-2460-415f-954b-54771c01c605` passed all of these against the real production API and MongoDB:

- Drop a successful HTTP 200 at the browser response boundary, then safely retry its saved key.
- Repeat/concurrently replay the same key with the same immutable response; changed content returns 409.
- Create/reply and read back exactly one isolated synthetic comment plus one reply through Worker responses.
- Filter the real audit API by the synthetic targets: exactly one create and one reply entry.
- Reject unsigned writes and reject a saved real-session cookie after logout/revocation, including receipt replay.

Core version was `044aa23d-34b2-43dd-a1a1-0a06dbbbaaf1`. Vercel production deployment `dpl_8uevhLakNZJzMr2CdxrBbm6ntQkT` serves frontend commit `af7c7da464e4165c32f0823e7a5d5992236ddbe0`. Production website/API smoke, direct-origin 403 protection and bundle-origin scan passed.

After canary acceptance, the handler-OFF rollback rehearsal deployed Gateway `293ae833-adbf-4c78-ae30-6f7496e7ea3d`. Both comment controls returned to OFF, preserving all receipts. Default promotion must pass a new authenticated operation without a canary header before this milestone is called complete. Synthetic records and audit/receipts are retained in a random isolated thread as acceptance evidence; existing user records were not changed.
