import {
  authenticateLegacyRequest,extractLegacyToken,hasPermission
} from './auth.js';
import {hydrateR2References} from '../../../utils/r2Reference.js';

const TRUSTED_ORIGINS=new Set([
  'https://samyao.me','https://www.samyao.me',
  'https://ps6.space','https://www.ps6.space',
  'https://bananaboom-frontend.vercel.app',
  'http://localhost:5173'
]);
const ALLOWED_ERRORS=new Map([
  ['INVALID_FOOTPRINT_INPUT',400],
  ['INVALID_FOOTPRINT_OPERATION',400],
  ['INVALID_FOOTPRINT_ID',400],
  ['IDEMPOTENCY_KEY_REQUIRED',428],
  ['IDEMPOTENCY_CONFLICT',409],
  ['FOOTPRINT_NOT_FOUND',404],
  ['PERMISSION_DENIED',403],
  ['UNAUTHORIZED',401]
]);

export function registerFootprintMutationRoutes(app,repository,secretProvider){
  async function mutate(ctx,operation){
    ctx.set('Cache-Control','private, no-store');
    const origin=ctx.headers.origin;
    if(origin&&!TRUSTED_ORIGINS.has(origin) ||
       ctx.headers.cookie&&(!origin||!TRUSTED_ORIGINS.has(origin))){
      ctx.status=403;return {msg:'Forbidden'};
    }
    if(!extractLegacyToken(ctx.headers)||ctx.headers['x-google-auth']){
      ctx.status=401;return {msg:'Unauthorized'};
    }
    let auth;
    try{
      auth=await authenticateLegacyRequest(ctx.headers,repository,
        await secretProvider());
    }catch(error){
      console.error('footprint-write-auth-unavailable',error?.name||'Error');
      ctx.status=503;return {msg:'Footprint operation unavailable'};
    }
    if(auth.kind!=='authenticated'){
      ctx.status=401;return {msg:'Unauthorized'};
    }
    if(!hasPermission(auth.user,'FOOTPRINT:USE')){
      ctx.status=403;return {msg:'Forbidden'};
    }
    const length=Number(ctx.headers['content-length']||0);
    const bytes=ctx.requestBody===undefined?0:
      new TextEncoder().encode(JSON.stringify(ctx.requestBody)).byteLength;
    if(length>65536||bytes>65536){
      ctx.status=413;return {msg:'Footprint payload too large'};
    }
    let output;
    try{
      output=await repository.footprintMutate(auth.user,{
        operation,
        id:ctx.params?.id??null,
        key:ctx.headers['idempotency-key'],
        body:ctx.requestBody
      });
    }catch(error){
      console.error('footprint-write-query-error',error?.name||'Error');
      ctx.status=503;return {msg:'Footprint operation unavailable'};
    }
    if(output?.ok){
      return hydrateR2References(JSON.parse(JSON.stringify(output.data)));
    }
    const expected=ALLOWED_ERRORS.get(output?.code);
    if(expected===output?.status){
      ctx.status=expected;
      return {msg:expected===404?'Not Found':output.code};
    }
    ctx.status=503;return {msg:'Footprint operation unavailable'};
  }
  app.post('/api/footprints',ctx=>mutate(ctx,'create'));
  app.put('/api/footprints/:id',ctx=>mutate(ctx,'update'));
  app.delete('/api/footprints/:id',ctx=>mutate(ctx,'delete'));
}
