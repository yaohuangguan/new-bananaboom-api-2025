import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRouteToCoreWorker } from './src/index.js';

test('only explicit public homepage read routes use the Worker', () => {
  for (const path of ['/api/homepage', '/api/homepage/likes', '/api/homepage/projects', '/api/homepage/logs', '/api/projects', '/api/posts', '/api/tags']) {
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
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/507f1f77bcf86cd799439011'), false);
});
