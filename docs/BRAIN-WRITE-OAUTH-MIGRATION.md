# Orion Second Brain — Worker sync writes, OAuth and private R2

**2026-11-07 — code staged, isolated tests passed, production routing switches OFF.**

This is an incremental backend retirement milestone, **not** Cloud Run retirement. Keep the Vercel frontend and every owner-written historical Express folder. Normal production OAuth/MCP and sync writes still use Cloud Run.

## Real private encrypted originals: GCS → R2

The production Brain vault uses a private GCS S3-compatible bucket:
`gs://orion-memory-vault-242273127238` (host: `storage.googleapis.com`).
MongoDB stores references to encrypted original objects, not the original payload bytes. The existing encryption envelope is `ORIONV1` (scrypt + authenticated AES-256-GCM), keyed by `BRAIN_STORAGE_KEY`. Existing object keys are owner-scoped content hashes.

Created a **separate, private** Cloudflare R2 bucket `orion-private-memory-vault`, not the public media or database backup bucket.

| Real production storage observation | Verified result |
| --- | --- |
| GCS encrypted objects present at enumeration | **66** |
| Byte-identical encrypted objects copied into private R2 | **66/66** |
| Aggregate ciphertext length | **148,905 bytes** |
| R2 read-after-write SHA-256 comparisons | **66/66 passed** |
| Encrypted ciphertext digest summary | `1bb3785041b42102146bdc0b2acf2a481d4ee832a21f8dc4472b1e145ae09666` |
| GCS sources overwritten or deleted | **0** |
| Ciphertext decrypted / real user knowledge displayed | **0** |
| Production MongoDB documents modified by backfill | **0** |

Reproducible, bounded, metadata-only dry run by default:

```bash
python3 scripts/backfill-orion-brain-gcs-to-r2.py
python3 scripts/backfill-orion-brain-gcs-to-r2.py --commit
```

The second command reads only encrypted bytes in local memory, checks exact GCS object key patterns, copies missing ciphertext objects, fetches each private R2 object back, checks length and SHA-256, aborts on a mismatched existing destination and rechecks the GCS listing. It does **not** decrypt data, log object names or owner IDs, overwrite/delete originals or edit MongoDB. Since Cloud Run is still live and may write more objects, **rerun this backfill before final cutover**.

Private bucket restrictions: **no public custom domain, no r2.dev URL, no public read credentials.** Keep GCS originals and their existing encryption key intact as rollback.

## Worker sync_knowledge implementation (default disabled)

Files: `cloudflare/bananaboom-worker/src/brainVaultWrite.js`, `brainPrivateStorage.js`, `brainHttp.js`, `brainMcp.js`, `MongoDBConnection.js`.

- Existing `ov_` token hash, resource audience, expiration, revocation, live owner `BRAIN:USE` permission and `memory:write` scope verified inside MongoDBConnection Durable Object; a caller cannot pick an owner ID.
- Exact legacy strict Zod schema and JSON payload hash, including whitespace trimming, optional fields, default sensitivity and event dates.
- Source payload encrypted **with the original owner-written `tools/brain-vault/crypto.mjs` implementation** to preserve `ORIONV1`, owner+SHA-256 content-addressed keys and old private-blob references; bytes read back and checked before database transaction.
- Existing MongoDB collections remain the truth: `brainsources`, `braindocuments`, `brainmemories`, `brainrevisions`, `brainsyncreceipts`, `brainconnections`. Create/correction/evidence/receipt/lastWriteAt are committed atomically in an isolated snapshot transaction.
- Repeated `requestId` and identical payload return the persisted receipt; different payload with same ID gives 409. Stale revision or cross-owner correction fails. Corrections preserve original type and tags when omitted, and never lower sensitivity.
- A failed transaction may leave an immutable **unreferenced encrypted object** (legacy behavior); no half-committed Mongo record chain. No production-write canary has been executed.
- The REST `POST /api/brain/sync/v1/sync` and official MCP `sync_knowledge` tool are staged, but only accessible through explicit server-side flags and request canary. Ordinary users and clients still use Cloud Run.

The independent memory/blob verifier currently caps **sync request** originals at 128 KiB. It is not a general replacement for large historical assets/import/archive; those remain on legacy code until ported.

## Worker OAuth code and refresh grant implementation (default disabled)

Files: `brainOAuthGrant.js`, `brainOAuthHttp.js`, Durable Object RPC and Gateway canary.

- Existing public-client `POST /token` form response and `ov_` token envelope.
- `authorization_code`: single-use code, original SHA-256 collection, registered redirect, existing client, PKCE S256 verifier constant-time compare, resource audience, live owner authorization and connection expiry.
- `refresh_token`: single-use refresh credential consumed inside the same MongoDB transaction that creates SHA-256-stored next access/refresh; rejects replay, retired connections, owner permission loss and scope escalation.
- New access lifespan at most one hour; refresh at most 30 days; both capped by connection expiry.
- 32 KiB bounded form parsing, no-store headers, fixed error codes, no raw client grant material in logs. **Never** retry a failed/unknown grant against Cloud Run, since it may have committed.
- Still legacy: OAuth discovery, dynamic client registration, PKCE authorization/consent approval, revocation, owner connection CRUD, imports, exports and restore.

## Live configuration — deliberately still OFF

| Component | Switch or binding | Actual staged value |
| --- | --- | --- |
| API Gateway | `BRAIN_READ_CUTOVER` | `0` |
| API Gateway | `BRAIN_WRITE_CANARY` | `0` |
| API Gateway | `BRAIN_OAUTH_TOKEN_CANARY` | `0` |
| Core | `BRAIN_MCP_WRITE_CANARY` | `0` |
| Core | `BRAIN_VAULT_BUCKET` | R2 `orion-private-memory-vault` |
| Core secret | `BRAIN_STORAGE_KEY` | **Not installed in this milestone** |

**Hard blocker:** existing `BRAIN_STORAGE_KEY` must be securely configured for Core, unchanged. Cloud Run references GCP Secret Manager `orion-vault-storage-key` (latest) in project `bananaboom-api`. An automated attempt to transfer that secret across cloud providers was blocked by safety checks. **Do not retry by rephrasing, decoding, intermediate files or other connectors; do not print or paste the key.** Use a user-controlled secret configuration flow or the Cloudflare Worker secret UI, and validate one old copied object inside the private Worker environment without revealing the plaintext.

Until that is done, write gates MUST stay off; the existing GCS originals remain usable by the old Cloud Run implementation.

## Tests / verification actually performed

```bash
node --test cloudflare/bananaboom-worker/tests/*.test.mjs
node --test cloudflare/orion-api-gateway/*.test.mjs
node scripts/test-orion-brain-sync-replset.mjs
node scripts/test-orion-brain-oauth-replset.mjs
```

- Core suite **98 pass / 1 optional skip**, Gateway **70 pass**, no failures.
- Both Cloudflare bundles passed `wrangler deploy --dry-run`. A prior unenv whatwg-url warning does not fail builds.
- **Actual isolated localhost MongoDB Replica Set** tests: original Mongoose model names and legacy Zod/payload-hash parity; encrypted object creation/decryption and content hash, source→document→memory→revision relationships, optimistic correction, exact receipt idempotency, stale version/conflicting hash/cross-owner rejection, live permissions and connection revocation.
- Real replica OAuth tests: PKCE wrong-verifier rollback, single-use code, existing hashed credentials, refresh token atomic rotation/replay denial, scope downgrade and forbidden escalation, live owner permission.
- Gateway tests confirm that default writes and token grants continue to Cloud Run and Worker failures do not replay writes/grants against legacy.
- **No real production knowledge write, OAuth refresh or encrypted-data decryption was tested.** Do not equate local test success with successful real-client migration.

## Cloud Run retirement gates still outstanding

1. Configure unchanged original private encryption key safely and validate private Worker decryption/re-encryption compatibility without exposing data.
2. Port OAuth discovery, client registration, authorize/consent/revoke; preserve current ChatGPT/Claude connections and refresh tokens without forced reconnection.
3. Port Second Brain owner dashboard, imports, encrypted exports, and restore/backup of **private objects as well as MongoDB**, with real isolated restore.
4. Perform actual existing-client read/write/refresh E2E and a reversible rollback, then rerun GCS→R2 backfill after the last legacy writes.
5. Separately migrate remaining non-Brain Cloud Run routes (login, personal CRUD, media, AI, scheduled tasks); observe zero required origin requests over representative/rare-job traffic. Only then turn Cloud Run off.

**Keep Vercel frontend and the original Express code regardless of deployed runtime.** Cloud Run shutdown is not code deletion.

## Durable Object deployment sequencing

Deploy Core new RPC APIs **before** changing Gateway routing. Cloudflare can defer adoption of updated Durable Object code; the prior Second Brain read canary returned a transient RPC-method-missing 503 until an explicitly planned one-off `wrangler deploy --durable-objects-code-update-mode immediate`. Do not set immediate globally because it can interrupt an active private database backup. Default to backward-compatible two-phase deploy and fail closed on version skew.
