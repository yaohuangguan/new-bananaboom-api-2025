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
