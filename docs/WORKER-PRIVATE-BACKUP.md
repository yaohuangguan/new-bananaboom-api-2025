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
