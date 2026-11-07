# Orion footprint Worker: owner-scoped writes

Status 2026-11-07: **implemented, isolated tests PASS, production write canary OFF**.

## Route parity

Legacy Express mounts `routes/footprint.js` under `/api/footprints`.

| Endpoint | Worker behavior | Production routing |
| --- | --- | --- |
| `GET /api/footprints` | Existing private owner list + visited map stats | Read canary only |
| `GET /api/footprints/:id` | Existing owner-scoped private detail; foreign IDs 404 | Detail canary only |
| `POST /api/footprints` | Create with MongoDB Mongoose-compatible defaults, own user only | Write canary only |
| `PUT /api/footprints/:id` | Validate fields; update by `_id` AND current owner | Write canary only |
| `DELETE /api/footprints/:id` | Delete by `_id` AND current owner | Write canary only |

**No frontend rewrite, Mongo collection rename, Cloud Run shutdown, legacy
Express source deletion or real user mutation occurred.** Signed-in standard
sessions still use Cloud Run by default.

## Auth, privacy and idempotency

- Core verifies a signed HS256 legacy/v2 JWT and **existing MongoDB live
  Session**. The Durable Object re-queries the *current* owner role and
  `FOOTPRINT:USE` permission inside the transaction. No permission in JWT
  claims alone is trusted. Even replayed receipts are permission-checked.
- No admin bypass can read or mutate someone else's private location. A
  missing ID and an existing foreign ID both return HTTP 404.
- JSON input is allowlisted and bounded; no arbitrary MongoDB operators,
  `user`, `ownerId`, prototype fields or strange objects. Locations require
  a name and geo coordinates [longitude, latitude] within ±180/±90; the
  validator limits content, images, companion count, mood, rating and dates.
- Creation retains old schema defaults (country 中国, rating 5, mood happy,
  status visited, visitDate now, timestamps, `__v:0`). Response retains
  legacy `{msg:'Deleted successfully'}` for delete. Image references are
  normalized into existing R2 stable keys and hydrated back to the public
  domain, as in the old Express middleware.
- Every mutation requires `Idempotency-Key` (8-128 safe characters),
  reused verbatim when retrying the same operation after a timeout.
  The document, `audit_logs` record and private
  `footprint_mutation_receipts` record are written atomically in one MongoDB
  Replica Set transaction. Duplicate request+payload reuses the original
  response; same key+different body returns 409.
- Gateway strips untrusted canary metadata and only forwards exactly
  three write methods/paths. Both the server flag
  `FOOTPRINT_WRITE_CANARY=1` and an opt-in
  `x-orion-footprint-write-canary: 1` request are required. With the flag
  still `0`, all original writes use unchanged Cloud Run.
- Worker 5xx or network failures return 503 **without** a Cloud Run retry,
  because the original transaction may have committed. A client retry
  must reuse the same idempotency key; no automatic double write.
- Cookie-based writes require a trusted first-party `Origin` (CSRF
  protection). Google-only headers are not silently converted to JWT;
  full Google/Firebase sign-in parity is a separate migration gate.

## Verified

- Complete Core Node test suite 109 pass + 1 skip, Gateway 85 pass.
- Wrangler dry-run builds for both runtimes successful.
- Actual isolated *localhost* MongoDB Replica Set:
  create/update/delete, Mongoose collection naming, default values,
  record + audit + receipt atomicity, identical-retry, concurrent same-key
  create, cross-account PUT/DELETE refusal, authorization revocation
  affecting even receipt replays, schema validation and R2 reference
  normalization. No production user records modified.
- Next production acceptance: current browser JWT / Google session,
  owner data list/detail, R2 images, create/edit/delete + audit, continued
  safe monitoring, rollback before enabling normal writes.

## Flags and stop/go

Keep these OFF until owner-authenticated production E2E acceptance:
`FOOTPRINT_WRITE_CANARY=0`,
`FOOTPRINT_READ_CUTOVER=0`,
`FOOTPRINT_DETAIL_CUTOVER=0`.

When pilot is acceptable, temporarily enable the server canary flag and
test **only** a clearly labeled synthetic own-account footprint with
stable idempotency key; remove that synthetic entry and verify its audit.
Do not enable all traffic until the existing frontend sends stable keys
and Google/Firebase authentication variants work.

As long as original Cloud Run provides legacy POST/PUT/DELETE, the
staged implementation does not by itself fix any vulnerabilities in
deployed legacy revisions. The old Express source has an owner-scoped
PUT/DELETE fix, but the **running Cloud Run revision must be confirmed**
to contain that fix independently.
