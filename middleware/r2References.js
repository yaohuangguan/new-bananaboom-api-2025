import { hydrateR2References, normalizeR2References } from '../utils/r2Reference.js';

export const normalizeR2RequestReferences = (req, _res, next) => {
  if (
    req.body &&
    typeof req.body === 'object' &&
    !Buffer.isBuffer(req.body)
  ) {
    req.body = normalizeR2References(req.body);
  }

  next();
};

export const hydrateR2ResponseReferences = (_req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (payload) => originalJson(hydrateR2References(payload));
  next();
};
