import {
  authenticateLegacyRequest,extractLegacyToken,hasPermission
} from './auth.js';

const TRUSTED_ORIGINS=new Set([
  'https://samyao.me','https://www.samyao.me',
  'https://ps6.space','https://www.ps6.space',
  'https://bananaboom-frontend.vercel.app',
  'http://localhost:5173'
]);

/**
 * Internal service-binding authorization gate for still-legacy CMS photo
 * mutations. The old Express routeGuardMap omitted /api/photos writes,
 * so the default "unmatched means allow" rule was unsafe.
 *
 * Validates CURRENT user+session+RBAC in Mongo; no photo data is mutated here.
 * This endpoint is never forwarded publicly by Gateway, and Core's
 * workers_dev is disabled. Future owner-scoped photo CRUD can reuse this gate.
 */
export function registerPhotoWriteAuthorization(app,repository,secretProvider){
  app.post('/_internal/authorize-photos-write',async ctx=>{
    ctx.set('Cache-Control','private, no-store');
    ctx.set('X-Content-Type-Options','nosniff');
    const origin=ctx.headers.origin;
    if(origin&&!TRUSTED_ORIGINS.has(origin) ||
       ctx.headers.cookie&&(!origin||!TRUSTED_ORIGINS.has(origin))){
      ctx.status=403;
      return {message:'Untrusted write origin'};
    }
    if(!extractLegacyToken(ctx.headers)){
      ctx.status=401;
      return {message:'Signed-in admin required'};
    }
    let auth;
    try{
      auth=await authenticateLegacyRequest(
        ctx.headers,repository,await secretProvider()
      );
    }catch(error){
      console.error('photo-write-authz-unavailable',error?.name||'Error');
      ctx.status=503;
      return {message:'Photo authorization unavailable'};
    }
    if(auth.kind!=='authenticated'){
      ctx.status=401;
      return {message:'Signed-in admin required'};
    }
    // '*' is the legacy SUPER_ADMIN permission; live Session+role must
    // match the JWT subject, so caller-controlled JWT roles never count.
    if(!hasPermission(auth.user,'*')){
      ctx.status=403;
      return {message:'Photo administrator permission required'};
    }
    ctx.status=204;
    return '';
  });
}
