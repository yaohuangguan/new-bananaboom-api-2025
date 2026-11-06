import { BrainOAuthGrantError } from './brainOAuthGrant.js';

const ALLOWED_ORIGINS=new Set([
  'https://claude.ai','https://chatgpt.com',
  'https://samyao.me','https://www.samyao.me'
]);
const MAX_FORM_BYTES=32*1024;
function reply(result,status,origin) {
  const headers=new Headers({
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    pragma:'no-cache',
    'referrer-policy':'no-referrer',
    'x-content-type-options':'nosniff'
  });
  if(origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set('access-control-allow-origin',origin);
    headers.set('vary','Origin');
  }
  return new Response(JSON.stringify(result),{status,headers});
}
function oauthFail(error,status=400,origin) {
  return reply({error},status,origin);
}

export async function handleBrainOAuthToken(request,repo) {
  const origin=request.headers.get('origin');
  if(origin && !ALLOWED_ORIGINS.has(origin)) {
    return oauthFail('invalid_request',403,origin);
  }
  if(request.method!=='POST') {
    return new Response(null,{status:405,headers:{allow:'POST','cache-control':'no-store'}});
  }
  const type=request.headers.get('content-type') || '';
  if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(type)) {
    return oauthFail('invalid_request',400,origin);
  }
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>MAX_FORM_BYTES) return oauthFail('invalid_request',413,origin);
  let body;
  try {
    body=await request.text();
    if(new TextEncoder().encode(body).byteLength>MAX_FORM_BYTES) {
      return oauthFail('invalid_request',413,origin);
    }
  }catch{return oauthFail('invalid_request',400,origin);}
  const params=new URLSearchParams(body);
  if([...params.keys()].length>16 ||
     [...new Set(params.keys())].some(key=>params.getAll(key).length!==1)) {
    return oauthFail('invalid_request',400,origin);
  }
  const input=Object.fromEntries(params.entries());
  try {
    const response=await repo.brainOAuthTokenGrant(input);
    if(!response?.ok) {
      if(response?.status===400 || response?.status===401) {
        const name=response.error;
        const safe=new Set(['invalid_request','invalid_client','invalid_grant',
          'invalid_scope','invalid_target','unsupported_grant_type']);
        return oauthFail(safe.has(name)?name:'invalid_grant',response.status,origin);
      }
      return oauthFail('temporarily_unavailable',503,origin);
    }
    return reply(response.data,200,origin);
  }catch(error) {
    // Never log the form, authorization code, client_id, or refresh token.
    if(error instanceof BrainOAuthGrantError) {
      return oauthFail(error.message,error.status,origin);
    }
    console.error('brain-worker-oauth-grant-failed',error?.name||'Error');
    return oauthFail('temporarily_unavailable',503,origin);
  }
}
