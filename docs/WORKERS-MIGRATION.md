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

## JWT staged key rotation (prepared; not yet deployed to Cloud Run)

All password, OTP and Firebase login paths use `signAndSyncToken()` from
`utils/authUtils.js`. The existing middleware uses the shared
`verifySessionJwt()` helper. Both now support a **versioned keyring**:

1. **Phase A (code-only)**: Deploy the reviewed keyring code while
   `ORION_JWT_SIGNING_MODE` remains unset, so existing `SECRET_JWT`
   continues issuing legacy tokens. Keep Cloud Run serving private routes.
   Because Cloud Build auto-triggers are disabled, deployment must be
   explicit. A Cloud Run source deployment will create an image — schedule
   **one** build only when it is necessary; do not enable CI triggers.
2. **Phase B (prepare)**: Generate a cryptographically random 32-byte or
   stronger signing secret and configure it in both Cloud Run
   (`ORION_JWT_NEXT_SECRET`) and the internal `bananaboom-core` Worker.
   Preserve the current `SECRET_JWT` unchanged. No source code or private
   session values should be copied into configuration or committed.
   Signing mode remains `legacy`. Verify old login, invalid JWT and
   permissions on Cloud Run; confirm Worker can validate both generations.
3. **Phase C (switch issuance)**: Set
   `ORION_JWT_SIGNING_MODE=v2` on Cloud Run only after all serving
   revisions have both verification keys. New JWTs have `kid=orion-v2`.
   Both backends accept old and new JWTs with the same MongoDB sessions.
   Cloud Run configuration changes create revisions but need not rebuild
   the image if the tested code is already deployed.
4. **Phase D (authenticated rollout)**: Verify a real logged-in browser
   session on old and new keys, private article reads, role downgrade,
   logout/session deletion and fallback. Only then allowlist private
   read endpoints in Gateway. Do not allow a Worker response to bypass
   a session check, and keep Cloud Run for any unported writes.
5. **Phase E (retire legacy)**: Stop accepting the legacy key **only after**
   the last possible legacy JWT/session expiry (30 days after the final
   legacy issuance, with operational margin) and traffic confirmation.
   Remove legacy signing material from both Cloud Run and Worker only
   as part of a tested retirement. Deleting `SECRET_JWT` prematurely
   breaks currently signed-in clients.

Rollback before phase C: restore the preceding tested Cloud Run revision.
Rollback **after v2 issuance begins**: set
`ORION_JWT_SIGNING_MODE=legacy` on a revision containing the dual-key
verifier, while preserving BOTH keys. Never roll back to a pre-keyring
Cloud Run image that cannot verify v2 JWTs, because users may already have
v2 sessions. Gateway private reads remain on Cloud Run until real-user
testing passes.

`SECRET_JWT` is currently shorter than the desired new-key minimum;
the Worker accepts that **legacy** secret solely for migration compatibility,
and only with an exact live MongoDB session, 30-day expiry and current
RBAC permissions. Never use it for new v2 signing.

Test commands:
`node --test tests/jwtKeyring.test.mjs`
and from `cloudflare/bananaboom-worker`, `npm test`.

## Phase 4: anonymous post-like reads

- `GET /api/posts/likes/:id` for anonymous requests now routes through
  `orion-api-gateway` to `bananaboom-core` for a 24-digit hex ObjectId.
- The MongoDB query constrains `isPrivate=false`, returning only the
  legacy `{ _id, likes }` shape for an existing public post.
- Write operations (add/remove likes), credentialed requests, invalid IDs
  and other post actions remain on Cloud Run.
- Six production article IDs showed exact JSON parity with local Workers;
  three production reads were confirmed HTTP 200 with
  `x-bananaboom-origin: worker`.
- Production Cloud Run's JWT signing mode/key were not modified. No additional
  Google Docker builds were created during this phase.

## Phase 5: public menu read + private-read canary

- Public `GET /api/menu` is served by Workers (both unfiltered and one category
  query). Other menu actions, including random draw, AI recommendations,
  create/update/delete, remain on Cloud Run. Category duplicates fall back.
- Production database parity for this endpoint was verified against four query
  variants: unfiltered (8 rows), evening (5), lunch (3) and random (0),
  all exact HTTP/JSON matches.
- `GET /api/posts/private/posts` has **only an explicit opt-in canary**:
  request header `x-orion-private-worker-canary: 1` together with a legacy
  JWT carrier (Bearer, x-auth-token or orion_session cookie), and without
  x-google-auth. Regular traffic continues to Cloud Run.
- The canary request is never enough for authorization: the Worker must still
  verify the JWT signature and expiry, the live MongoDB session and current
  user RBAC. A Worker 5xx falls back to Cloud Run.
- The signing keys are **not yet provisioned in the Worker**. Until key
  provisioning and signed-in end-to-end parity are verified, do not remove
  the canary requirement or route private writes.
- The external frontend requires no change for this step and stays on Vercel.

### Durable Object rollout check

On 2026-11-05 a new `MongoDBConnection.publicMenu()` RPC initially returned
`The RPC receiver does not implement the method "publicMenu"` after the Worker
upload. The existing Durable Object still served an older code version due to
Cloudflare's deferred Durable Object code updates, introduced in October 2026.
The Gateway's 5xx fallback correctly kept menus available through Cloud Run.

**Verified fix:** Deploy the already-uploaded Worker Version at 100% with
`--durable-objects-code-update-mode immediate`, then verify
`x-bananaboom-origin: worker` AND exact JSON response parity. This is a
one-time update strategy, not an excuse to recreate the Durable Object
instance or delete its storage.

Official documentation:
https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/

Post-cutover production verification: menu category variants (8/5/3/0 items)
all returned HTTP 200 from Worker and matched their pre-cutover JSON SHA-256
hashes. Private routes without authentication remain 401, and the canary
with an invalid Bearer token was 401 via Cloud Run fallback.

## Private-read canary fallback diagnostics (2026-11-05)

Real signed-in browser verification returned HTTP 200 and identical JSON from
Cloud Run and Worker-canary URLs, but the canary response lacked
`x-bananaboom-origin: worker`. This was **not** counted as a Worker pass:
the Gateway may have silently fallen back to Cloud Run on a 5xx or exception.

To distinguish routes safely while the canary is opt-in, requests with
`x-orion-private-worker-canary: 1` now carry the response header
`x-orion-private-canary-result` with one of these static values:

- `worker`: core Worker actually handled the response (also has origin marker).
- `not-routed`: canary gate was not matched; the Cloud Run route was used.
- `fallback-auth`: JWT/Session/RBAC lookup raised in the Worker; Cloud Run replied.
- `fallback-query`: private post query/hydration raised in the Worker.
- `fallback-5xx`: Worker failed without a known diagnostic stage.
- `fallback-exception`: Service Binding fetch threw.

Only the stage, never auth material, MongoDB details, or private documents,
is exposed. `Access-Control-Expose-Headers` permits reading it through
same-site browser JavaScript. This diagnostic is temporary and should be
removed when private reads are fully validated. Ordinary responses are unchanged.

A forged-token canary returned 401 directly from Worker and reported
`worker`; a canary without a JWT carrier was 401 from Cloud Run and
reported `not-routed`. No general private-read traffic was migrated.

## Private read 10% gradual production rollout

After a real authenticated browser request was confirmed HTTP 200 with
`x-bananaboom-origin: worker` and `x-orion-private-canary-result: worker`,
the Gateway introduced `PRIVATE_POST_READ_ROLLOUT_PERCENT = 10`.

- Sample applies only to authenticated `GET /api/posts/private/posts`.
- No JWT carrier, `x-google-auth`, unsupported pagination/search, or
  unrelated routes remain on Cloud Run.
- `x-orion-private-worker-canary: 1` remains explicit opt-in.
- Worker independently verifies JWT, MongoDB Session TTL and current role.
- Worker 5xx and binding errors fall back to Cloud Run.
- Rollback: set `PRIVATE_POST_READ_ROLLOUT_PERCENT = 0`, deploy Gateway only.
- Sampling is per request, not a sticky user cohort. Do not infer
  all authenticated reads use Workers or claim full private cutover.
- Expand only after query-variant parity, permission downgrade/logout
  and error/fallback telemetry are verified.

## Private article read full rollout (2026-11-05)

After signed-in browser confirmation of HTTP 200, x-bananaboom-origin=worker,
and x-orion-private-canary-result=worker, upgraded eligible GET
/api/posts/private/posts traffic from 10% to 100%. This is **not** all-backend
cutover: remaining login, writes, private detail, media, backup, and Second Brain
routes still rely on Cloud Run. Worker 5xx retains Cloud Run fallback. Immediate
rollback: set PRIVATE_POST_READ_ROLLOUT_PERCENT=0 and redeploy only Gateway.

## Authenticated article detail on Workers

The existing public-only `GET /api/posts/:id` path now also supports
authenticated private detail reads for the legacy JWT-bearing clients.
The Gateway still routes `x-google-auth` to Cloud Run.

- A malformed or expired signed token is 401 (as in the legacy Soft Auth).
- Missing/revoked live MongoDB Session is a guest: public post 200, private 404.
- Only a current `PRIVATE_POST:READ` role/extraPermission or super_admin
  can fetch an article with `isPrivate=true`. Others get a uniform 404,
  indistinguishable from a missing article.
- Auth/DB failures return 503 within the Worker so the Gateway can fall back
  to Cloud Run; no error messages contain secret material or post contents.
- The MongoDB Durable Object only selects a private post by an exact 24-digit
  ObjectId AND `isPrivate: true`; its populated author fields remain
  limited to `_id,displayName,photoURL` to preserve the Gateway's public
  data privacy contract.
- This is a GET-only route. Article writing, login, image uploads and
  Second Brain continue to depend on Cloud Run.
- If the new Durable Object RPC is not immediately available, use a controlled
  `wrangler versions deploy <version>@100% --durable-objects-code-update-mode immediate`
  before checking production.
- Six public post detail JSON summaries were captured before cutover and must
  match afterwards. An authenticated private detail still needs a real
  signed-in UI regression check; local JWT/RBAC tests alone do not replace it.

## Phase 6: blog like writes (first migrated mutations)

- Migrate only `POST /api/posts/likes/:id/add` and
  `POST /api/posts/likes/:id/remove` to OpenMesh / `bananaboom-core`,
  with exact 24-character ObjectId path validation. No other write method
  may be routed by this rule.
- Preserve old MongoDB semantics: atomic `$inc` 1 or -1,
  decrement only for `likes > 0`, no `updatedAt` modification;
  return `{ _id, likes }` or `null` for nonexistent valid IDs.
- Preserve 30 requests/client-IP/minute independently from the 60/min
  general write limit using Cloudflare `LIKE_LIMITER` and the original
  user-facing 429 message.
- **Mutation fallback boundary:** Worker 5xx or a Service Binding exception
  returns a 503 with an explicit *unknown operation status*. Unlike GETs,
  the Gateway does not replay POSTs on Cloud Run because MongoDB may already
  have committed the update. The browser should refresh the count before
  any manual retry. This policy is mandatory for all future mutations.
- The authenticated article CRUD operations are not migrated by this change:
  they rely on `logOperation`, Socket.IO events, Mongoose validation and,
  for deleting private journals, an additional admin secret. These must be
  implemented and tested separately before retiring Cloud Run.
- Deployment order: Core Worker, immediately activate new Durable Object RPC
  with `wrangler versions deploy <id>@100% --durable-objects-code-update-mode
  immediate`, then Gateway, then verify Worker response markers and counter
  parity. Never apply test mutations to production without checking and
  restoring the original count.

## Phase 7: article CRUD implementation (staged, not routed)

The Core Worker contains three **unexposed** article CRUD handlers:
`POST /api/posts`, `PUT /api/posts/:id`, `DELETE /api/posts/:id`.
The Gateway allowlist still routes all three to Cloud Run. This is
intentional; **do not claim article CRUD has been cut over**.

Implemented foundations:

- Verify HS256 JWT, exact live MongoDB Session and current
  `BLOG:MANAGE` role permission on each write. Ignore client-supplied
  author ID, likes, `__v`, and timestamp fields.
- Match the explicit Mongoose post data fields and string-tag splitting;
  preserve the legacy create/update response shapes and post timestamps.
- Cookie-authorized writes require an allowed `Origin` (CSRF boundary).
- Private delete requires a configured `ADMIN_RESET_SECRET` (minimum 16
  characters in the Worker), with digest-based comparison and **no default
  passphrase**. Recheck the stored privacy flag at delete time; fail closed
  if it changed since the permission/secret check.
- Write an `audit_logs` record and a `post_write_outbox` delivery record,
  using the same legacy audit collection and 30-day `createdDate` field.
  **These are not a complete notification implementation yet.**
- The legacy Cloud Run source also removes its insecure fallback
  `ADMIN_RESET_SECRET || 'orion'`. A Git merge does NOT apply this
  hardening to the existing Cloud Run production revision; it must be
  deployed in a controlled future Cloud Run release.

**Blocking parity work before CRUD traffic is enabled:**
1. A reliable outbox dispatcher must deliver `NEW_OPERATION_LOG` to
   connected admin UI clients and preserve Bark notifications (or the
   UI must migrate to equivalent Cloudflare-native real-time delivery).
   The current Cloud Run `utils/audit.js` emits Socket.IO and Bark;
   dropping these would silently degrade real functionality.
2. Implement retry-safe idempotency for create/update/delete writes, so a
   timeout after MongoDB commit cannot be double-applied. Do not reuse
   GET fallback semantics on mutations.
3. Reconcile the remaining Mongoose validation/serialization differences,
   especially large posts (legacy accepts up to 50MB, staged Worker
   parser currently 2MB) and the post-write audit side effects.
4. Configure and verify `ADMIN_RESET_SECRET` as a Worker secret without
   placing it in Git or chat. Stage real authenticated create/edit/delete
   end-to-end tests and a rollback drill.
5. Only then change the Gateway explicit mutation allowlist and release
   a small controlled cohort. Cloud Run must remain available until that
   production verification succeeds.

As of this stage the existing likes add/remove Workers routes and all
previously migrated reads continue unchanged. This is *not* the point
to delete the last Cloud Run service or Artifact Registry image.

## Phase 8: durable audit event feed and Bark delivery loop (2026-11-05)

The MongoDB `post_write_outbox` created by staged Worker CRUD is now readable
through an owner-scoped notification feed and deliverable via native
Cloudflare Cron, without replaying article writes.

- `GET /api/audit/worker-events?after=<24-hex-ObjectId>` is a narrow
  Gateway allowlist to `bananaboom-core`. Both legacy signed JWT AND
  current MongoDB Session are required. Only `SYSTEM_LOGS:USE` or a
  privileged wildcard/super-admin role may list events. No anonymous
  reads, arbitrary event query, or user-controlled database filters.
- The event cursor is the outbox ObjectId; results are in ascending order,
  max 30, returning only operation title, actor, action and audit reference.
  The frontend can poll every ~8 seconds and resume from its last cursor;
  its existing Socket.IO connection remains for chat and legacy messages.
  Polling is near-real-time, not true WebSocket push.
- `bananaboom-core` has a `* * * * *` Cron Trigger. The scheduled handler
  directly calls the private Durable Object RPC; there is **no publicly
  callable HTTP dispatch endpoint**.
- A valid HTTPS `BARK_URL` Worker secret enables up to 12 pending
  outbox deliveries each minute. Each record uses an atomic 30-second
  lease, attempt counter, bounded exponential backoff (15 seconds–1 hour),
  and `dispatchedAt` acknowledgement on successful HTTP response.
  Missing secret leaves records untouched without opening MongoDB.
  Delivery is at-least-once: a remote Bark success followed by a crash
  before acknowledgement can result in a duplicate push.
- Only notification delivery retries. A failed/ambiguous article mutation
  is **never retried** by the delivery loop or forwarded to Cloud Run.
- Bark was **not configured by this code change**; no key/value is
  committed or transported through ChatGPT. An authorized operator must
  configure it separately using `wrangler secret put BARK_URL
  --name bananaboom-core` in the Cloudflare 7199 account.

### Still blocking live article CRUD cutover

The staged `#auditPostWrite` currently best-effort inserts the audit
and outbox documents after a post operation. A failure between MongoDB
writes can leave an article change without an event. **A MongoDB transaction
and idempotency-key receipt are mandatory before enabling the CRUD routes**;
the current implementation is not end-to-end exactly-once. Large payload
compatibility (legacy 50 MB parser vs Worker 2 MB), the private deletion
secret, a real authenticated edit/create/delete rehearsal and a rollback
drill also remain. Until then, all CRUD still routes to Cloud Run.

## Role consolidation: super_admin is canonical (2026-11-05)

The duplicated persisted `users.vip` value is no longer an authority for
access control. The Mongoose schema has no writable `vip` path or
bidirectional pre-save hook. Existing API consumers receive a temporary
read-only `vip = role === 'super_admin'` compatibility alias.
New frontend code checks `role` and removes the redundant VIP toggle.
Historical MongoDB `vip` bytes are **not unset until both live backends and
frontends are verified**: the existing Cloud Run revision may still use them.

A logged-in `super_admin` role is required for privileged password reset and
article deletion; the former anonymous shared-secret password reset and
secret-verification endpoints are retired (410 at Gateway, no upstream call).
A super_admin may change their own password or a non-super_admin account's,
but not another super_admin account's. OTP login remains for account recovery.
The separate delete/admin passphrase has been removed from the staged Core.
The existing Cloud Run revision still needs replacing for its article
DELETE implementation. The Gateway retains it on Cloud Run until Worker
CRUD satisfies transactional outbox and idempotency requirements.

Do not run a production `$unset: { vip: 1 }` while an old Cloud Run
revision depends on `vip`. Verify active revisions and Mongoose role
compatibility first, and capture a count/backup of the legacy field.

## Phase 9: atomic article CRUD and stable retry keys

The Worker now uses a MongoDB replica-set transaction to commit business
article updates, audit_logs, post_write_outbox and post_write_receipts as
one unit. Receipts are unique by authenticated actor + request UUID; an
identical repeat returns the first result while reusing the same key for
another payload returns HTTP 409. A malformed or missing key returns 428.
Unknown transaction commit outcomes are resolved by reading the
majority-committed receipt. Durable Object RPCs and REST handlers require
the key and never retry a mutated request on Cloud Run.

The frontend persists only the SHA-256 payload fingerprint and stable
random operation UUID in sessionStorage for up to 24 hours, not journal
contents or credentials. It retains the key after a timeout and clears
it on confirmed success.

The Gateway ARTICLE_WRITE_CUTOVER switch is 0 by default and accepts an
explicit signed-in canary request. No random per-request rollout is used
for mutations because retry affinity must not change. The request body
is forwarded only for exact eligible article CRUD endpoints. Worker 5xx
and Service Binding errors produce 503 without Cloud Run mutation replay.
Setting cutover=1 routes all eligible JWT + idempotency requests to Core;
Google-only auth and old clients without keys still need Cloud Run.

Bark dispatch can use the existing sam super_admin user Bark address with
a strict official api.day.app hostname check when no explicit BARK_URL
secret exists. The address stays in MongoDB, not source code or a response.

An isolated local replica set validated real transactions, read-after-
write deduplication and forced audit/outbox rollback with no production
database changes. See scripts/test-crud-replset.mjs.

This is not full API migration or permission to shut down Cloud Run.
See docs/CLOUD-RUN-RETIREMENT-READINESS.md for outstanding subsystems
and retirement gates.
