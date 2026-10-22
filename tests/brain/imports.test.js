import { searchFilter } from '../../services/brain/core.js';
import yazl from 'yazl';
import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';
import { brainRouter, finishBrainRouter } from '../../routes/brain.js';
import { previewImport, commitImport } from '../../services/brain/imports.js';
import { makeZip, readZip, safeName } from '../../services/brain/zip.js';
import { parseImport, safeJson } from '../../services/brain/adapters.js';
import { getPrivate } from '../../services/brain/storage.js';
import { BrainSource, BrainDocument, BrainAsset, BrainMemory } from '../../models/brain.js';
const owner = '654321000000000000000001',
  other = '654321000000000000000002';
afterEach(() => jest.restoreAllMocks());
const app = express();
app.use((req, _res, next) => {
  req.user = { id: req.get('test-user') || owner, permissions: ['*'] };
  req.authSource = 'bearer';
  next();
});
app.use('/api/brain', finishBrainRouter(brainRouter));
const conversation = (text = '原始中文 evidence') => [
  {
    id: 'c1',
    title: 'Synthetic',
    mapping: {
      root: { message: null },
      n1: {
        parent: 'root',
        message: {
          id: 'm1',
          author: { role: 'user' },
          create_time: 1700000000,
          content: { parts: [text, { asset_pointer: 'file-service://image.png' }] }
        }
      },
      n2: {
        parent: 'n1',
        message: {
          id: 'm2',
          author: { role: 'assistant' },
          content: { parts: ['answer', { asset_pointer: 'missing.png' }] }
        }
      }
    }
  }
];
const archive = async (data = conversation()) =>
  makeZip(
    new Map([
      ['conversations.json', Buffer.from(JSON.stringify(data))],
      ['image.png', Buffer.from([137, 80, 78, 71])]
    ])
  );
test('Phase 2: immutable original bytes, branches, assets, repeated ZIP and incremental conflicts', async () => {
  const bytes = await archive();
  const preview = await previewImport(owner, bytes, 'export.zip', 'chatgpt');
  expect(preview.counts).toMatchObject({ documents: 2, added: 2, missingAssets: 1 });
  expect(await BrainDocument.countDocuments()).toBe(0);
  await commitImport(owner, preview._id.toString());
  expect(await BrainDocument.countDocuments()).toBe(2);
  const first = await BrainSource.findOne().lean();
  expect(await getPrivate(owner, first.privateObjectKey)).toEqual(bytes);
  expect((await BrainDocument.findOne({ externalMessageId: 'm2' }).lean()).parentId).toBe('n1');
  const retry = await previewImport(owner, bytes, 'export.zip', 'chatgpt');
  await commitImport(owner, String(retry._id));
  expect(await BrainSource.countDocuments()).toBe(1);
  expect(await BrainDocument.countDocuments()).toBe(2);
  const changed = await previewImport(owner, await archive(conversation('更正后的源')), 'export2.zip', 'chatgpt');
  expect(changed.counts).toMatchObject({ added: 1, conflicts: 1, duplicates: 1 });
  await commitImport(owner, String(changed._id));
  expect(await BrainDocument.countDocuments()).toBe(3);
  expect(await BrainDocument.exists({ rawText: '原始中文 evidence' })).toBeTruthy();
  const asset = await BrainAsset.findOne({ availability: 'available' }).lean();
  expect(
    (
      await request(app)
        .get('/api/brain/assets/' + asset._id)
        .set('test-user', other)
    ).status
  ).toBe(404);
  const partial = await request(app)
    .get('/api/brain/assets/' + asset._id)
    .set('Range', 'bytes=1-2');
  expect(partial.status).toBe(206);
  expect(partial.headers['content-range']).toBe('bytes 1-2/4');
  expect(
    (
      await request(app)
        .get('/api/brain/imports/' + preview._id)
        .set('test-user', other)
    ).status
  ).toBe(404);
});
test('Phase 2: aborted transaction can retry without half-import or duplicates', async () => {
  const p = await previewImport(owner, await archive(), 'retry.zip', 'chatgpt');
  jest.spyOn(BrainDocument, 'create').mockRejectedValueOnce(new Error('synthetic interruption'));
  await expect(commitImport(owner, String(p._id))).rejects.toThrow();
  expect(await BrainSource.countDocuments()).toBe(0);
  expect(await BrainDocument.countDocuments()).toBe(0);
  jest.restoreAllMocks();
  await commitImport(owner, String(p._id));
  await commitImport(owner, String(p._id));
  expect(await BrainDocument.countDocuments()).toBe(2);
});
test('Phase 2: manual import produces unverified candidate; Claude experimental structure is explicit and unknown formats retained', async () => {
  const p = await previewImport(owner, Buffer.from('来自 AI 汇总，未经证实'), 'memory.md', 'manual');
  await commitImport(owner, String(p._id));
  expect((await BrainMemory.findOne().lean()).reviewStatus).toBe('candidate');
  const raw = Buffer.from(
    JSON.stringify([
      {
        uuid: 'c',
        chat_messages: [
          { uuid: 'm', sender: 'human', text: 'synthetic fixture', attachments: [{ file_name: 'missing.pdf' }] }
        ]
      }
    ])
  );
  const disabled = await parseImport(raw, 'conversations.json', 'claude');
  expect(disabled.supported).toBe(false);
  process.env.BRAIN_ENABLE_EXPERIMENTAL_CLAUDE = '1';
  const enabled = await parseImport(raw, 'conversations.json', 'claude');
  expect(enabled.documents).toHaveLength(1);
  expect(enabled.missing).toEqual(['missing.pdf']);
  delete process.env.BRAIN_ENABLE_EXPERIMENTAL_CLAUDE;
  const unknown = await previewImport(owner, Buffer.from('{"unknown":true}'), 'unknown.json', 'other');
  expect(unknown.state).toBe('unsupported');
  await commitImport(owner, String(unknown._id));
  expect(await BrainSource.countDocuments()).toBe(2);
});
test('Phase 2: traversal, deep JSON, duplicate keys, oversized expansion and arbitrary object keys fail safely', async () => {
  for (const name of ['../secret', '/etc/passwd', 'a/../b', 'a\\b', 'C:evil', 'a\u0000b'])
    expect(() => safeName(name)).toThrow();
  expect(() => safeJson(Buffer.from('{"__proto__":{}}'))).toThrow('UNSAFE_JSON_KEY');
  expect(() => safeJson(Buffer.from('['.repeat(70) + '0' + ']'.repeat(70)))).toThrow('JSON_COMPLEXITY_EXCEEDED');
  await expect(getPrivate(owner, other + '/' + 'a'.repeat(64))).rejects.toThrow('INVALID_OBJECT_KEY');
  // Mutate central and local names to contain ../, avoiding the writer's own defenses.
  const zip = await makeZip(new Map([['ok/file', Buffer.from('safe')]]));
  const attack = Buffer.from(zip);
  let pos = 0;
  while ((pos = attack.indexOf(Buffer.from('ok/file'), pos)) !== -1) {
    attack.write('../file', pos);
    pos += 7;
  }
  await expect(readZip(attack)).rejects.toThrow();
  const large = await makeZip(new Map([['big', Buffer.alloc(33 * 1024 * 1024)]]));
  await expect(readZip(large)).rejects.toThrow('ZIP_QUOTA_EXCEEDED');
  expect((await request(app).post('/api/brain/legacy/preview')).status).toBe(403);
});

test('Phase 3: actual compressed bomb, duplicate ZIP path and symlink entry are rejected', async () => {
  const zipBytes = async (entries) => {
    const zip = new yazl.ZipFile(),
      chunks = [];
    const done = new Promise((resolve, reject) => {
      zip.outputStream.on('data', (b) => chunks.push(b));
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
      zip.outputStream.on('error', reject);
    });
    for (const [name, bytes] of entries) zip.addBuffer(bytes, name);
    zip.end();
    return done;
  };
  await expect(readZip(await zipBytes([['bomb', Buffer.alloc(1024 * 1024)]]))).rejects.toThrow('ZIP_QUOTA_EXCEEDED');
  await expect(
    readZip(
      await zipBytes([
        ['same', Buffer.from('a')],
        ['same', Buffer.from('b')]
      ])
    )
  ).rejects.toThrow('DUPLICATE_ZIP_PATH');
  const symlink = await makeZip(new Map([['link', Buffer.from('/etc/passwd')]]));
  const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  symlink.writeUInt32LE((0xa1ff * 65536) >>> 0, central + 38);
  await expect(readZip(symlink)).rejects.toThrow('UNSUPPORTED_ZIP_ENTRY');
});

test('Phase 3: long Chinese documents retain tail search without unbounded multikey entries', async () => {
  const text = Array.from({ length: 60000 }, (_, i) =>
    String.fromCodePoint(0x4e00 + ((i * 7919 + Math.floor(i / 20000)) % 20000))
  ).join('');
  const job = await previewImport(owner, Buffer.from(text), 'long-chinese.md', 'other');
  await commitImport(owner, String(job._id));
  const doc = await BrainDocument.findOne({ ownerId: owner }).lean();
  expect(doc.searchGrams.length).toBeLessThanOrEqual(8192);
  expect(await BrainDocument.countDocuments({ ownerId: owner, ...searchFilter(text.slice(-12)) })).toBe(1);
});
