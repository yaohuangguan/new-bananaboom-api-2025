import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRouteToCoreWorker } from './src/index.js';

const post='507f1f77bcf86cd799439011';

test('public comment GETs migrate and authentication/write paths remain on Cloud Run',()=>{
  const list='/api/comments/'+post, reply='/api/comments/reply/'+post;
  for (const path of [list,reply]) {
    assert.equal(shouldRouteToCoreWorker('GET',path),true);
    assert.equal(shouldRouteToCoreWorker('GET',path,'',new Headers({cookie:'GAESA=unrelated'})),true);
    assert.equal(shouldRouteToCoreWorker('POST',path),false);
    assert.equal(shouldRouteToCoreWorker('PUT',path),false);
    assert.equal(shouldRouteToCoreWorker('GET',path,'?page=2'),false);
    for(const auth of [
      {'x-auth-token':'dummy'},
      {'x-google-auth':'{}'},
      {authorization:'Bearer fake'},
      {cookie:'other=1; orion_session=signed'}
    ]) assert.equal(shouldRouteToCoreWorker('GET',path,'',new Headers(auth)),false);
  }
  for(const path of ['/api/comments','/api/comments/not-an-id',
    '/api/comments/reply/not-an-id','/api/comments/admin/123',
    '/api/comments/'+post+'/delete']) {
    assert.equal(shouldRouteToCoreWorker('GET',path),false);
  }
});
