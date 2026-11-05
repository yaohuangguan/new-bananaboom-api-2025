import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { signSessionJwt, verifySessionJwt, jwtRotationMode } from '../utils/jwtKeyring.js';

const legacySecret = 'old-temporary-short-key';
const nextSecret = 'a-new-random-key-for-the-staged-rollout-with-64chars-2026';
const payload = { user: { id: '507f1f77bcf86cd799439011', role: 'admin' } };
const legacyConfig = { NODE_ENV: 'production', SECRET_JWT: legacySecret };
const stagedConfig = { ...legacyConfig, ORION_JWT_NEXT_SECRET: nextSecret };
const activeConfig = { ...stagedConfig, ORION_JWT_SIGNING_MODE: 'v2' };

test('phase 0 signs and verifies old tokens exactly as legacy service', () => {
  const token = signSessionJwt(payload, legacyConfig);
  assert.equal(jwt.decode(token, { complete: true }).header.kid, undefined);
  assert.equal(jwt.verify(token, legacySecret).user.id, payload.user.id);
  assert.equal(verifySessionJwt(token, legacyConfig).user.id, payload.user.id);
});

test('phase 1 loads new key without changing issuance; verifies old tokens', () => {
  const token = signSessionJwt(payload, stagedConfig);
  assert.equal(jwt.decode(token, { complete: true }).header.kid, undefined);
  assert.equal(jwtRotationMode(stagedConfig).nextKeyReady, true);
  assert.equal(verifySessionJwt(token, stagedConfig).user.id, payload.user.id);
});

test('phase 2 issues v2, verifies both generations, and refuses v2 on legacy-only service', () => {
  const oldToken = signSessionJwt(payload, legacyConfig);
  const newToken = signSessionJwt(payload, activeConfig);
  assert.equal(jwt.decode(newToken, { complete: true }).header.kid, 'orion-v2');
  assert.equal(verifySessionJwt(oldToken, activeConfig).user.id, payload.user.id);
  assert.equal(verifySessionJwt(newToken, activeConfig).user.id, payload.user.id);
  assert.throws(() => verifySessionJwt(newToken, legacyConfig), /Unknown JWT signing key/);
});

test('unexpected key ids, unsigned tokens, invalid signature, expired tokens are rejected', () => {
  const forged = jwt.sign(payload, legacySecret, { header: { kid: 'unknown' } });
  const newToken = signSessionJwt(payload, activeConfig);
  const expired = jwt.sign(payload, legacySecret, { expiresIn: -1 });
  assert.throws(() => verifySessionJwt(forged, activeConfig), /Unknown JWT signing key/);
  assert.throws(() => verifySessionJwt(newToken + 'tampered', activeConfig), /invalid signature/);
  assert.throws(() => verifySessionJwt(expired, activeConfig), (error) => error.name === 'TokenExpiredError');
  assert.throws(() => verifySessionJwt('garbage', activeConfig), (error) => error.name === 'JsonWebTokenError');
});

test('invalid deployment configurations fail closed', () => {
  assert.throws(() => signSessionJwt(payload, { NODE_ENV: 'production' }), /Missing legacy/);
  assert.throws(() => signSessionJwt(payload, { ...legacyConfig, ORION_JWT_SIGNING_MODE: 'v2' }), /without next secret/);
  assert.throws(() => signSessionJwt(payload, { ...legacyConfig, ORION_JWT_NEXT_SECRET: 'short' }), /at least 32/);
  assert.throws(() => signSessionJwt(payload, { ...legacyConfig, ORION_JWT_NEXT_SECRET: legacySecret }), /distinct/);
  assert.throws(() => signSessionJwt(payload, { ...legacyConfig, ORION_JWT_SIGNING_MODE: 'typo' }), /Invalid/);
});
