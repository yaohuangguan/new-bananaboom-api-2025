import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRouteToCoreWorker } from './src/index.js';

test('only explicit public homepage read routes use the Worker', () => {
  for (const path of ['/api/homepage', '/api/homepage/likes', '/api/homepage/projects', '/api/homepage/logs']) {
    assert.equal(shouldRouteToCoreWorker('GET', path), true);
    assert.equal(shouldRouteToCoreWorker('HEAD', path), false);
    assert.equal(shouldRouteToCoreWorker('POST', path), false);
    assert.equal(shouldRouteToCoreWorker('DELETE', path), false);
  }

  for (const path of ['/api/homepage/likes/id/add', '/api/posts', '/api/auth', '/api/users', '/api/homepage/private']) {
    assert.equal(shouldRouteToCoreWorker('GET', path), false);
  }
});
