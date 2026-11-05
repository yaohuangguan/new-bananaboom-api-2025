import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactPublicPostResponse, redactPublicPostPayload } from './src/publicPostPrivacy.js';

const author = {
  _id: 'u', displayName: 'Author', photoURL: 'https://photo.example/image.png',
  email: 'private@example.com', aiServices: { secret: true }, role: 'super_admin',
  extraPermissions: ['*'], timezone: 'Pacific/Auckland', phone: '+000'
};
const expected = { _id: 'u', displayName: 'Author', photoURL: 'https://photo.example/image.png' };

test('minimizes public author fields without altering the post body or pagination', () => {
  const source = { data: [{ _id: 'p', user: author, name: 'Article' }], pagination: { currentPage: 1 } };
  const cleaned = redactPublicPostPayload(source);
  assert.deepEqual(cleaned, { data: [{ _id: 'p', user: expected, name: 'Article' }], pagination: { currentPage: 1 } });
  assert.equal(source.data[0].user.email, 'private@example.com');
});

test('Gateway sanitizes both new Worker and Cloud Run post responses', async () => {
  const req = new Request('https://api.samyao.me/api/posts?page=1', { method: 'GET' });
  const upstream = new Response(JSON.stringify({ data: [{ user: author, name: 'Article' }] }), {
    headers: { 'content-type': 'application/json', 'content-length': '999', etag: 'abc', 'x-bananaboom-origin': 'worker' }
  });
  const cleaned = await redactPublicPostResponse(req, upstream);
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.headers.has('content-length'), false);
  assert.equal(cleaned.headers.has('etag'), false);
  assert.equal(cleaned.headers.get('x-bananaboom-origin'), 'worker');
  assert.deepEqual((await cleaned.json()).data[0].user, expected);

  const detail = await redactPublicPostResponse(
    new Request('https://api.samyao.me/api/posts/507f1f77bcf86cd799439011'),
    new Response(JSON.stringify({ user: author }), { headers: { 'content-type': 'application/json' } })
  );
  assert.deepEqual((await detail.json()).user, expected);
});

test('private URLs and non-GETs are not rewritten', async () => {
  const body = JSON.stringify({ user: author });
  const response = new Response(body, { headers: { 'content-type': 'application/json' } });
  assert.strictEqual(await redactPublicPostResponse(
    new Request('https://api.samyao.me/api/posts/private/posts'), response
  ), response);
  assert.strictEqual(await redactPublicPostResponse(
    new Request('https://api.samyao.me/api/posts', { method: 'POST' }), response
  ), response);
});

test('fails closed for malformed successful upstream post response', async () => {
  const req = new Request('https://api.samyao.me/api/posts');
  assert.equal((await redactPublicPostResponse(req, new Response('not JSON'))).status, 502);
});
