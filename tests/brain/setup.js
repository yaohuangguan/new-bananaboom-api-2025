import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
let mongo, objectDirectory;
beforeAll(async () => {
  objectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-brain-tests-'));
  process.env.BRAIN_STORAGE_ROOT = objectDirectory;
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  globalThis.__brainTestUri = mongo.getUri('brain_synthetic_test');
  await mongoose.connect(globalThis.__brainTestUri);
}, 120000);
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  await fs.rm(objectDirectory, { recursive: true, force: true });
  delete process.env.BRAIN_STORAGE_ROOT;
});
