# Orion Second Brain — GCS move to US Always Free region

**2026-11-07 — active GCS storage switched to US-CENTRAL1, old bucket retained.**

This changes **encrypted Second Brain source storage only**, not MongoDB, R2,
Vercel frontend or the Cloud Run runtime location.

| Property | Verified |
| --- | --- |
| Historical bucket | `gs://orion-memory-vault-242273127238`, ASIA-EAST1 |
| New active bucket | `gs://orion-brain-vault-us-242273127238`, **US-CENTRAL1** |
| New storage class | **STANDARD** |
| Security | Uniform bucket-level access and enforced public-access prevention |
| HMAC principal | Same legacy Cloud Run service account granted narrow `roles/storage.objectUser` |
| Encrypted GCS object count | **66** |
| Aggregate ciphertext bytes | **148,905** |
| Per-object readback SHA-256 | **66/66 identical** |
| Object key sets | Identical |
| Summary digest | `1bb3785041b42102146bdc0b2acf2a481d4ee832a21f8dc4472b1e145ae09666` |
| Re-encrypted, decrypted or key-rotated | **0** |
| Original Taiwanese GCS objects deleted | **0** |

The same aggregate digest was independently observed in the earlier private
R2 copy. All bytes are original `ORIONV1` encrypted objects; the existing
encryption secret and MongoDB references were unchanged.

## Production Cloud Run update

The running service `bananaboom-api` (GCP project `bananaboom-api`, region
`asia-east1`) was updated with these *environment variables only*:

    BRAIN_S3_BUCKET=orion-brain-vault-us-242273127238
    BRAIN_S3_REGION=us-central1
    BRAIN_S3_ENDPOINT=https://storage.googleapis.com

The new revision `bananaboom-api-jwtprep16` became Ready and served 100%
of Cloud Run traffic when checked. Existing logged-in Second Brain MCP search,
public endpoints and OAuth discovery responded successfully.

**Not yet proved:** a controlled decrypt-and-hash validation from the
Cloud Run `getPrivate` code path with existing HMAC credentials. Ordinary
MCP MongoDB search does *not* exercise encrypted object retrieval.

## Pricing

Google Cloud Storage Always Free grants 5 GB-months of Standard Storage
within the combined `us-central1`, `us-east1` and `us-west1` regions,
plus operation quotas. The tiny new bucket is in an eligible region.

This does not guarantee a **$0 total GCP bill**: the three US regions
share free storage and operations allowances, cross-region transfers from
Cloud Run (still in Taiwan), one-time migration egress and other GCP
services may be billed. Official pricing:
https://cloud.google.com/storage/pricing

## Rollback, catch-up and deletion gates

- Keep the Taiwan encrypted originals while any previous Cloud Run
  revision or incomplete restore could need them.
- If US receives new writes, **do not blindly roll back the bucket name**
  to Taiwan; newly written US originals would not be in that snapshot.
- Keep the already verified private R2
  `orion-private-memory-vault` as the independent Worker vault copy,
  with no public R2 domain.
- The existing `scripts/backfill-orion-brain-gcs-to-r2.py`
  now reads the **US** bucket for future catch-up instead of Taiwan.
  Run it again after the last legacy write and verify exact SHA-256.
- Delete the old Taiwanese bucket *only after* real encrypted read,
  authorized create/read, OAuth, imports, exports, restore and
  references from existing revisions are all proven safe.
- Do not delete either backup or the encryption key solely to save a
  negligible storage charge.

Repeat the non-decrypting GCS cross-region checksum verification:

    python3 scripts/verify-orion-brain-gcs-regions.py

This is a backend-only migration. Keep Vercel and all original Express
source directories permanently.
