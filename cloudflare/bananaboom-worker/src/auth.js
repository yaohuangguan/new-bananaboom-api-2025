import { jwtVerify, decodeProtectedHeader, errors as joseErrors } from 'jose';

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
export async function verifyKeyringToken(token, secrets) {
  const config = typeof secrets === 'string'
    ? { legacy: secrets, next: null }
    : secrets || {};
  if (!config.legacy || typeof config.legacy !== 'string') {
    throw new Error('Missing legacy SECRET_JWT');
  }
  if (config.next && (config.next.length < 32 || config.next === config.legacy)) {
    throw new Error('ORION_JWT_NEXT_SECRET must be distinct and at least 32 characters');
  }

  let protectedHeader;
  try {
    protectedHeader = decodeProtectedHeader(token);
  } catch {
    return { kind: 'invalid', code: 'AUTH_INVALID' };
  }

  if (protectedHeader.alg !== 'HS256') {
    return { kind: 'invalid', code: 'AUTH_INVALID' };
  }
  let key;
  if (protectedHeader.kid === 'orion-v2') {
    key = config.next;
  } else if (!protectedHeader.kid) {
    key = config.legacy;
  }
  if (!key) return { kind: 'invalid', code: 'AUTH_INVALID' };

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(key), { algorithms: ['HS256'] });
    return { kind: 'verified', claims: payload };
  } catch (error) {
    return {
      kind: 'invalid',
      code: error instanceof joseErrors.JWTExpired ? 'AUTH_EXPIRED' : 'AUTH_INVALID'
    };
  }
}

export async function authenticateLegacyRequest(headers, repo, secret) {
  const token = extractLegacyToken(headers);
  if (!token) return { kind: 'guest' };
  // Legacy short key is accepted only for compatibility with existing sessions,
  // and never grants access by itself: the MongoDB session whitelist remains
  // mandatory. New v2 keys must meet the stronger minimum.
  const verified = await verifyKeyringToken(token, secret);
  if (verified.kind !== 'verified') return verified;
  const claims = verified.claims;

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
