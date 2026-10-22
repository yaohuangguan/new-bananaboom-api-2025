import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brainRouter, finishBrainRouter } from '../../routes/brain.js';
import { writeMemory, sha } from '../../services/brain/core.js';
import { previewImport, commitImport } from '../../services/brain/imports.js';
import { exportArchive, verifyArchive } from '../../services/brain/archive.js';
import { createExport, previewRestore, commitRestore } from '../../services/brain/restore.js';
import { seal, unseal } from '../../services/brain/crypto.mjs';
import { makeZip, readZip } from '../../services/brain/zip.js';
import { tables, BrainMemory, BrainImportJob } from '../../models/brain.js';
const owner = '654321000000000000000001',
  other = '654321000000000000000002';
const app = express();
app.use((req, _res, next) => {
  req.user = { id: req.get('test-user') || owner, permissions: ['*'] };
  req.authSource = 'bearer';
  next();
});
app.use('/api/brain', finishBrainRouter(brainRouter));
const json = (value) => JSON.parse(JSON.stringify(value));
test('Phase 3: encrypted export -> fully offline CLI -> fresh Mongo/object root -> exact JSONL, bytes and counts', async () => {
  const root = process.env.BRAIN_STORAGE_ROOT;
  const m = await writeMemory(owner, { statement: '真实日期未知 · synthetic only', reviewStatus: 'candidate' });
  await writeMemory(
    owner,
    {
      statement: '更正后的记忆 · confirmed',
      reviewStatus: 'confirmed',
      expectedRevision: 1,
      reason: 'synthetic correction'
    },
    String(m._id)
  );
  const sourceZip = await makeZip(
    new Map([
      [
        'conversations.json',
        Buffer.from(
          JSON.stringify([
            {
              id: 'c',
              mapping: {
                a: {
                  parent: null,
                  message: {
                    id: 'a',
                    author: { role: 'user' },
                    create_time: 0,
                    content: { parts: ['Original 原话', { asset_pointer: 'file-service://image.png' }] }
                  }
                },
                b: {
                  parent: 'a',
                  message: { id: 'b', author: { role: 'assistant' }, content: { parts: ['Original reply'] } }
                }
              }
            }
          ])
        )
      ],
      ['image.png', Buffer.from([137, 80, 78, 71, 0, 255])]
    ])
  );
  const p = await previewImport(owner, sourceZip, 'synthetic-chatgpt.zip', 'chatgpt');
  await commitImport(owner, String(p._id));
  const original = await exportArchive(owner),
    verified = await verifyArchive(original.bytes);
  if (process.env.BRAIN_EVIDENCE_OUTPUT) {
    await fs.mkdir(process.env.BRAIN_EVIDENCE_OUTPUT, { recursive: true });
    await fs.writeFile(path.join(process.env.BRAIN_EVIDENCE_OUTPUT, 'sample-brain-export.zip'), original.bytes);
    await fs.writeFile(
      path.join(process.env.BRAIN_EVIDENCE_OUTPUT, 'sample-manifest.json'),
      JSON.stringify(verified.manifest, null, 2)
    );
  }
  expect(verified.manifest.counts).toEqual({ sources: 2, documents: 3, memories: 1, revisions: 2, assets: 1 });
  const encryptedJob = await createExport(owner, { passphrase: 'synthetic passphrase 1234' });
  const download = await request(app).get('/api/brain/exports/' + encryptedJob._id + '/download');
  expect(download.status).toBe(200);
  expect(download.body.subarray(0, 8).toString()).toBe('ORIONV1\n');
  expect(
    (
      await request(app)
        .get('/api/brain/exports/' + encryptedJob._id)
        .set('test-user', other)
    ).status
  ).toBe(404);
  expect(
    (
      await request(app)
        .get('/api/brain/exports/' + encryptedJob._id + '/download')
        .set('test-user', other)
    ).status
  ).toBe(404);
  await expect(unseal(download.body, 'wrong key')).rejects.toThrow('DECRYPT_FAILED');
  const tampered = Buffer.from(download.body);
  tampered[45] ^= 1;
  await expect(unseal(tampered, 'synthetic passphrase 1234')).rejects.toThrow('DECRYPT_FAILED');
  const fixture = path.join(root, 'synthetic.orion'),
    key = path.join(root, 'synthetic-key');
  await fs.writeFile(fixture, download.body);
  await fs.writeFile(key, 'synthetic passphrase 1234', { mode: 0o600 });
  const cli = fileURLToPath(new URL('../../tools/brain-vault/brain-vault.mjs', import.meta.url));
  const offlineArgs = [
    '--user',
    '--map-root-user',
    '--net',
    process.execPath,
    cli,
    'restore',
    fixture,
    '--passphrase-file',
    key,
    '--output',
    path.join(root, 'offline-recovered')
  ];
  const offline = spawnSync('unshare', offlineArgs, { encoding: 'utf8', timeout: 20000 });
  expect(offline.status).toBe(0);
  expect(JSON.parse(offline.stdout)).toMatchObject({ verified: true, offline: true, counts: verified.manifest.counts });
  expect(
    await fs.readFile(path.join(root, 'offline-recovered', 'assets', sha(Buffer.from([137, 80, 78, 71, 0, 255]))))
  ).toEqual(Buffer.from([137, 80, 78, 71, 0, 255]));
  expect(await fs.readFile(path.join(root, 'offline-recovered', 'memories-readable.txt'), 'utf8')).toContain(
    '更正后的记忆'
  );
  // Close the original DB connection and restore into a genuinely different empty database + object root.
  const fresh = new URL(globalThis.__brainTestUri);
  fresh.pathname = '/brain_fresh_restore';
  await mongoose.disconnect();
  await mongoose.connect(fresh.toString());
  process.env.BRAIN_STORAGE_ROOT = path.join(root, 'fresh-private-objects');
  const restore = await previewRestore(owner, download.body, 'synthetic passphrase 1234');
  expect(restore.counts.conflicts).toBe(0);
  expect(restore.counts.added).toBe(9);
  await commitRestore(owner, String(restore._id));
  const recovered = await exportArchive(owner),
    recoveredVerified = await verifyArchive(recovered.bytes);
  expect(recoveredVerified.manifest.counts).toEqual(verified.manifest.counts);
  for (const name of ['sources.jsonl', 'documents.jsonl', 'memories.jsonl', 'revisions.jsonl', 'assets.jsonl'])
    expect(recoveredVerified.files.get(name)).toEqual(verified.files.get(name));
  for (const [name, bytes] of verified.files)
    if (name.startsWith('assets/') || name.startsWith('originals/'))
      expect(recoveredVerified.files.get(name)).toEqual(bytes);
  const repeated = await previewRestore(owner, download.body, 'synthetic passphrase 1234');
  expect(repeated.counts).toEqual({ added: 0, identical: 9, conflicts: 0 });
  await commitRestore(owner, String(repeated._id));
  expect(await BrainMemory.countDocuments()).toBe(1);
  process.env.BRAIN_STORAGE_ROOT = root;
}, 60000);
test('Phase 3: owner mismatch, corruption, current-data conflict and explicit plaintext choice', async () => {
  const m = await writeMemory(owner, { statement: 'Original immutable fact' });
  const archive = await exportArchive(owner);
  await expect(previewRestore(other, archive.bytes)).rejects.toThrow('ARCHIVE_OWNER_MISMATCH');
  const changed = await writeMemory(owner, { statement: 'New statement', expectedRevision: 1 }, String(m._id));
  const preview = await previewRestore(owner, archive.bytes);
  expect(preview.counts.conflicts).toBe(1);
  await expect(commitRestore(owner, String(preview._id))).rejects.toThrow('RESTORE_CONFLICTS_NO_OVERWRITE');
  expect((await BrainMemory.findById(changed._id).lean()).statement).toBe('New statement');
  const files = await readZip(archive.bytes);
  files.set('memories.jsonl', Buffer.from('changed'));
  await expect(verifyArchive(await makeZip(files))).rejects.toThrow('ARCHIVE_HASH_MISMATCH');
  await expect(createExport(owner, {})).rejects.toThrow('PASSPHRASE_REQUIRED_OR_EXPLICIT_PLAINTEXT');
  const plain = await createExport(owner, { unencrypted: true });
  expect(plain.preview.encrypted).toBe(false);
  const body = json(await BrainImportJob.findById(plain._id).lean());
  expect(JSON.stringify(body)).not.toContain('passphrase');
  expect(Object.keys(tables)).toHaveLength(5);
});
test('Phase 3: portable envelope is authenticated and nondeterministic', async () => {
  const bytes = Buffer.from('合成资料');
  const a = await seal(bytes, 'long synthetic passphrase'),
    b = await seal(bytes, 'long synthetic passphrase');
  expect(a.equals(b)).toBe(false);
  expect(await unseal(a, 'long synthetic passphrase')).toEqual(bytes);
});
