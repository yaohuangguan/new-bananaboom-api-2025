import { createHash } from 'node:crypto';
import { seal, unseal, encrypted } from '../../../tools/brain-vault/crypto.mjs';

const MAX_SYNC_ORIGINAL_BYTES = 128 * 1024;
const MAX_SYNC_ENCRYPTED_BYTES = MAX_SYNC_ORIGINAL_BYTES + 52;
const CANONICAL_KEY = /^[a-f0-9]{24}\/[a-f0-9]{64}$/;
const hex = bytes => createHash('sha256').update(bytes).digest('hex');

export class BrainStorageFailure extends Error {
  constructor(code = 'PRIVATE_STORAGE_NOT_CONFIGURED') {
    super(code);
    this.name = 'BrainStorageFailure';
    this.status = 503;
  }
}

function validConfig(bucket, key) {
  if (!bucket || typeof bucket.put !== 'function' ||
      typeof bucket.get !== 'function' ||
      typeof key !== 'string' || key.length < 32 || key.length > 1024) {
    throw new BrainStorageFailure();
  }
}

async function checkedPrivateBlob(bucket, key, path, expectedHash) {
  const object=await bucket.get(path);
  if (!object) return null;
  if (object.size > MAX_SYNC_ENCRYPTED_BYTES) {
    throw new BrainStorageFailure('PRIVATE_OBJECT_CORRUPT');
  }
  const ciphertext=Buffer.from(await object.arrayBuffer());
  if (!encrypted(ciphertext) ||
      ciphertext.length < 52 ||
      ciphertext.length > MAX_SYNC_ENCRYPTED_BYTES) {
    throw new BrainStorageFailure('PRIVATE_OBJECT_CORRUPT');
  }
  let plaintext;
  try {
    plaintext=await unseal(ciphertext,key);
  } catch {
    throw new BrainStorageFailure('PRIVATE_OBJECT_CORRUPT');
  }
  if (hex(plaintext)!==expectedHash) {
    throw new BrainStorageFailure('PRIVATE_OBJECT_CORRUPT');
  }
  return plaintext;
}

/**
 * The exact existing private-object key and ORIONV1 ciphertext envelope.
 * Shares implementation with historical Express; no new crypto format.
 *
 * Call ONLY from a MongoDBConnection DO with private R2 binding and secret;
 * do not accept the bucket, passphrase, owner, or destination from HTTP.
 * A failed Mongo transaction can leave an immutable orphan, like legacy.
 */
export async function putBrainPrivateObject({bucket,secret}, ownerId, plain) {
  validConfig(bucket,secret);
  if (!/^[a-f0-9]{24}$/i.test(String(ownerId)) ||
      !Buffer.isBuffer(plain) ||
      plain.length < 1 ||
      plain.length > MAX_SYNC_ORIGINAL_BYTES) {
    throw new BrainStorageFailure('PRIVATE_OBJECT_SIZE_OR_OWNER');
  }
  const digest=hex(plain);
  const objectPath=String(ownerId)+'/'+digest;
  if (!CANONICAL_KEY.test(objectPath)) {
    throw new BrainStorageFailure('PRIVATE_OBJECT_KEY_INVALID');
  }
  // Key is content-addressed. A retry must never replace an existing blob.
  const existing=await checkedPrivateBlob(bucket,secret,objectPath,digest);
  if (existing) {
    if (!existing.equals(plain)) throw new BrainStorageFailure('PRIVATE_OBJECT_CORRUPT');
    return objectPath;
  }
  const ciphertext=await seal(plain,secret);
  if (ciphertext.length > MAX_SYNC_ENCRYPTED_BYTES || !encrypted(ciphertext)) {
    throw new BrainStorageFailure('PRIVATE_OBJECT_ENCRYPT_FAILED');
  }
  // Object keys cannot be chosen by the client: only owner+SHA256 of bytes.
  // Identical concurrent retries produce equivalent plaintext, even if
  // random IV and salt differ; no valid hash collision is assumed.
  await bucket.put(objectPath,ciphertext,{
    httpMetadata:{contentType:'application/octet-stream'}
  });
  const stored=await checkedPrivateBlob(bucket,secret,objectPath,digest);
  if (!stored || !stored.equals(plain)) throw new BrainStorageFailure('PRIVATE_OBJECT_VERIFY_FAILED');
  return objectPath;
}

export async function getBrainPrivateObject({bucket,secret}, ownerId, objectPath) {
  validConfig(bucket,secret);
  if (typeof ownerId !== 'string' || !/^[a-f0-9]{24}$/i.test(ownerId) ||
      typeof objectPath !== 'string' || !CANONICAL_KEY.test(objectPath) ||
      !objectPath.startsWith(ownerId+'/')) {
    throw new BrainStorageFailure('PRIVATE_OBJECT_KEY_INVALID');
  }
  const hash=objectPath.split('/')[1];
  const stored=await checkedPrivateBlob(bucket,secret,objectPath,hash);
  if (!stored) throw new BrainStorageFailure('PRIVATE_OBJECT_NOT_FOUND');
  return stored;
}
