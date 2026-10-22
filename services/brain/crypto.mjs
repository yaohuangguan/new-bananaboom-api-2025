// Portable, dependency-free encrypted envelope v1. No Orion or cloud dependency.
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const MAGIC = Buffer.from('ORIONV1\n');
export const encrypted = bytes => bytes.subarray(0, 8).equals(MAGIC);
export async function seal(bytes, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new Error('PASSPHRASE_MIN_12_MAX_1024');
  const salt = randomBytes(16), iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const key = await derive(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
  try { return Buffer.concat([header, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); } finally { key.fill(0); }
}
export async function unseal(bytes, passphrase) {
  if (!encrypted(bytes)) return bytes;
  if (bytes.length < 52 || typeof passphrase !== 'string' || passphrase.length > 1024) throw new Error('DECRYPT_FAILED');
  const key = await derive(passphrase, bytes.subarray(8, 24), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(24, 36)); decipher.setAAD(bytes.subarray(0, 36)); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(36, -16)), decipher.final()]);
  } catch { throw new Error('DECRYPT_FAILED'); } finally { key.fill(0); }
}
