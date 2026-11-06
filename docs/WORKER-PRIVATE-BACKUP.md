# Orion private MongoDB to Cloudflare R2 backup

Status: staged, pending real production owner-authenticated canary and independent
R2 restore verification. Created 2026-11-06. Do not disable Cloud Run backup.

## Private storage

R2 bucket: orion-private-db-backups (no public domain).
Cloudflare Core Worker binding: BACKUP_BUCKET, also available in its
MongoDBConnection Durable Object.

Backup files are BSON-compatible canonical MongoDB Extended JSON (NDJSON)
and a manifest.json recording per-part SHA-256, collection indexes/options,
document counts and sizes. Manifest is created only after a successful
snapshot. Passwords, tokens, and private notes are included in the backup.
Never copy these files to the public orion-assets bucket.

## Snapshot and caps

A single snapshot read transaction spans all collections. Chunk uploads to
R2 happen while the snapshot remains open. Backup aborts after 40 seconds,
50k documents, 60 MiB uncompressed, or 512 KiB individual document, with no
completed manifest. Incomplete chunks are deleted best effort. Cloudflare
Workers Free CPU and MongoDB transaction expiration may be stricter.
MongoDB forbids listIndexes in transactions, so index metadata is enumerated
BEFORE the snapshot transaction. Regression test enforces this ordering. The
first production canary on 2026-11-07 returned HTTP 503 before this fix;
production retry and isolated restore are still required.

Metadata/indexes are collected outside the document snapshot and require
a quiescent schema for exact consistency.

## API

POST /api/backup/database requires a verified current session and
super_admin role; cookie sessions additionally require a trusted Origin.
The Gateway supports explicit header x-orion-backup-canary: 1 with no unsafe
Cloud Run fallback. BACKUP_R2_CUTOVER=0 by default. A successful call
returns the existing [DONE] JSON text marker used by the personal UI.

## Release gate

1. Run normal Core tests and scripts/test-orion-backup-replset.mjs.
2. With an actual authorized admin, run one production canary.
3. Verify each private R2 chunk, SHA-256, counts, metadata and unique indexes;
   restore into a separate empty orion_restore_test_ MongoDB database.
4. Compare production collection counts/schema and restored data; verify
   missing/corrupt chunks fail the restore.
5. After acceptance turn on BACKUP_R2_CUTOVER=1, then delete old
   mongodump implementation. Do not touch the last Cloud Run service until
   login, Second Brain/MCP, uploads, AI and all other routes are migrated.

If limits are exceeded, fail explicitly. Never skip collections and claim
that a partial backup is complete.


## Diagnostic-only remediation (2026-11-07)

A real administrator backup canary continued to return 503 even after the
catalog transaction fix was deployed. Production R2 cutover remains disabled.
The backup runner now logs stage, a strictly whitelisted failure category and
numeric document/byte/part/timing counters, without raw MongoDB/R2 errors or
private values. Use the next controlled canary to identify the failure phase.
Do not turn off the legacy backup before a completed private manifest and
independent isolated restore both succeed.

## Staged snapshot workflow (2026-11-07)

MongoDB transaction callbacks may retry automatically. Previously each
callback uploaded R2 objects, extending the transaction and duplicating
remote side effects on retry. The new runner buffers one consistent snapshot
into bounded memory, commits the read transaction, and then uploads 2 MiB
NDJSON parts to private R2 with four concurrent writes. The manifest is
written LAST. Partial failure cleans up the manifest first.

Limits: 48 MiB staging memory, 60 MiB uncompressed data, 50,000 documents,
512 KiB per document and 40 seconds by default. Oversized backups fail
explicitly; no partial backup is represented as complete. Test production
and restore into a truly isolated empty database before enabling cutover.
