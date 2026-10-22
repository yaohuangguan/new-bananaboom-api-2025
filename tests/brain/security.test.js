import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { jest } from '@jest/globals';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { brainRouter, finishBrainRouter } from '../../routes/brain.js';
import { putPrivate, getPrivate } from '../../services/brain/storage.js';
import { writeMemory } from '../../services/brain/core.js';
import globalGuard from '../../middleware/globalGuard.js';
const owner = '654321000000000000000001';
const app = express();
app.use((req, _res, next) => {
  if (req.get('test-login')) req.user = { id: owner, permissions: ['BRAIN:USE'] };
  req.authSource = req.get('test-cookie') ? 'cookie' : 'bearer';
  next();
});
app.use('/api/brain', globalGuard, finishBrainRouter(brainRouter));
afterEach(() => jest.restoreAllMocks());
test('Phase 3: actual global guard registration and route guards reject unauthenticated paths, methods and prefix collision', async () => {
  for (const p of ['/stats', '/missing', '/exports', '/assets/654321000000000000000001'])
    expect((await request(app).get('/api/brain' + p)).status).toBe(401);
  expect((await request(app).post('/api/brain/no-route')).status).toBe(401);
  expect((await request(app).get('/api/brainish/stats')).status).toBe(404);
  const ok = await request(app)
    .post('/api/brain/memories')
    .set('test-login', '1')
    .set('test-cookie', '1')
    .set('Origin', 'http://localhost:5173')
    .set('X-Brain-Request', '1')
    .send({ statement: 'safe cookie write' });
  expect(ok.status).toBe(201);
});
test('Phase 3: storage rejects shared public bucket, encrypts S3 bytes and never supplies public URLs', async () => {
  const names = ['BRAIN_STORAGE_DRIVER', 'BRAIN_S3_BUCKET', 'R2_BUCKET_NAME', 'BRAIN_STORAGE_KEY'];
  const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    process.env.BRAIN_STORAGE_DRIVER = 's3';
    process.env.BRAIN_S3_BUCKET = 'synthetic-public';
    process.env.R2_BUCKET_NAME = 'synthetic-public';
    process.env.BRAIN_STORAGE_KEY = 'synthetic-master-key-32-characters-plus';
    await expect(putPrivate(owner, Buffer.from('private original'))).rejects.toThrow('PRIVATE_STORAGE_NOT_CONFIGURED');
    process.env.BRAIN_S3_BUCKET = 'synthetic-private';
    let stored;
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(async (command) => {
      if (command instanceof PutObjectCommand) {
        stored = command.input.Body;
        expect(command.input.Bucket).toBe('synthetic-private');
        return {};
      }
      return { ContentLength: stored.length, Body: { transformToByteArray: async () => stored } };
    });
    const key = await putPrivate(owner, Buffer.from('private original'));
    expect(stored.includes(Buffer.from('private original'))).toBe(false);
    expect(await getPrivate(owner, key)).toEqual(Buffer.from('private original'));
    expect(key).not.toMatch(/http|uploads/);
  } finally {
    for (const n of names)
      if (previous[n] === undefined) delete process.env[n];
      else process.env[n] = previous[n];
  }
});
test('Phase 3: symlink escape and invalid writes do not disclose private content to console', async () => {
  const root = process.env.BRAIN_STORAGE_ROOT;
  const escaped = '654321000000000000000099';
  await fs.symlink('/tmp', path.join(root, escaped));
  await expect(putPrivate(escaped, Buffer.from('private'))).rejects.toThrow('UNSAFE_STORAGE_ROOT');
  const spies = ['log', 'warn', 'error'].map((n) => jest.spyOn(console, n).mockImplementation(() => {}));
  const sentinel = 'SYNTHETIC_PRIVATE_SENTINEL_97342';
  const r = await request(app)
    .post('/api/brain/memories')
    .set('test-login', '1')
    .send({ statement: sentinel, ownerId: owner });
  expect(r.status).toBe(400);
  for (const spy of spies) expect(spy.mock.calls.flat().join(' ')).not.toContain(sentinel);
  const memory = await writeMemory(owner, { statement: sentinel });
  expect(memory.statement).toBe(sentinel);
});
