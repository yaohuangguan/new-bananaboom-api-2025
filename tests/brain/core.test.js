import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BrainDocument } from '../../models/brain.js';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { brainRouter, finishBrainRouter } from '../../routes/brain.js';
import { BrainMemory, BrainRevision } from '../../models/brain.js';
const owner = '654321000000000000000001',
  other = '654321000000000000000002';
const app = express();
app.use((req, _res, next) => {
  if (req.get('test-user'))
    req.user = {
      id: req.get('test-user'),
      permissions: req.get('test-deny') ? [] : [req.get('test-admin') ? '*' : 'BRAIN:USE']
    };
  req.authSource = req.get('test-cookie') ? 'cookie' : 'bearer';
  next();
});
app.use('/api/brain', finishBrainRouter(brainRouter));
const api = (method, routePath) => {
  const client = request(app);
  return client[method]('/api/brain' + routePath).set('test-user', owner);
};
test('Phase 1: fail closed for login, permission, methods, prefixes and cookie CSRF', async () => {
  expect((await request(app).get('/api/brain/stats')).status).toBe(401);
  expect((await api('get', '/unknown').set('test-deny', '1')).status).toBe(403);
  expect((await api('delete', '/memories')).status).toBe(404);
  expect((await request(app).get('/api/brain-collision/stats')).status).toBe(404);
  expect((await api('post', '/memories').set('test-cookie', '1').send({ statement: 'x' })).status).toBe(403);
  expect((await api('post', '/memories').set('Origin', 'https://evil.invalid').send({ statement: 'x' })).status).toBe(
    403
  );
});
test('Phase 1: Chinese / English search, source evidence, revisions, concurrent edits, soft archive', async () => {
  const made = await api('post', '/memories').send({
    statement: '喜欢中文检索 and Project ORION',
    reviewStatus: 'confirmed',
    eventAt: '2026-01-01'
  });
  expect(made.status).toBe(201);
  const id = made.body._id;
  for (const query of ['中文检索', 'project orion', '喜欢'])
    expect((await api('get', '/search?query=' + encodeURIComponent(query))).body.items).toHaveLength(1);
  expect((await api('get', '/search?query=' + encodeURIComponent('.*'))).body.items).toHaveLength(0);
  expect((await api('get', '/documents/' + made.body.sourceAnchors[0].documentId)).body.rawText).toContain('喜欢');
  const edits = await Promise.all(
    ['修订一', '修订二'].map((statement) => api('patch', '/memories/' + id).send({ statement, expectedRevision: 1 }))
  );
  expect(edits.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await BrainRevision.countDocuments({ memoryId: id })).toBe(2);
  expect(
    (await api('patch', '/memories/' + id).send({ expectedRevision: 2, archived: true, reason: 'user archive' })).status
  ).toBe(200);
  expect((await api('get', '/memories')).body.items).toHaveLength(0);
  expect(await BrainMemory.countDocuments()).toBe(1);
  expect((await api('patch', '/memories/' + id).send({ expectedRevision: 3, archived: false })).status).toBe(200);
});
test('Phase 1: admin remains scoped to owner; foreign evidence / id / limit rejected', async () => {
  const made = await api('post', '/memories').send({ statement: 'Owner private' });
  for (const path of [
    '/memories/' + made.body._id,
    '/sources/' + made.body.sourceId,
    '/documents/' + made.body.sourceAnchors[0].documentId,
    '/memories/' + made.body._id + '/revisions'
  ]) {
    expect((await api('get', path).set('test-user', other).set('test-admin', '1')).status).toBe(404);
  }
  expect((await api('get', '/search?query=Owner').set('test-user', other)).body.items).toHaveLength(0);
  expect(
    (
      await api('post', '/memories')
        .set('test-user', other)
        .send({ statement: 'forged', sourceAnchors: made.body.sourceAnchors })
    ).status
  ).toBe(400);
  expect((await api('get', '/memories/not-an-id')).status).toBe(400);
  expect((await api('get', '/memories?limit=101')).status).toBe(400);
  expect((await api('patch', '/memories/' + made.body._id).send({ expectedRevision: 1, ownerId: other })).status).toBe(
    400
  );
  expect(mongoose.connection.name).toBe('brain_synthetic_test');
});

test('Phase 3: real-date keyset pagination and unknown dates remain separate', async () => {
  for (const [statement, eventAt] of [
    ['Late', '2026-10-01'],
    ['Unknown', null],
    ['Early', '2020-01-01']
  ]) {
    expect((await api('post', '/memories').send({ statement, eventAt })).status).toBe(201);
  }
  const first = await api('get', '/memories?timeline=true&limit=1');
  expect(first.body.items[0].statement).toBe('Early');
  const second = await api(
    'get',
    '/memories?timeline=true&limit=1&cursor=' + encodeURIComponent(first.body.nextCursor)
  );
  expect(second.body.items[0].statement).toBe('Late');
  expect(second.body.nextCursor).toBe(null);
  expect((await api('get', '/memories?undated=true')).body.items.map((m) => m.statement)).toEqual(['Unknown']);
});

test('Phase 3: owner-scoped local reindex defaults to dry-run and preserves facts/revisions', async () => {
  const made = await api('post', '/memories').send({ statement: '索引可以重建' });
  const originalUpdatedAt = made.body.updatedAt;
  await BrainMemory.updateMany(
    { ownerId: owner },
    { $set: { searchGrams: [], normalizedText: '' } },
    { timestamps: false }
  );
  await BrainDocument.updateMany({ ownerId: owner }, { $set: { searchGrams: [], normalizedText: '' } });
  const script = fileURLToPath(new URL('../../scripts/rebuild-brain-search.mjs', import.meta.url));
  const env = { ...process.env, MONGO_URI: globalThis.__brainTestUri };
  const dry = spawnSync(process.execPath, [script, owner], { env, encoding: 'utf8', timeout: 10000 });
  expect(dry.status).toBe(0);
  expect(JSON.parse(dry.stdout).committed).toBe(false);
  expect((await api('get', '/search?query=' + encodeURIComponent('重建'))).body.items).toHaveLength(0);
  const commit = spawnSync(process.execPath, [script, owner, '--commit'], { env, encoding: 'utf8', timeout: 10000 });
  expect(commit.status).toBe(0);
  expect((await api('get', '/search?query=' + encodeURIComponent('重建'))).body.items).toHaveLength(1);
  expect((await BrainMemory.findById(made.body._id).lean()).updatedAt.toISOString()).toBe(originalUpdatedAt);
  expect(await BrainRevision.countDocuments()).toBe(1);
});

test('Phase 3: search body returns evidence without placing private terms in the request URL', async () => {
  await api('post', '/memories').send({ statement: '仅请求体检索 private term' });
  const response = await api('post', '/search').send({ kind: 'memories', query: '请求体检索' });
  expect(response.status).toBe(200);
  expect(response.body.items).toHaveLength(1);
  const docs = await api('post', '/search').send({ kind: 'documents', query: 'private term' });
  expect(docs.body.items).toHaveLength(1);
});
