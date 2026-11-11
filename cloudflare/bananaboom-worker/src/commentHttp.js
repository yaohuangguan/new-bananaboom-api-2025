import {authenticateLegacyRequest, extractLegacyToken} from './auth.js';
import {hydrateR2References} from '../../../utils/r2Reference.js';

const ORIGINS = new Set([
  'https://samyao.me', 'https://www.samyao.me',
  'https://ps6.space', 'https://www.ps6.space',
  'https://bananaboom-frontend.vercel.app', 'http://localhost:5173'
]);
const ERRORS = new Map([
  ['INVALID_COMMENT_REQUEST',400],
  ['INVALID_COMMENT_OPERATION',400],
  ['INVALID_COMMENT_ID',400],
  ['INVALID_COMMENT_INPUT',400],
  ['IDEMPOTENCY_KEY_REQUIRED',428],
  ['IDEMPOTENCY_CONFLICT',409],
  ['COMMENT_NOT_FOUND',404],
  ['UNAUTHORIZED',401]
]);

export function registerCommentMutationRoutes(app, repository, secretProvider) {
  const mutation = async (ctx, operation) => {
    ctx.set('Cache-Control', 'private, no-store');
    const origin = ctx.headers.origin;
    if ((origin && !ORIGINS.has(origin)) ||
        (ctx.headers.cookie && (!origin || !ORIGINS.has(origin)))) {
      ctx.status = 403;
      return {message: 'Forbidden'};
    }
    if (ctx.headers['x-google-auth'] || !extractLegacyToken(ctx.headers)) {
      ctx.status = 401;
      return {message: 'Unauthorized'};
    }
    const bytes = ctx.requestBody == null ? 0 :
      new TextEncoder().encode(JSON.stringify(ctx.requestBody)).byteLength;
    if (Number(ctx.headers['content-length'] || 0) > 16384 || bytes > 16384) {
      ctx.status = 413;
      return {message: 'Comment payload too large'};
    }
    let auth;
    try {
      auth = await authenticateLegacyRequest(ctx.headers, repository, await secretProvider());
    } catch (error) {
      console.error('comment-write-auth-unavailable', error?.name || 'Error');
      ctx.status = 503;
      return {message: 'Comment operation unavailable'};
    }
    if (auth.kind !== 'authenticated') {
      ctx.status = 401;
      return {message: 'Unauthorized'};
    }
    let result;
    try {
      result = await repository.commentMutate(auth.user, auth.token, {
        operation, id: ctx.params.id, key: ctx.headers['idempotency-key'],
        body: ctx.requestBody
      });
    } catch (error) {
      console.error('comment-write-failed', error?.name || 'Error');
      ctx.status = 503;
      return {message: 'Comment operation unavailable'};
    }
    if (result?.ok) {
      return hydrateR2References(JSON.parse(JSON.stringify(result.data)));
    }
    const code = result?.code;
    const status = ERRORS.get(code);
    if (status && status === result?.status) {
      ctx.status = status;
      return {message: code};
    }
    ctx.status = 503;
    return {message: 'Comment operation unavailable'};
  };
  app.post('/api/comments/:id', ctx => mutation(ctx, 'create'));
  app.post('/api/comments/reply/:id', ctx => mutation(ctx, 'reply'));
}
