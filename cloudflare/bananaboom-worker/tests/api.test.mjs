import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { ObjectId } from 'mongodb';
import { withProjectDefaults } from '../src/projectDefaults.js';

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
  assert.equal((await fetch(base + '/api/posts', { method: 'POST' })).status, 401);
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

test('public posts, tags and portfolio reads use only public repository surfaces', async (t) => {
  const calls = [];
  const repository = {
    ...fakeRepository,
    publicProjects: async () => [{ _id: 'project-visible', isVisible: true }],
    publicTags: async () => [{ name: 'tech', count: 2 }],
    publicPosts: async (options) => {
      calls.push(options);
      return {
        data: [{ _id: 'post1', isPrivate: false }],
        pagination: { currentPage: options.page, perPage: options.limit, totalPosts: 1, totalPages: 1 }
      };
    }
  };
  const app = createApp(repository);
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.deepEqual(await (await fetch(base + '/api/projects')).json(), [{ _id: 'project-visible', isVisible: true }]);
  assert.deepEqual(await (await fetch(base + '/api/tags')).json(), [{ name: 'tech', count: 2 }]);
  const posts = await fetch(base + '/api/posts?page=2&limit=3&tag=tech&q=hello');
  assert.equal(posts.status, 200);
  assert.equal((await posts.json()).pagination.currentPage, 2);
  assert.deepEqual(calls[0], { page: 2, limit: 3, q: 'hello', tag: 'tech' });
  assert.equal((await fetch(base + '/api/posts/private/posts')).status, 401);
  assert.equal((await fetch(base + '/api/posts', { method: 'POST' })).status, 401);
  const invalid = await fetch(base + '/api/posts?q=' + 'x'.repeat(101));
  assert.equal(invalid.status, 400);
});

test('portfolio defaults reproduce Mongoose for old MongoDB records', () => {
  assert.deepEqual(withProjectDefaults({ _id: 'x' }), { _id: 'x', category: 'web', categories: [] });
  assert.deepEqual(withProjectDefaults({ _id: 'y', category: 'tools', categories: ['mobile'] }), {
    _id: 'y', category: 'tools', categories: ['mobile']
  });
});

test('anonymous detail reads use only public post repository and hide missing IDs', async (t) => {
  const id = '507f1f77bcf86cd799439011';
  const repo = { ...fakeRepository,
    publicPostById: async (requested) => requested === id
      ? { _id: id, name: 'Public', isPrivate: false,
          user: { _id: 'author', displayName: 'Sam', photoURL: '' } }
      : null
  };
  const app = createApp(repo);
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const publicRes = await fetch(base + '/api/posts/' + id);
  assert.equal(publicRes.status, 200);
  assert.equal((await publicRes.json()).name, 'Public');
  assert.equal((await fetch(base + '/api/posts/507f1f77bcf86cd799439012')).status, 404);
  assert.equal((await fetch(base + '/api/posts/not-valid')).status, 404);
});

test('public likes count returns the old JSON shape and hides missing posts', async (t) => {
  const id = '507f1f77bcf86cd799439011';
  const app = createApp({
    ...fakeRepository,
    publicPostLikes: async (requested) => requested === id ? { _id: id, likes: 3 } : null,
    changePostLikes: async () => ({ _id: id, likes: 4 })
  });
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(base + '/api/posts/likes/' + id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { _id: id, likes: 3 });
  assert.equal(await (await fetch(base + '/api/posts/likes/507f1f77bcf86cd799439012')).json(), null);
  assert.equal((await fetch(base + '/api/posts/likes/invalid')).status, 404);
  const add = await fetch(base + '/api/posts/likes/' + id + '/add', { method: 'POST' });
  assert.equal(add.status, 200);
  assert.equal((await add.json()).likes, 4);
});

test('public menu GET preserves document shape and filters through repository', async (t) => {
  const queries = [];
  const app = createApp({
    ...fakeRepository,
    publicMenu: async (options) => {
      queries.push(options);
      return [{ _id: 'menu1', name: 'Rice', isActive: true, category: options.category || 'all' }];
    }
  });
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const all = await fetch(base + '/api/menu');
  assert.equal(all.status, 200);
  assert.equal((await all.json())[0].name, 'Rice');
  const category = await fetch(base + '/api/menu?category=dinner');
  assert.equal(category.status, 200);
  assert.equal((await category.json())[0].category, 'dinner');
  assert.deepEqual(queries, [{ category: undefined }, { category: 'dinner' }]);
  assert.equal((await fetch(base + '/api/menu?category=a&category=b')).status, 400);
  assert.equal((await fetch(base + '/api/menu', { method: 'POST' })).status, 405);
});

test('blog like writes preserve legacy add/remove response without changing other routes', async (t) => {
  const id = '507f1f77bcf86cd799439011';
  const calls = [];
  let count = 2;
  const repository = {
    ...fakeRepository,
    changePostLikes: async (postId, direction) => {
      calls.push([postId, direction]);
      if (postId !== id) return null;
      if (direction === 'add') count++;
      if (direction === 'remove' && count > 0) count--;
      return { _id: id, likes: count };
    }
  };
  const app = createApp(repository);
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/posts/likes/' + id;
  const increment = await fetch(url + '/add', { method: 'POST' });
  assert.equal(increment.status, 200);
  assert.deepEqual(await increment.json(), { _id: id, likes: 3 });
  const decrement = await fetch(url + '/remove', { method: 'POST' });
  assert.equal(decrement.status, 200);
  assert.deepEqual(await decrement.json(), { _id: id, likes: 2 });
  assert.deepEqual(calls, [[id, 'add'], [id, 'remove']]);
  assert.equal((await fetch(url + '/add', { method: 'GET' })).status, 405);
  assert.equal((await fetch(url + '/reset', { method: 'POST' })).status, 404);
  assert.equal(await (await fetch('http://127.0.0.1:' + server.address().port +
    '/api/posts/likes/507f1f77bcf86cd799439012/add', { method: 'POST' })).json(), null);
});

test('blog like write error returns 503 and does not reveal internal Mongo errors', async (t) => {
  const id = '507f1f77bcf86cd799439011';
  const app = createApp({
    ...fakeRepository,
    changePostLikes: async () => { throw new Error('mongodb+srv://secret'); }
  });
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const r = await fetch('http://127.0.0.1:' + server.address().port +
    '/api/posts/likes/' + id + '/add', { method: 'POST' });
  assert.equal(r.status, 503);
  assert.doesNotMatch(await r.text(), /mongodb|secret/i);
});

test('public photos and resume reads preserve JSON shape without exposing Mongo lookup', async (t) => {
  const calls = [];
  const repo = {
    ...fakeRepository,
    publicPhotos: async () => [{ _id: 'photo1', url: 'https://assets.samyao.me/photo.png', order: 1 }],
    publicResume: async (user) => {
      calls.push(['detail', user]);
      return user === 'missing' ? null : {
        _id: 'resume1', slug: 'sample', user: 'owner@example.org', title: 'Sample'
      };
    },
    publicResumeList: async (user) => {
      calls.push(['list', user]);
      return [{ _id: 'resume1', slug: 'sample', title: 'Sample', user: 'owner@example.org' }];
    }
  };
  const app = createApp(repo);
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  let r = await fetch(url + '/api/photos');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), [{
    _id: 'photo1', url: 'https://assets.samyao.me/photo.png', order: 1
  }]);
  r = await fetch(url + '/api/resumes');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).user, 'owner@example.org');
  r = await fetch(url + '/api/resumes/list?user=sam');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).length, 1);
  assert.deepEqual(calls, [['detail', undefined], ['list', 'sam']]);
  r = await fetch(url + '/api/resumes?user=missing');
  assert.equal(r.status, 404);
  assert.match((await r.json()).msg, /not found/);
  r = await fetch(url + '/api/resumes/list?user=a&user=b');
  assert.equal(r.status, 400);
});
