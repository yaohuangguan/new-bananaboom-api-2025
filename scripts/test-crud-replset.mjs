/**
 * A REAL MongoDB replica-set transaction test without production credentials.
 * Uses the repository's devDependency mongodb-memory-server; isolated and
 * automatically stopped after the child test runner finishes.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = resolve(root, 'cloudflare/bananaboom-worker');
const replica = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' }
});
try {
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--test', 'tests/articleTransaction.test.mjs'], {
      cwd: worker,
      env: { ...process.env, MONGO_URI: replica.getUri() },
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code) => done(code));
  });
  if (result !== 0) process.exitCode = result || 1;
} finally {
  await replica.stop();
}
