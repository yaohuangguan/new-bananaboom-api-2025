import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { seal, unseal } from './crypto.mjs';
import { fail, objectId, sha } from './core.js';
const MAX = 128 * 1024 * 1024;
function config() {
  const driver = process.env.BRAIN_STORAGE_DRIVER || 'local';
  if (driver === 's3') {
    if (!process.env.BRAIN_S3_BUCKET || process.env.BRAIN_S3_BUCKET === process.env.R2_BUCKET_NAME || !process.env.BRAIN_STORAGE_KEY || process.env.BRAIN_STORAGE_KEY.length < 32) fail('PRIVATE_STORAGE_NOT_CONFIGURED', 503);
    return { driver, bucket: process.env.BRAIN_S3_BUCKET, client: new S3Client({
      region: process.env.BRAIN_S3_REGION || 'auto', endpoint: process.env.BRAIN_S3_ENDPOINT,
      forcePathStyle: true, credentials: { accessKeyId: process.env.BRAIN_S3_ACCESS_KEY_ID, secretAccessKey: process.env.BRAIN_S3_SECRET_ACCESS_KEY }
    }) };
  }
  if (driver !== 'local' || !process.env.BRAIN_STORAGE_ROOT || !path.isAbsolute(process.env.BRAIN_STORAGE_ROOT)) fail('PRIVATE_STORAGE_NOT_CONFIGURED', 503);
  if (process.env.NODE_ENV === 'production' && process.env.BRAIN_LOCAL_DURABLE !== '1') fail('DURABLE_STORAGE_REQUIRED', 503);
  return { driver, root: process.env.BRAIN_STORAGE_ROOT };
}
function validKey(ownerId, key) {
  objectId(ownerId);
  if (typeof key !== 'string' || !new RegExp('^' + ownerId + '/[a-f0-9]{64}$').test(key)) fail('INVALID_OBJECT_KEY');
}
async function localDirectory(root, ownerId) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('UNSAFE_STORAGE_ROOT', 503);
  const directory = path.join(root, ownerId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_STORAGE_ROOT', 503);
  return directory;
}
export async function putPrivate(ownerId, bytes) {
  objectId(ownerId);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX) fail('OBJECT_TOO_LARGE', 413);
  const key = ownerId + '/' + sha(bytes), c = config();
  if (c.driver === 's3') {
    await c.client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: await seal(bytes, process.env.BRAIN_STORAGE_KEY), ContentType: 'application/octet-stream' }));
  } else {
    const dir = await localDirectory(c.root, ownerId);
    try {
      const handle = await fs.open(path.join(dir, sha(bytes)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    } catch (e) { if (e.code !== 'EEXIST') throw e; const existing = await getPrivate(ownerId, key); if (sha(existing) !== sha(bytes)) fail('OBJECT_CORRUPT', 500); }
  }
  return key;
}
export async function getPrivate(ownerId, key) {
  validKey(ownerId, key); const c = config(); let bytes;
  if (c.driver === 's3') {
    const result = await c.client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
    if (result.ContentLength > MAX + 52) fail('OBJECT_TOO_LARGE', 413);
    bytes = await unseal(Buffer.from(await result.Body.transformToByteArray()), process.env.BRAIN_STORAGE_KEY);
  } else {
    const dir = await localDirectory(c.root, ownerId);
    const handle = await fs.open(path.join(dir, key.split('/')[1]), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX) fail('OBJECT_TOO_LARGE', 413); bytes = await handle.readFile(); } finally { await handle.close(); }
  }
  if (sha(bytes) !== key.split('/')[1]) fail('OBJECT_CORRUPT', 500);
  return bytes;
}
