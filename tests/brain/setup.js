import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
let mongo;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(mongo.getUri('brain_synthetic_test'));
}, 120000);
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map(c => c.deleteMany({})));
});
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
