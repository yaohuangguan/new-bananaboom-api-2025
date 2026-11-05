import { createHash, timingSafeEqual } from 'node:crypto';

// Strict, plain-data translation of the legacy Mongoose post write contract.
// This does not grant authorization; the OpenMesh route verifies live RBAC first.
export class PostInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PostInputError';
  }
}

const FIELDS = ['name', 'info', 'author', 'content', 'isPrivate', 'tags', 'url', 'button'];
const REQUIRED = ['name', 'info', 'author'];

export function normalizePostInput(input, { create = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PostInputError('Invalid article payload');
  }
  const result = {};
  for (const key of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value === undefined) continue;
    if (key === 'tags') {
      if (typeof value === 'string') {
        result.tags = value.trim().split(/\s+/).filter(Boolean);
      } else if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
        result.tags = value;
      } else if (value == null) {
        result.tags = [];
      } else {
        throw new PostInputError('Invalid tags');
      }
    } else if (key === 'isPrivate') {
      if (typeof value !== 'boolean') throw new PostInputError('Invalid privacy flag');
      result[key] = value;
    } else {
      if (value != null && typeof value !== 'string') throw new PostInputError('Invalid ' + key);
      result[key] = key === 'name' && typeof value === 'string' ? value.trim() : value;
    }
  }
  for (const key of REQUIRED) {
    if ((create || Object.hasOwn(result, key)) &&
      (typeof result[key] !== 'string' || result[key].trim().length === 0)) {
      throw new PostInputError('Missing or empty ' + key);
    }
  }
  return result;
}

export function redactPostWriteError(error) {
  if (error instanceof PostInputError) {
    return { status: 400, body: { msg: error.message } };
  }
  // Do not return driver, auth, URI or stack internals to callers.
  return { status: 503, body: { error: 'Article operation status unknown. Check the article before retrying.' } };
}


// Compare fixed-length digests; never exit early based on passphrase characters.
export function matchesAdminSecret(expected, supplied) {
  if (typeof expected !== 'string' || expected.length < 16 ||
    typeof supplied !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(supplied));
}
