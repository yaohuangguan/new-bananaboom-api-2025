import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { extractLegacyToken, authenticateLegacyRequest, canReadPrivatePosts } from '../src/auth.js';

const secret = 'a-test-only-key-that-is-at-least-32-bytes';
const id = '507f1f77bcf86cd799439011';
const sign = (options = {}) => new SignJWT({ user: { id, role: options.claimedRole || 'user', permissions: ['*'] } })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime(options.expired ? '-1s' : '1h')
  .sign(new TextEncoder().encode(secret));

async function serverFor(repo) {
  const app = createApp(repo, { secretProvider: async () => secret });
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

test('extracts header/bearer/cookie in legacy priority order', () => {
  assert.equal(extractLegacyToken({ 'x-auth-token': 'header', authorization: 'Bearer bearer', cookie: 'orion_session=cookie' }), 'header');
  assert.equal(extractLegacyToken({ authorization: 'Bearer bearer', cookie: 'orion_session=cookie' }), 'bearer');
  assert.equal(extractLegacyToken({ cookie: 'a=1; orion_session=with%2Ecookie' }), 'with.cookie');
  assert.equal(extractLegacyToken({ cookie: 'a=1' }), null);
});

test('signed JWT alone does not authenticate: session and live user must exist', async () => {
  const token = await sign();
  const guest = await authenticateLegacyRequest({ 'x-auth-token': token }, { authorizeSession: async () => null }, secret);
  assert.equal(guest.kind, 'guest');
  const mismatch = await authenticateLegacyRequest({ 'x-auth-token': token }, {
    authorizeSession: async () => ({ id: '507f1f77bcf86cd799439012', role: 'super_admin', permissions: ['*'] })
  }, secret);
  assert.equal(mismatch.kind, 'invalid');
});

test('rejects forged and expired JWT, and disallows relying on JWT role claims', async () => {
  let queried = 0;
  const repo = { authorizeSession: async () => {
    queried++;
    return { id, role: 'user', permissions: [] };
  } };
  const forged = (await sign()) + 'x';
  assert.deepEqual((await authenticateLegacyRequest({ 'x-auth-token': forged }, repo, secret)).kind, 'invalid');
  assert.equal((await authenticateLegacyRequest({ 'x-auth-token': await sign({ expired: true }) }, repo, secret)).code, 'AUTH_EXPIRED');
  assert.equal(queried, 0);
  const claimedSuperAdmin = await sign({ claimedRole: 'super_admin' });
  const auth = await authenticateLegacyRequest({ 'x-auth-token': claimedSuperAdmin }, repo, secret);
  assert.equal(auth.kind, 'authenticated');
  assert.equal(canReadPrivatePosts(auth.user), false);
});

test('private listing enforces login, session revocation, and live permission', async (t) => {
  const token = await sign();
  let session = null;
  const repo = {
    authorizeSession: async (rawToken) => rawToken === token ? session : null,
    privatePosts: async (options) => ({
      data: [{ _id: 'private1', isPrivate: true, name: 'Private article' }],
      pagination: { currentPage: options.page, perPage: options.limit, totalPosts: 1, totalPages: 1 }
    })
  };
  const { server, url } = await serverFor(repo);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let res = await fetch(url + '/api/posts/private/posts');
  assert.equal(res.status, 401);
  res = await fetch(url + '/api/posts/private/posts', { headers: { 'x-auth-token': token } });
  assert.equal(res.status, 401); // valid signed but revoked/missing session
  session = { id, role: 'user', permissions: [] };
  res = await fetch(url + '/api/posts/private/posts', { headers: { 'x-auth-token': token } });
  assert.equal(res.status, 403);
  session.permissions = ['PRIVATE_POST:READ'];
  res = await fetch(url + '/api/posts/private/posts?page=2&limit=3', { headers: { 'x-auth-token': token } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).pagination.currentPage, 2);
  session.permissions = [];
  session.role = 'super_admin';
  res = await fetch(url + '/api/posts/private/posts', { headers: { cookie: 'orion_session=' + token } });
  assert.equal(res.status, 200);
  session = null;
  res = await fetch(url + '/api/posts/private/posts', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(res.status, 401);
});

test('staged v2 tokens and legacy short-key tokens share strict session + RBAC verification', async () => {
  const legacy = 'legacy-test';
  const next = 'a-v2-test-secret-with-more-than-thirty-two-characters';
  const config = { legacy, next };
  const oldToken = await new SignJWT({ user: { id, permissions: ['*'] } })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(legacy));
  const newToken = await new SignJWT({ user: { id, role: 'super_admin' } })
    .setProtectedHeader({ alg: 'HS256', kid: 'orion-v2' })
    .setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(next));

  const approved = new Set([oldToken, newToken]);
  const repository = { authorizeSession: async (token) => approved.has(token)
    ? { id, role: 'user', permissions: ['PRIVATE_POST:READ'] } : null };

  assert.equal((await authenticateLegacyRequest({ authorization: 'Bearer ' + oldToken }, repository, config)).kind, 'authenticated');
  const newAuth = await authenticateLegacyRequest({ authorization: 'Bearer ' + newToken }, repository, config);
  assert.equal(newAuth.kind, 'authenticated');
  assert.equal(newAuth.user.role, 'user'); // never trusts 'super_admin' from JWT
  assert.equal((await authenticateLegacyRequest({ authorization: 'Bearer ' + newToken }, repository, { legacy })).code, 'AUTH_INVALID');

  approved.delete(oldToken);
  const revoked = await authenticateLegacyRequest({ authorization: 'Bearer ' + oldToken }, repository, config);
  assert.equal(revoked.kind, 'guest');

  approved.delete(newToken);
  const v2Revoked = await authenticateLegacyRequest({ authorization: 'Bearer ' + newToken }, repository, config);
  assert.equal(v2Revoked.kind, 'guest');
});

test('unknown key identifier and invalid v2 signing configuration fail closed', async () => {
  const legacy = 'legacy-test';
  const next = 'a-v2-test-secret-with-more-than-thirty-two-characters';
  const token = await new SignJWT({ user: { id } })
    .setProtectedHeader({ alg: 'HS256', kid: 'unexpected' })
    .setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(legacy));
  const repo = { authorizeSession: async () => { throw Error('should not touch DB'); } };
  assert.equal((await authenticateLegacyRequest({ 'x-auth-token': token }, repo, { legacy, next })).kind, 'invalid');
  await assert.rejects(
    authenticateLegacyRequest({ 'x-auth-token': token }, repo, { legacy, next: 'short' }),
    /at least 32/
  );
});
