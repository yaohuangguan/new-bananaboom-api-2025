import {
  authenticateLegacyRequest, extractLegacyToken, hasPermission
} from './auth.js';
import { hydrateR2References } from '../../../utils/r2Reference.js';

const TRUSTED_ORIGINS=new Set([
  'https://samyao.me','https://www.samyao.me',
  'https://ps6.space','https://www.ps6.space',
  'https://bananaboom-frontend.vercel.app',
  'http://localhost:5173'
]);
const VALID_CODES=new Set([
  'INVALID_TODO_OPERATION','TODO_IDEMPOTENCY_KEY_REQUIRED','INVALID_TODO_ID',
  'INVALID_TODO_INPUT','INVALID_NOTIFY_USERS','PERMISSION_DENIED',
  'UNAUTHORIZED','IDEMPOTENCY_CONFLICT','TODO_NOT_FOUND',
  'INVALID_RECURRENCE','NOT_ROUTINE'
]);

function sendResult(ctx,result){
  if(result?.ok)return hydrateR2References(JSON.parse(JSON.stringify(result.data)));
  if(Number.isInteger(result?.status) &&
     [400,401,403,404,409,428].includes(result.status) &&
     VALID_CODES.has(result.code)) {
    ctx.status=result.status;
    return {message:result.code};
  }
  ctx.status=503;
  return {message:'Todo operation temporarily unavailable'};
}

async function getPrincipal(ctx,repo,secretProvider){
  ctx.set('Cache-Control','private, no-store');
  ctx.set('X-Content-Type-Options','nosniff');
  const origin=ctx.headers.origin;
  if((origin && !TRUSTED_ORIGINS.has(origin)) ||
     (ctx.headers.cookie && (!origin || !TRUSTED_ORIGINS.has(origin)))) {
    ctx.status=403;
    return null;
  }
  if(!extractLegacyToken(ctx.headers)||ctx.headers['x-google-auth']){
    ctx.status=401;
    return null;
  }
  let result;
  try {
    result=await authenticateLegacyRequest(ctx.headers,repo,await secretProvider());
  } catch(error) {
    console.error('todo-mutating-auth-failed',error?.name||'Error');
    ctx.status=503;
    return null;
  }
  if(result.kind!=='authenticated'){
    ctx.status=401;
    return null;
  }
  if(!hasPermission(result.user,'TODO:USE')){
    ctx.status=403;
    return null;
  }
  return result.user;
}

export function registerTodoMutationRoutes(app,repository,secretProvider){
  const operation=async(ctx,method)=>{
    const principal=await getPrincipal(ctx,repository,secretProvider);
    if(!principal)return {message:ctx.status===403?'Forbidden':'Unauthorized'};
    const contentLength=Number(ctx.headers['content-length']||0);
    const parsedLength=ctx.requestBody===undefined?0:
      new TextEncoder().encode(JSON.stringify(ctx.requestBody)).byteLength;
    if(contentLength>65536 || parsedLength>65536){
      ctx.status=413;
      return {message:'Todo payload too large'};
    }
    let id=null;
    if(ctx.params?.id)id=ctx.params.id;
    try{
      const result=await repository.todoMutate(principal,{
        operation:method,id,key:ctx.headers['idempotency-key'],
        body:ctx.requestBody
      });
      return sendResult(ctx,result);
    }catch(error){
      console.error('todo-worker-mutation-failed',error?.name||'Error');
      ctx.status=503;
      return {message:'Todo operation temporarily unavailable'};
    }
  };

  app.post('/api/todos',ctx=>operation(ctx,'create'));
  app.post('/api/todos/done/:id',ctx=>operation(ctx,'update'));
  app.post('/api/todos/routine/:id/check',ctx=>operation(ctx,'check'));
  app.delete('/api/todos/:id',ctx=>operation(ctx,'delete'));
  app.get('/api/todos/done/:id',async ctx=>{
    const principal=await getPrincipal(ctx,repository,secretProvider);
    if(!principal)return {message:ctx.status===403?'Forbidden':'Unauthorized'};
    try{
      const result=await repository.todoDetail(principal,ctx.params.id);
      return sendResult(ctx,result);
    }catch(error){
      console.error('todo-worker-detail-failed',error?.name||'Error');
      ctx.status=503;
      return {message:'Todo detail temporarily unavailable'};
    }
  });
}
