import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { ObjectId } from 'mongodb';

const homepages = [{ _id: 'home1', likes: 10 }];
const projects = [{ _id: 'project1', title_en: 'Example' }];
const logs = [{ _id: 'log1', version: '0.1.0' }];
const fakeRepository = {
  homepages: async () => homepages,
  likes: async () => [{ _id: 'home1', likes: 10 }],
  projects: async () => projects,
  logs: async () => logs
};

test('OpenMesh public routes preserve legacy response shapes', async (t) => {
  const app = createApp(fakeRepository);
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;

  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'OK');
  for (const [path, expected] of [
    ['/api/homepage', homepages],
    ['/api/homepage/likes', [{ _id: 'home1', likes: 10 }]],
    ['/api/homepage/projects', projects],
    ['/api/homepage/logs', logs]
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), expected, path);
  }
  assert.equal((await fetch(base + '/api/posts', { method: 'POST' })).status, 404);
});

test('BSON values and persisted R2 references survive response hydration', async (t) => {
  const original = process.env.R2_PUBLIC_DOMAIN;
  process.env.R2_PUBLIC_DOMAIN = 'https://assets.samyao.me';
  t.after(() => {
    if (original === undefined) delete process.env.R2_PUBLIC_DOMAIN;
    else process.env.R2_PUBLIC_DOMAIN = original;
  });

  const id = new ObjectId('5e016d3bba7fee6979e4982d');
  const repository = {
    ...fakeRepository,
    projects: async () => [{
      _id: id,
      coverImage: 'uploads/test-cover.png',
      createdAt: new Date('2026-01-01T00:00:00.000Z')
    }]
  };
  const app = createApp(repository);
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/homepage/projects');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, [{
    _id: '5e016d3bba7fee6979e4982d',
    coverImage: 'https://assets.samyao.me/uploads/test-cover.png',
    createdAt: '2026-01-01T00:00:00.000Z'
  }]);
});
