import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { brainRouter, finishBrainRouter } from '../../routes/brain.js';
import { BrainMemory, BrainRevision } from '../../models/brain.js';
const owner = '654321000000000000000001', other = '654321000000000000000002';
const app = express();
app.use((req, _res, next) => {
  if (req.get('test-user')) req.user = { id: req.get('test-user'), permissions: req.get('test-deny') ? [] : [req.get('test-admin') ? '*' : 'BRAIN:USE'] };
  req.authSource = req.get('test-cookie') ? 'cookie' : 'bearer'; next();
});
app.use('/api/brain', finishBrainRouter(brainRouter));
const api = (method, path) => request(app)[method]('/api/brain' + path).set('test-user', owner);
test('Phase 1: fail closed for login, permission, methods, prefixes and cookie CSRF', async () => {
  expect((await request(app).get('/api/brain/stats')).status).toBe(401);
  expect((await api('get', '/unknown').set('test-deny', '1')).status).toBe(403);
  expect((await api('delete', '/memories')).status).toBe(404);
  expect((await request(app).get('/api/brain-collision/stats')).status).toBe(404);
  expect((await api('post', '/memories').set('test-cookie', '1').send({ statement: 'x' })).status).toBe(403);
  expect((await api('post', '/memories').set('Origin', 'https://evil.invalid').send({ statement: 'x' })).status).toBe(403);
});
test('Phase 1: Chinese / English search, source evidence, revisions, concurrent edits, soft archive', async () => {
  const made = await api('post', '/memories').send({ statement: '喜欢中文检索 and Project ORION', reviewStatus: 'confirmed', eventAt: '2026-01-01' });
  expect(made.status).toBe(201);
  const id = made.body._id;
  for (const query of ['中文检索', 'project orion', '喜欢']) expect((await api('get', '/search?query=' + encodeURIComponent(query))).body.items).toHaveLength(1);
  expect((await api('get', '/search?query=' + encodeURIComponent('.*'))).body.items).toHaveLength(0);
  expect((await api('get', '/documents/' + made.body.sourceAnchors[0].documentId)).body.rawText).toContain('喜欢');
  const edits = await Promise.all(['修订一', '修订二'].map(statement => api('patch', '/memories/' + id).send({ statement, expectedRevision: 1 })));
  expect(edits.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await BrainRevision.countDocuments({ memoryId: id })).toBe(2);
  expect((await api('patch', '/memories/' + id).send({ expectedRevision: 2, archived: true, reason: 'user archive' })).status).toBe(200);
  expect((await api('get', '/memories')).body.items).toHaveLength(0);
  expect(await BrainMemory.countDocuments()).toBe(1);
  expect((await api('patch', '/memories/' + id).send({ expectedRevision: 3, archived: false })).status).toBe(200);
});
test('Phase 1: admin remains scoped to owner; foreign evidence / id / limit rejected', async () => {
  const made = await api('post', '/memories').send({ statement: 'Owner private' });
  for (const path of ['/memories/' + made.body._id, '/sources/' + made.body.sourceId, '/documents/' + made.body.sourceAnchors[0].documentId, '/memories/' + made.body._id + '/revisions']) {
    expect((await api('get', path).set('test-user', other).set('test-admin', '1')).status).toBe(404);
  }
  expect((await api('get', '/search?query=Owner').set('test-user', other)).body.items).toHaveLength(0);
  expect((await api('post', '/memories').set('test-user', other).send({ statement: 'forged', sourceAnchors: made.body.sourceAnchors })).status).toBe(400);
  expect((await api('get', '/memories/not-an-id')).status).toBe(400);
  expect((await api('get', '/memories?limit=101')).status).toBe(400);
  expect((await api('patch', '/memories/' + made.body._id).send({ expectedRevision: 1, ownerId: other })).status).toBe(400);
  expect(mongoose.connection.name).toBe('brain_synthetic_test');
});
