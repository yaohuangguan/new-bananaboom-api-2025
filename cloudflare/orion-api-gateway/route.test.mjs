import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRouteToCoreWorker } from './src/index.js';

test('only explicit public read routes use the Worker', () => {
  for (const path of ['/api/homepage', '/api/homepage/likes', '/api/homepage/projects', '/api/homepage/logs', '/api/projects', '/api/menu', '/api/posts', '/api/tags']) {
    assert.equal(shouldRouteToCoreWorker('GET', path), true);
    assert.equal(shouldRouteToCoreWorker('HEAD', path), false);
    assert.equal(shouldRouteToCoreWorker('POST', path), false);
    assert.equal(shouldRouteToCoreWorker('DELETE', path), false);
  }

  for (const path of ['/api/homepage/likes/id/add', '/api/posts/private/posts', '/api/posts/likes/123', '/api/projects/123', '/api/auth', '/api/users', '/api/homepage/private']) {
    assert.equal(shouldRouteToCoreWorker('GET', path), false);
  }
});

test('authenticated or invalid list requests remain on original Cloud Run', () => {
  assert.equal(shouldRouteToCoreWorker('GET', '/api/tags', '?type=private'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/tags', '?type=all'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/tags', '?type=public&type=private'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/tags', '?type=public'), true);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts', '?page=2&limit=3&q=React'), true);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts', '?page=-1'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts', '?limit=500'), false);
  assert.equal(shouldRouteToCoreWorker('POST', '/api/projects'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/507f1f77bcf86cd799439011'), true);
});

test('public post detail only goes to Worker for anonymous readers', () => {
  const detail = '/api/posts/507f1f77bcf86cd799439011';
  assert.equal(shouldRouteToCoreWorker('GET', detail), true);
  assert.equal(shouldRouteToCoreWorker('HEAD', detail), false);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ cookie: 'orion_session=token' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ cookie: 'other=one; orion_session=token' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ authorization: 'Bearer token' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ 'x-auth-token': 'token' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ 'x-google-auth': '{}' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/private/posts'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/507f1f77bcf86cd799439011/stuff'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/not-a-valid-id'), false);
});

test('anonymous likes GET is Worker-only, not writes or credentialed reads', () => {
  const path = '/api/posts/likes/507f1f77bcf86cd799439011';
  assert.equal(shouldRouteToCoreWorker('GET', path), true);
  assert.equal(shouldRouteToCoreWorker('POST', path), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({ cookie: 'orion_session=a' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({ authorization: 'Bearer a' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path + '/add'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/likes/nope'), false);
});

test('private post Worker canary is explicit and requires a legacy JWT carrier', () => {
  const path = '/api/posts/private/posts';
  const canary = 'x-orion-private-worker-canary';
  assert.equal(shouldRouteToCoreWorker('GET', path), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({ [canary]: '1' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({
    [canary]: '1', authorization: 'Bearer dummy'
  })), true);
  assert.equal(shouldRouteToCoreWorker('GET', path, '?page=2', new Headers({
    [canary]: '1', cookie: 'orion_session=token'
  })), true);
  assert.equal(shouldRouteToCoreWorker('POST', path, '', new Headers({
    [canary]: '1', authorization: 'Bearer dummy'
  })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({
    [canary]: '1', authorization: 'Bearer dummy', 'x-google-auth': '{}'
  })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({
    [canary]: 'wrong', authorization: 'Bearer dummy'
  })), false);
});

test('public menu list is Worker-only; category duplicates and other menu endpoints remain on Cloud Run', () => {
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu'), true);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu', '?category=dinner'), true);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu', '?category=a&category=b'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu/draw'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu/history'), false);
  assert.equal(shouldRouteToCoreWorker('POST', '/api/menu'), false);
});
