import jwt from 'jsonwebtoken';

const NEW_KEY_ID = 'orion-v2';

function keyring(env = process.env) {
  // Legacy SECRET_JWT must stay available until its final outstanding session
  // expires. A newly deployed Cloud Run revision never changes this old key.
  const legacy = env.SECRET_JWT || (env.NODE_ENV === 'production' ? null : 'secret');
  const next = env.ORION_JWT_NEXT_SECRET || null;
  const mode = env.ORION_JWT_SIGNING_MODE || 'legacy';

  if (!legacy) throw new Error('Missing legacy SECRET_JWT configuration');
  if (next && (next.length < 32 || next === legacy)) {
    throw new Error('ORION_JWT_NEXT_SECRET must be distinct and at least 32 characters');
  }
  if (mode !== 'legacy' && mode !== 'v2') throw new Error('Invalid ORION_JWT_SIGNING_MODE');
  if (mode === 'v2' && !next) throw new Error('Cannot issue v2 JWT without next secret');
  return { legacy, next, mode };
}

export function signSessionJwt(payload, env = process.env) {
  const { legacy, next, mode } = keyring(env);
  if (mode === 'v2') {
    return jwt.sign(payload, next, {
      algorithm: 'HS256',
      expiresIn: '30d',
      header: { kid: NEW_KEY_ID }
    });
  }
  // Preserve the original JWT header for old deployments/clients.
  return jwt.sign(payload, legacy, { algorithm: 'HS256', expiresIn: '30d' });
}

export function verifySessionJwt(token, env = process.env) {
  const { legacy, next } = keyring(env);
  const header = jwt.decode(token, { complete: true })?.header;
  if (!header || header.alg !== 'HS256') {
    throw new jwt.JsonWebTokenError('Invalid JWT algorithm');
  }
  if (header.kid === NEW_KEY_ID) {
    if (!next) throw new jwt.JsonWebTokenError('Unknown JWT signing key');
    return jwt.verify(token, next, { algorithms: ['HS256'] });
  }
  // Never silently fall back to the weaker legacy key for v2/unknown key IDs.
  if (header.kid) throw new jwt.JsonWebTokenError('Unknown JWT signing key');
  return jwt.verify(token, legacy, { algorithms: ['HS256'] });
}

export function jwtRotationMode(env = process.env) {
  const { mode, next } = keyring(env);
  return { signingMode: mode, nextKeyReady: !!next };
}
