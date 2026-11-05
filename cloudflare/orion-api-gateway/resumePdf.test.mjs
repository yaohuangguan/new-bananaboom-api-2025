import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumePdfParameters, serveResumePdf } from './src/resumePdf.js';

test('PDF browser only opens a fixed Orion website with bounded safe query options', () => {
  const opts=resumePdfParameters('https://api.samyao.me/api/resumes/export-pdf?user=sam&lang=en&paperSize=A3&pageLimit=3');
  assert.equal(new URL(opts.url).origin,'https://samyao.me');
  assert.equal(new URL(opts.url).pathname,'/profile');
  assert.equal(new URL(opts.url).searchParams.get('print'),'true');
  assert.equal(opts.pageLimit,3);
  for(const q of ['?user=http%3A%2F%2Fevil','?url=https://evil','?user=a&user=b',
    '?lang=%3Cscript%3E','?paperSize=abc','?pageLimit=99','?pageLimit=-1']){
    assert.equal(resumePdfParameters('https://api.samyao.me/api/resumes/export-pdf'+q),null,q);
  }
});
test('Browser Run returns verified PDF magic bytes; never forwards credentials',async()=>{
  let options;
  const response=await serveResumePdf(new Request('https://api.samyao.me/api/resumes/export-pdf?user=sam',{
    headers:{cookie:'orion_session=do-not-forward',authorization:'Bearer protected'}
  }),{BROWSER:{quickAction:async (kind,o)=>{
    assert.equal(kind,'pdf');options=o;
    return new Response(new TextEncoder().encode('%PDF-1.7\n%%EOF'),{status:200});
  }}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/pdf');
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.ok(options.url.startsWith('https://samyao.me/profile?'));
  assert.equal(JSON.stringify(options).includes('protected'),false);
  assert.match(await response.text(),/^%PDF-/);
});
test('missing Browser Run or invalid result fails closed',async()=>{
 const request=new Request('https://api.samyao.me/api/resumes/export-pdf');
 assert.equal((await serveResumePdf(request,{})).status,503);
 assert.equal((await serveResumePdf(request,{BROWSER:{quickAction:async()=>new Response('not PDF')}})).status,502);
});
test('gateway PDF hits Browser Run but never Cloud Run',async()=>{
 const {default:gateway}=await import('./src/index.js');
 const originalFetch=globalThis.fetch;
 let upstream=0,limited=0;
 globalThis.fetch=async()=>{upstream++;return new Response('No')};
 try{
 const env={
  ORIGIN_URL:'https://upstream.example',
  GENERAL_LIMITER:{limit:async()=>({success:true})},
  EXPENSIVE_LIMITER:{limit:async()=>{limited++;return {success:true}}},
  BROWSER:{quickAction:async()=>new Response(new TextEncoder().encode('%PDF-1.7\n%%EOF'))},
  PDF_BROWSER_CUTOVER:'1'
 };
 const res=await gateway.fetch(new Request('https://api.samyao.me/api/resumes/export-pdf',{
  headers:{origin:'https://samyao.me'}
 }),env);
 assert.equal(res.status,200);
 assert.equal(res.headers.get('x-orion-pdf-renderer'),'browser-run');
 assert.equal(res.headers.get('access-control-allow-origin'),'https://samyao.me');
 assert.equal(limited,1);
 assert.equal(upstream,0);
 }finally{globalThis.fetch=originalFetch}
});
