import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { jest } from '@jest/globals';
import Role from '../models/Role.js';
import permissionService from '../services/permissionService.js';
import cache from '../cache/memoryCache.js';
import K from '../config/permissionKeys.js';

let mongo;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120000);

beforeEach(async () => {
  jest.restoreAllMocks();
  cache.flushAll();
  await Promise.all(Object.values(mongoose.connection.collections).map(collection => collection.deleteMany({})));
  await Role.create([
    { name: 'user', permissions: [K.USER_UPDATE, K.FITNESS_USE, K.BLOG_INTERACT] },
    { name: 'admin', permissions: [K.USER_UPDATE, K.FITNESS_USE, K.FITNESS_READ_ALL, K.FITNESS_EDIT_ALL] },
    { name: 'super_admin', permissions: ['*'] }
  ]);
  await permissionService.reload();
});

afterAll(async () => {
  jest.restoreAllMocks();
  cache.close();
  await mongoose.disconnect();
  await mongo?.stop();
});
