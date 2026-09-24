import { timingSafeEqual } from 'crypto';

const EXEMPT_PATHS = new Set([
  '/api/payments/webhook',
  '/api/cron/trigger'
]);

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export default function originEdgeGuard(req, res, next) {
  const expected = process.env.ORION_EDGE_SECRET;

  // Disabled until the production secret is explicitly configured.
  if (!expected) return next();

  if (EXEMPT_PATHS.has(req.path)) return next();

  const supplied = req.get('x-orion-edge-secret');
  if (!safeEqual(supplied, expected)) {
    return res.status(403).json({ msg: 'Direct origin access is not allowed' });
  }

  next();
}
