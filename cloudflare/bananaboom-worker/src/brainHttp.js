import { BRAIN_API_RESOURCE, safeBrainFailureKind } from './brainRead.js';

// Protected endpoint implementations matching existing /api/brain/sync/v1
// REST read semantics. The Gateway keeps all real traffic on Cloud Run until
// the old API response envelope, scope checks and token lifecycle are proven.
const READ_ORIGINS = new Set(['https://claude.ai','https://chatgpt.com','https://samyao.me','https://www.samyao.me']);

function bodySize(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return Infinity; }
}
function parseBearer(ctx) {
  const match = /^Bearer (ov_[A-Za-z0-9_-]{43})$/.exec(ctx.headers.authorization || '');
  return match?.[1] || null;
}
function sendKnown(ctx,result) {
  if (result?.ok) return result.data;
  const code=result?.code;
  const status=result?.status;
  const allowed = new Set([
    'INVALID_CONNECTION_TOKEN','BRAIN_PERMISSION_REQUIRED','INSUFFICIENT_SCOPE',
    'INVALID_SYNC_INPUT','INVALID_ID','INVALID_QUERY','NOT_FOUND',
    'EXPECTED_REVISION_REQUIRED','MEMORY_ID_REQUIRED',
    'IDEMPOTENCY_CONFLICT','REVISION_CONFLICT'
  ]);
  if (typeof code === 'string' && allowed.has(code) &&
    Number.isInteger(status) && [400,401,403,404,409].includes(status)) {
    ctx.status=status;
    return {message:code};
  }
  if (result?.diagnostic && /^[a-z-]{3,90}$/.test(result.diagnostic)) {
    console.error('brain-worker-rpc-diagnostic',result.diagnostic);
  }
  ctx.status=503;
  return {message:'KNOWLEDGE_SYNC_FAILED'};
}

export function registerBrainReadRoutes(app, repository, options={}) {
  const origins = new Set([...READ_ORIGINS,...(options.allowedOrigins || [])]);
  const authorize = ctx => {
    ctx.set('Cache-Control','private, no-store');
    ctx.set('Referrer-Policy','no-referrer');
    ctx.set('X-Content-Type-Options','nosniff');
    const origin=ctx.headers.origin;
    if (origin && !origins.has(origin)) {
      ctx.status=403;
      return {error:{message:'ORIGIN_REJECTED'}};
    }
    const token=parseBearer(ctx);
    if (!token) {
      ctx.status=401;
      return {error:{message:'CONNECTION_AUTH_REQUIRED'}};
    }
    return {token};
  };
  app.post('/api/brain/sync/v1/search',async ctx => {
    const auth=authorize(ctx);
    if (auth.error) return auth.error;
    if (bodySize(ctx.requestBody) > 128*1024) {
      ctx.status=413;
      return {message:'INVALID_SYNC_INPUT'};
    }
    try {
      const result=await repository.brainVaultSearch(
        auth.token,ctx.requestBody,BRAIN_API_RESOURCE);
      return sendKnown(ctx,result);
    } catch (error) {
      console.error('brain-worker-search-error',error?.name || 'Error',safeBrainFailureKind(error));
      ctx.status=503;
      return {message:'KNOWLEDGE_SYNC_FAILED'};
    }
  });
  // Gateway keeps normal write traffic on Cloud Run. Only a separate
  // opt-in write canary with an existing memory:write Bearer key reaches here.
  app.post('/api/brain/sync/v1/sync',async ctx => {
    const auth=authorize(ctx);
    if (auth.error) return auth.error;
    if (bodySize(ctx.requestBody) > 128*1024) {
      ctx.status=413;
      return {message:'INVALID_SYNC_INPUT'};
    }
    try {
      const result=await repository.brainVaultSync(
        auth.token,ctx.requestBody,BRAIN_API_RESOURCE);
      return sendKnown(ctx,result);
    } catch (error) {
      console.error('brain-worker-write-error',error?.name||'Error',safeBrainFailureKind(error));
      ctx.status=503;
      return {message:'KNOWLEDGE_SYNC_FAILED'};
    }
  });

  app.get('/api/brain/sync/v1/memories/:id',async ctx => {
    const auth=authorize(ctx);
    if (auth.error) return auth.error;
    try {
      const result=await repository.brainVaultRead(
        auth.token,ctx.params.id,BRAIN_API_RESOURCE);
      return sendKnown(ctx,result);
    } catch (error) {
      console.error('brain-worker-read-error',error?.name || 'Error',safeBrainFailureKind(error));
      ctx.status=503;
      return {message:'KNOWLEDGE_SYNC_FAILED'};
    }
  });
}
