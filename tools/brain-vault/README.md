# Orion portable recovery tools v1
Requirements: Node.js 22+ and Python 3. No npm, Orion server, database, AI account, cloud or network.

```sh
node brain-vault.mjs verify backup.orion --passphrase-file /secure/key.txt
node brain-vault.mjs read backup.orion --passphrase-file /secure/key.txt --output ./readable-vault
node brain-vault.mjs restore backup.orion --passphrase-file /secure/key.txt --output ./recovered-vault
node brain-vault.mjs decrypt backup.orion --passphrase-file /secure/key.txt --output ./backup.zip
node brain-vault.mjs verify backup.zip
```

Output directory must not exist. Unix key files must be chmod 600. Alternatively use --passphrase-stdin; never put a secret directly in the command line. --python selects Python. Plain ZIP needs no key argument. Read/restore verify all hashes before writing, preserve original packages, files and JSONL and generate documents-readable.txt / memories-readable.txt. Open these as plain text.

Encryption v1: ASCII ORIONV1 followed by LF (8 bytes), 16-byte random salt, 12-byte nonce, ciphertext, 16-byte AES-256-GCM tag. The first 36 bytes are authenticated AAD. KDF: scrypt(passphrase UTF-8, salt, N=32768, r=8, p=3, dkLen=32). Fixed version/parameters. Wrong key or modified bytes fail authentication. Losing the passphrase makes recovery impossible. Keys are never stored in an archive/database.

Manifest schemaVersion 1 lists owner, UTC export time, exact counts and SHA-256 hashes for every payload. checksums.sha256 also covers manifest.json. Hashes detect corruption; they do not prove authorship. JSONL retains raw timestamps, original provider IDs, branch parent IDs, evidence, sensitivity and complete revisions. Missing attachments remain explicitly marked.

To restore into fresh MongoDB, configure a local Orion backend against an EMPTY development replica set, a new private object directory and the same account owner ID, then use Backup & Restore preview/commit. Never point recovery at production without approval. The extracted archive is independently usable.
