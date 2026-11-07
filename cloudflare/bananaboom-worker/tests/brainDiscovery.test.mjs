import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  brainDiscoveryDocument,handleBrainDiscovery,
  DISCOVERY_AUTH_PATH,DISCOVERY_RESOURCE_PATH
} from '../src/brainDiscovery.js';

const auth={
  issuer:'https://api.samyao.me/',
  authorization_endpoint:'https://api.samyao.me/authorize',
  response_types_supported:['code'],
  code_challenge_methods_supported:['S256'],
  token_endpoint:'https://api.samyao.me/token',
  token_endpoint_auth_methods_supported:['none'],
  grant_types_supported:['authorization_code','refresh_token'],
  scopes_supported:['memory:read','memory:write'],
  revocation_endpoint:'https://api.samyao.me/revoke',
  revocation_endpoint_auth_methods_supported:['none'],
  registration_endpoint:'https://api.samyao.me/register',
  authorization_response_iss_parameter_supported:true
};
const resource={
  resource:'https://api.samyao.me/api/brain/sync/mcp',
  authorization_servers:['https://api.samyao.me/'],
  scopes_supported:['memory:read','memory:write'],
  resource_name:'Orion Personal Knowledge'
};
test('auth discovery exactly matches observed original SDK metadata',()=>{
  assert.deepEqual(brainDiscoveryDocument(DISCOVERY_AUTH_PATH),auth);
  assert.deepEqual(brainDiscoveryDocument(DISCOVERY_RESOURCE_PATH),resource);
  for(const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server/unknown',
    '/token','/register','/revoke','/authorize','/.well-known/oauth-not-supported'
  ])assert.equal(brainDiscoveryDocument(path),null);
});
test('only two public discovery GETs, never token/grant paths',async()=>{
  for(const [path,expected] of [
    [DISCOVERY_AUTH_PATH,auth],[DISCOVERY_RESOURCE_PATH,resource]
  ]){
    const r=handleBrainDiscovery(new Request('https://api.samyao.me'+path));
    assert.equal(r.status,200);
    assert.deepEqual(await r.json(),expected);
    assert.equal(r.headers.get('x-content-type-options'),'nosniff');
    assert.equal(handleBrainDiscovery(new Request('https://api.samyao.me'+path,{
      method:'POST',body:'test'
    })),null);
    assert.equal(handleBrainDiscovery(new Request('https://api.samyao.me'+path+'?key=irrelevant')),null);
  }
});
