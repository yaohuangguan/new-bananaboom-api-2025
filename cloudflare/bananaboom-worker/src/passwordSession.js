import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';

const AUTH_COOKIE_AGE_SECONDS = 30 * 24 * 60 * 60;
const DUMMY_BCRYPT_HASH = '$2b$10$7p6h5PibC6rb5wz1ZbHmZewhdA/tp5DWQ41wCQBtQ3Xzw6PEhrC2O';
const ROLE_NAMES = new Set(['user', 'admin', 'super_admin', 'bot']);
const VALID_ID = /^[a-f0-9]{24}$/i;

export function passwordLoginInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const identifier = input.email;
  const password = input.password;
  if (typeof identifier !== 'string' || typeof password !== 'string' ||
      identifier.length < 1 || identifier.length > 254 ||
      password.length < 1 || password.length > 128) return null;
  const account = identifier.trim();
  if (!account || account.length > 254) return null;
  return { account, password };
}

export function safePasswordPayload(user, permissions) {
  const id = String(user?._id || '');
  if (!VALID_ID.test(id) || !ROLE_NAMES.has(user.role)) {
    throw new Error('Invalid persisted user identity');
  }
  const extraPermissions = Array.isArray(user.extraPermissions) ?
    user.extraPermissions.filter((p) => typeof p === 'string') : [];
  const merged = [...new Set([...permissions, ...extraPermissions])];
  return {
    id, _id:id,
    displayName:user.displayName,
    name:user.displayName,
    email:user.email,
    phone:user.phone || '',
    photoURL:user.photoURL || '',
    vip:user.role === 'super_admin',
    role:user.role,
    extraPermissions,
    permissions:merged
  };
}

export function legacyAuthCookie(token, {clear = false} = {}) {
  const value = clear ? '' : encodeURIComponent(token);
  return 'orion_session=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' +
    (clear ? '0' : AUTH_COOKIE_AGE_SECONDS);
}

export async function signCompatibleJwt(principal, secrets = {}) {
  const legacy = secrets.legacy;
  const next = secrets.next;
  const mode = secrets.mode || 'legacy';
  if (typeof legacy !== 'string' || !legacy || !['legacy','v2'].includes(mode)) {
    throw new Error('Missing or invalid legacy signing configuration');
  }
  if (mode === 'v2' && (typeof next !== 'string' || next.length < 32 || next === legacy)) {
    throw new Error('Next signing secret is missing or unsafe');
  }
  const header = {alg:'HS256'};
  if (mode === 'v2') header.kid = 'orion-v2';
  return new SignJWT({user:principal})
    .setProtectedHeader(header)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode(mode === 'v2' ? next : legacy));
}

/**
 * Runs entirely in MongoDBConnection DO so password hash never crosses RPC.
 * Uses existing collections and legacy session whitelist, not new identity data.
 */
export async function createPasswordSession(db, rawInput, secrets) {
  const input = passwordLoginInput(rawInput);
  if (!input) return {kind:'bad-input'};
  const account = input.account;
  const user = await db.collection('users').findOne({
    $or:[{email:account.toLowerCase()}, {phone:account}]
  }, {
    projection:{
      _id:1,password:1,displayName:1,email:1,phone:1,photoURL:1,
      role:1,extraPermissions:1
    }
  });
  const passwordHash = typeof user?.password === 'string' ?
    user.password : DUMMY_BCRYPT_HASH;
  // Compare even unknown accounts: do not reveal which identifiers exist.
  const matched = await bcrypt.compare(input.password, passwordHash);
  if (!matched || !user) return {kind:'invalid-credentials'};
  const role = await db.collection('roles').findOne({name:user.role},{
    projection:{permissions:1}
  });
  const principal = safePasswordPayload(user,
    Array.isArray(role?.permissions) ? role.permissions : []);
  const token = await signCompatibleJwt(principal, secrets);
  await db.collection('sessions').insertOne({
    key:'auth:' + token,
    value:principal.id,
    createdAt:new Date()
  });
  return {kind:'success',token,user:principal};
}

export async function revokePasswordSession(db, token) {
  if (typeof token !== 'string' || !token || token.length > 4096) return;
  await db.collection('sessions').deleteOne({key:'auth:' + token});
}
