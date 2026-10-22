import yauzl from 'yauzl';
import yazl from 'yazl';
import { fail } from './core.js';
export const ZIP_LIMITS = { bytes: 100 * 1024 * 1024, entryBytes: 32 * 1024 * 1024, entries: 2000, ratio: 200 };
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function safeName(name) {
  if (
    typeof name !== 'string' ||
    name.length > 512 ||
    /[\\:]/.test(name) ||
    Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    name.startsWith('/') ||
    name.split('/').some((p) => p === '..' || p === '.')
  )
    fail('UNSAFE_ARCHIVE_PATH');
  return name;
}
export async function readZip(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(Object.assign(new Error('INVALID_ZIP'), { status: 400 }));
      const files = new Map();
      let total = 0,
        count = 0,
        settled = false;
      const stop = (e) => {
        if (!settled) {
          settled = true;
          zip.close();
          reject(e.status ? e : Object.assign(new Error('INVALID_ZIP'), { status: 400 }));
        }
      };
      zip.on('error', stop);
      zip.on('entry', (entry) => {
        try {
          safeName(entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode === 0xa000 || entry.generalPurposeBitFlag & 1) fail('UNSUPPORTED_ZIP_ENTRY');
          if (
            ++count > ZIP_LIMITS.entries ||
            entry.uncompressedSize > ZIP_LIMITS.entryBytes ||
            total + entry.uncompressedSize > ZIP_LIMITS.bytes ||
            entry.uncompressedSize / Math.max(1, entry.compressedSize) > ZIP_LIMITS.ratio
          )
            fail('ZIP_QUOTA_EXCEEDED', 413);
          total += entry.uncompressedSize;
          if (entry.fileName.endsWith('/')) return zip.readEntry();
          if (files.has(entry.fileName)) fail('DUPLICATE_ZIP_PATH');
          zip.openReadStream(entry, (err, stream) => {
            if (err) return stop(err);
            const chunks = [];
            let size = 0;
            stream.on('data', (chunk) => {
              size += chunk.length;
              if (size > entry.uncompressedSize || size > ZIP_LIMITS.entryBytes) {
                stream.destroy();
                stop(Object.assign(new Error('ZIP_QUOTA_EXCEEDED'), { status: 413 }));
              } else chunks.push(chunk);
            });
            stream.on('error', stop);
            stream.on('end', () => {
              const content = Buffer.concat(chunks);
              if (size !== entry.uncompressedSize || crc32(content) !== entry.crc32)
                return stop(Object.assign(new Error('ZIP_CHECKSUM_MISMATCH'), { status: 400 }));
              files.set(entry.fileName, content);
              zip.readEntry();
            });
          });
        } catch (e) {
          stop(e);
        }
      });
      zip.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(files);
        }
      });
      zip.readEntry();
    });
  });
}
export async function makeZip(files) {
  const zip = new yazl.ZipFile();
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    let size = 0;
    zip.outputStream.on('data', (b) => {
      size += b.length;
      if (size > 128 * 1024 * 1024) {
        zip.outputStream.destroy();
        reject(Object.assign(new Error('EXPORT_QUOTA_EXCEEDED'), { status: 413 }));
      } else chunks.push(b);
    });
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.on('error', reject);
  });
  for (const [name, content] of files)
    zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), safeName(name), { compress: false });
  zip.end();
  return done;
}
