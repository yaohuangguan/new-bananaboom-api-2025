# Phase 0 — verified local audit (2026-10-22)
Frontend: fix/production-smoke-cold-start-21, initially clean.
Backend: feat/portfolio-readme-sync, base 972e0b2.
Existing uncommitted projects.js, portfolioImportService.js and its test are excluded from every Vault commit.

Verified in source: chat list limit 50; message pagination; mismatched images/image payload; bot id 6946005372b6aea1602bf390; unmatched global guard permits access; public R2 helper generates delivery URLs; global response hydration must be bypassed for Vault. No environment files, keys, production DBs or remote private objects inspected.

Migration design: cursor scan owner conversations and exact ai_session_OWNER room, preserve both sender IDs, original records and orphan diagnostics. Never call DELETE or public upload. Quarantine unknown senders / orphan sessions in evidence metadata. Existing attachment references are UNVERIFIED/MISSING until an approved offline asset inventory supplies bytes. A limit of 10,000 records fails explicitly instead of truncating. Preview before immutable import; commit is additive and idempotent.

Rollback: unmount /api/brain and revert only phase commits in reverse order; retain all new collections and objects. Never remove Chat/Conversation or their assets. Production requires approved dry-run, independently verified backup, private-storage configuration evidence and rollback rehearsal.

Validation: node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.brain.config.cjs --runInBand
Synthetic test exercises 51 conversations / 103 owned-room messages, bot replies, orphan, foreign room and missing image reference.
