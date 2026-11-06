import { test } from 'node:test';
import assert from 'node:assert/strict';
import gateway, { legacyUpstreamCategory } from './src/index.js';

test('audit classification never reproduces user path segments', () => {
  assert.equal(legacyUpstreamCategory('/api/brain/sync/mcp'), 'second-brain-mcp');
  assert.equal(legacyUpstreamCategory('/token'), 'second-brain-mcp');
  assert.equal(legacyUpstreamCategory('/api/users/profile'), 'identity-and-rbac');
  assert.equal(legacyUpstreamCategory('/api/upload/sensitive.png'), 'media');
  assert.equal(legacyUpstreamCategory('/api/chat/ai/some-session'), 'ai');
  assert.equal(legacyUpstreamCategory('/api/footprints/507f1f77bcf86cd799439011'), 'personal-and-content');
  assert.equal(legacyUpstreamCategory('/api/backup/restore'), 'operations');
  assert.equal(legacyUpstreamCategory('/api/unknown/private-id'), 'other');
});

test('actual Cloud Run fallback logs only category and method', async () => {
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  const logs=[], urls=[];
  console.info = (...args) => logs.push(args);
  globalThis.fetch = async (req) => {
    urls.push(req.url);
    return Response.json({ok:true});
  };
  try {
    const env={
      ORIGIN_URL:'https://old-origin.example',
      LEGACY_UPSTREAM_AUDIT:'1',
      GENERAL_LIMITER:{limit:async()=>({success:true})},
      EXPENSIVE_LIMITER:{limit:async()=>({success:true})}
    };
    const r=await gateway.fetch(new Request(
      'https://api.samyao.me/api/footprints/507f1f77bcf86cd799439011?private=never-log-me',
      {headers:{origin:'https://samyao.me',cookie:'orion_session=never-log-me'}}
    ),env);
    assert.equal(r.status,200);
    assert.deepEqual(logs,[['orion-legacy-upstream','personal-and-content','GET']]);
    assert.equal(JSON.stringify(logs).includes('never-log-me'),false);
    assert.equal(JSON.stringify(logs).includes('507f1f77bcf86cd799439011'),false);
    assert.equal(urls.length,1);
  } finally {
    console.info=previousInfo;
    globalThis.fetch=previousFetch;
  }
});
