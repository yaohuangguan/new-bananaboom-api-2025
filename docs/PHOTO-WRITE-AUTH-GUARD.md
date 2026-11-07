# Orion Photo mutation security guard (2026-11-07)

## Vulnerability and effective scope

Historical `routes/photos.js` implements `POST /api/photos`,
`PUT /api/photos/:id`, `PUT /api/photos/reorder` and
`DELETE /api/photos/:id` with no route-local permission check.
`config/routeGuardMap.js` has **no** /api/photos write rules, while
`middleware/globalGuard.js` permits unmatched routes. This could allow
an unauthorized caller to modify the public gallery if they reached the
legacy origin through the Gateway.

The Cloud Run deployment declares `ORION_EDGE_SECRET` and the checked-in
`originEdgeGuard` expects the corresponding edge header for `/api`.
Do not treat this as an adequate per-user authorization check; the
Gateway is the legitimate origin and forwards user writes.

## Staged fix

Only authentic signed-in administrators may mutate photos. Gateway
`PHOTO_WRITE_AUTH_GUARD=1` intercepts every POST/PUT/DELETE within
`/api/photos` **before forwarding the original request body to Cloud Run**.

The guard invokes a read-only internal Core service-binding endpoint
`POST /_internal/authorize-photos-write` with a sanitized header set
and **no business body**. Core verifies an existing HS256 session JWT,
requires a nonexpired live MongoDB Session matching the JWT subject,
checks current database role/permissions and accepts only current
`super_admin` or the authoritative `*` permission. It refuses
unauthenticated writes (401), unauthorized writes (403), invalid token
signatures, revoked sessions, untrusted cookie origins, Google-only
headers without a recognized JWT and any Core outage (503).

The guarded legacy POST/PUT/DELETE executes **unchanged, exactly once**
only after Core explicitly returns HTTP 204. The actual photo writes
have NOT migrated from Cloud Run; this patch merely prevents
unauthenticated or non-admin modification while they are still there.
Valid public GET `/api/photos` is unaffected and continues to use Core.

## Verification and rollback

- Unit & HTTP tests cover forged JWT, valid admin Session, dynamic role
  downgrade/revocation, CSRF, missing Core, 5xx, no business payload
  forwarded during auth preflight, original write preserved exactly once.
- Core and Gateway suites and both Wrangler dry-run builds must pass
  before deployment.
- Production smoke must test only **unauthorized** POST, PUT and DELETE
  (never create or delete actual production gallery entries), as well
  as legitimate public GET. The full logged-in admin write flow
  requires owner browser E2E acceptance.
- Do **not** turn the guard off merely because admin login is
  temporarily unavailable. Disabling returns to the unaudited
  legacy route. For emergency rollback, revert the Worker deployment
  only after an explicit security decision.

The goal remains removing Cloud Run business execution entirely;
this guard is a temporary safety measure, not a claim of migration
completion. Vercel frontend and original Express sources are retained.
