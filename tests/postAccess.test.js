import request from 'supertest';
import app from '../index.js';
import Post from '../models/Post.js';
import { canReadPost } from '../utils/postAccess.js';

test('Public posts are readable without a session', () => {
  expect(canReadPost({ isPrivate: false })).toBe(true);
});
test('Private posts require read permission or super admin access', () => {
  expect(canReadPost({ isPrivate: true })).toBe(false);
  expect(canReadPost({ isPrivate: true }, { role: 'user', permissions: [] })).toBe(false);
  for (const user of [{ role: 'super_admin' }, { permissions: ['*'] }, { permissions: ['PRIVATE_POST:READ'] }]) {
    expect(canReadPost({ isPrivate: true }, user)).toBe(true);
  }
});
test('The public detail endpoint hides private entries', async () => {
  await Post.create({ _id: '654321000000000000000001', isPrivate: true, name: 'Private entry', info: 'Private', author: 'Test' });
  expect((await request(app).get('/api/posts/654321000000000000000001')).status).toBe(404);
});
test('The public detail endpoint returns public entries', async () => {
  await Post.create({ _id: '654321000000000000000001', isPrivate: false, name: 'Public entry', info: 'Public', author: 'Test' });
  const response = await request(app).get('/api/posts/654321000000000000000001');
  expect(response.status).toBe(200);
  expect(response.body.name).toBe('Public entry');
});
