import { jwtVerify, errors as joseErrors } from 'jose';

const TOKEN_COOKIE = 'orion_session';
const VALID_ID = /^[a-f0-9]{24}$/i;
const PRIVATE_POST_READ = 'PRIVATE_POST:READ';

export function extractLegacyToken(headers = {}) {
  const direct = headers['x-auth-token'];
  if (typeof direct === 'string' && direct) return direct;
  const authorization = headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const bearer = authorization.slice(7).trim();
    if (bearer) return bearer;
  }
  const rawCookies = typeof headers.cookie === 'string' ? headers.cookie : '';
  for (const part of rawCookies.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1 || part.slice(0, idx).trim() !== TOKEN_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fail closed on signed tokens without a live, nonexpired MongoDB session.
 * Never trust roles or permissions embedded in JWT claims.
 */
export async function authenticateLegacyRequest(headers, repo, secret) {
  const token = extractLegacyToken(headers);
  if (!token) return { kind: 'guest' };
  if (typeof secret !== 'string' || secret.length < 16) {
    // Missing signing key is a server configuration error, NOT a guest session.
    throw new Error('SECRET_JWT is missing or unsafe');
  }

  let claims;
  try {
    const result = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
    claims = result.payload;
  } catch (error) {
    return {
      kind: 'invalid',
      code: error instanceof joseErrors.JWTExpired ? 'AUTH_EXPIRED' : 'AUTH_INVALID'
    };
  }

  const subjectId = claims?.user?.id || claims?.user?._id;
  if (typeof subjectId !== 'string' || !VALID_ID.test(subjectId)) {
    return { kind: 'invalid', code: 'AUTH_INVALID' };
  }

  // Only the persisted session and live database roles grant access.
  const liveUser = await repo.authorizeSession(token);
  if (!liveUser) return { kind: 'guest' }; // matches legacy Soft Auth
  if (String(liveUser.id) !== subjectId) return { kind: 'invalid', code: 'AUTH_INVALID' };
  return { kind: 'authenticated', user: liveUser, token };
}

export function hasPermission(user, requiredPermission) {
  if (!user) return false;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return user.role === 'super_admin' || perms.includes('*') || perms.includes(requiredPermission);
}

export function canReadPrivatePosts(user) {
  return hasPermission(user, PRIVATE_POST_READ);
}
