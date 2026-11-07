import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAIN_OPENAPI_PATH,brainDiscoveryDocument,handleBrainDiscovery
} from '../src/brainDiscovery.js';
import {vaultOpenApi} from '../../../services/brain/openapi.js';

test('Worker uses original pure OpenAPI source rather than a partial copy',async()=>{
  const expected=vaultOpenApi('https://api.samyao.me');
  const doc=brainDiscoveryDocument(BRAIN_OPENAPI_PATH);
  assert.deepEqual(doc,expected);
  assert.equal(doc.openapi,'3.1.0');
  assert.deepEqual(Object.keys(doc.paths),[
    '/search','/memories/{id}','/sync'
  ]);
  assert.equal(doc.servers[0].url,'https://api.samyao.me/api/brain/sync/v1');
  assert.equal(doc.paths['/sync'].post['x-openai-isConsequential'],true);
  const response=handleBrainDiscovery(new Request(
    'https://api.samyao.me'+BRAIN_OPENAPI_PATH
  ));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await response.json(),expected);
  assert.equal(handleBrainDiscovery(new Request(
    'https://api.samyao.me'+BRAIN_OPENAPI_PATH+'?extra=1'
  )),null);
  assert.equal(handleBrainDiscovery(new Request(
    'https://api.samyao.me'+BRAIN_OPENAPI_PATH,{method:'POST'}
  )),null);
});
