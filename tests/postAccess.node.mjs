import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReadPost } from '../utils/postAccess.js';

test('public posts remain readable by guests', () => assert.equal(canReadPost({ isPrivate: false }, null), true));
test('private posts deny guests, ordinary users, and public-only editors', () => {
  for (const user of [null, {}, { permissions: ['BLOG:MANAGE'] }, { permissions: ['PRIVATE_DOMAIN:ACCESS'] }]) assert.equal(canReadPost({ isPrivate: true }, user), false);
});
test('private readers and superadmins retain access', () => {
  for (const user of [{ permissions: ['PRIVATE_POST:READ'] }, { permissions: ['*'] }, { role: 'super_admin' }]) assert.equal(canReadPost({ isPrivate: true }, user), true);
});


test('GET detail route enforces privacy and returns structured content unchanged', async () => {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { default: Post } = await import('../models/Post.js');
  const { default: posts } = await import('../routes/posts.js');
  const original = Post.findById;
  const body = '<p><span data-type="journal-math" data-latex="x^2">x^2</span></p><figure data-type="journal-drawing" data-strokes="[]">手写笔记</figure>';
  Post.findById = () => ({ populate: async () => ({ _id: '123456789012345678901234', isPrivate: true, content: body }) });
  try {
    for (const [user, status] of [[null, 404], [{ permissions: ['BLOG:MANAGE'] }, 404], [{ permissions: ['PRIVATE_POST:READ'] }, 200]]) {
      const app = express(); app.use((req, res, next) => { req.user = user; next(); }); app.use('/posts', posts);
      const response = await request(app).get('/posts/123456789012345678901234');
      assert.equal(response.status, status);
      if (status === 200) assert.equal(response.body.content, body);
      else assert.equal(response.body.content, undefined);
    }
  } finally { Post.findById = original; }
});
