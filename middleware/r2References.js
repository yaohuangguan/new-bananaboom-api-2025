import { hydrateR2References, normalizeR2References } from '../utils/r2Reference.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const PERSISTENCE_PREFIXES = [
  '/projects',
  '/posts',
  '/photos',
  '/todo',
  '/fitness',
  '/footprints',
  '/menu',
  '/comments',
  '/users',
  '/chat/ai/save'
];

const shouldNormalizeRequest = (req) => {
  if (!WRITE_METHODS.has(req.method)) return false;
  return PERSISTENCE_PREFIXES.some(
    (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)
  );
};

export const normalizeR2RequestReferences = (req, _res, next) => {
  if (
    shouldNormalizeRequest(req) &&
    req.body &&
    typeof req.body === 'object' &&
    !Buffer.isBuffer(req.body)
  ) {
    req.body = normalizeR2References(req.body);
  }

  next();
};

const toPlainJson = (payload) => {
  if (payload === null || payload === undefined) return payload;

  try {
    // Let Mongoose Documents/arrays apply their own toJSON transforms first.
    // This avoids traversing internal $__ / _doc state and preserves the API shape.
    return JSON.parse(JSON.stringify(payload));
  } catch (error) {
    console.error('[R2 References] Failed to serialize response payload:', error);
    return payload;
  }
};

export const hydrateR2ResponseReferences = (_req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (payload) => {
    const plainPayload = toPlainJson(payload);
    return originalJson(hydrateR2References(plainPayload));
  };

  next();
};
