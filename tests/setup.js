// tests/setup.js

// 🔥 1. 核心修复：显式引入 Jest 全局变量 (ESM 必须)
import { jest, beforeAll, afterEach, afterAll } from '@jest/globals';

// 设置环境变量
process.env.NODE_ENV = 'test';

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// ==========================================
// 2. Redis Mock
// ==========================================
// 注意：在 import 业务代码之前定义 Mock
jest.mock('../cache/session.js', () => {
  const store = new Map();
  
  // 模拟的方法集合
  const mockClient = {
    get: jest.fn((key) => Promise.resolve(store.get(key) || null)),
    set: jest.fn((key, val) => {
      store.set(key, val);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    connect: jest.fn(),
    disconnect: jest.fn(),
    // 兼容可能存在的 clear 调用
    clear: jest.fn(() => {
      store.clear();
      return Promise.resolve();
    })
  };

  return {
    // 🔥 关键：告诉 Jest 这是一个 ESM 模块，且有一个 default 导出
    __esModule: true,
    default: mockClient
  };
});

// 🔥 Mock 定义完之后，再引入依赖 Mock 的服务
import permissionService from '../services/permissionService.js';
import Permission from '../models/Permission.js';
import Role from '../models/Role.js';

let mongoServer;

// ==========================================
// 3. 数据播种函数 (Seed)
// ==========================================
const seedRBAC = async () => {
  // 1. 创建基础权限
  const perms = ['FITNESS:USE', 'FITNESS:READ_ALL', 'BLOG:INTERACT', 'MENU:USE', '*'];
  for (const key of perms) {
    // 使用 updateOne + upsert 防止重复创建报错
    await Permission.updateOne(
      { key },
      { key, name: key, description: 'Test Perm' },
      { upsert: true }
    );
  }

  // 2. 创建基础角色
  const roles = [
    { name: 'user', permissions: ['FITNESS:USE', 'BLOG:INTERACT'] },
    { name: 'admin', permissions: ['FITNESS:USE', 'BLOG:INTERACT', 'MENU:USE'] },
    { name: 'super_admin', permissions: ['*'] }
  ];

  for (const role of roles) {
    await Role.updateOne(
        { name: role.name }, 
        role, 
        { upsert: true }
    );
  }

  // 3. 刷新服务缓存
  // 确保 permissionService 内部逻辑能处理还没连上真实 Redis 的情况(虽然我们 Mock 了)
  if (permissionService.load) {
      await permissionService.load();
  }
};

// ==========================================
// 4. 生命周期钩子
// ==========================================
beforeAll(async () => {
  // 防止残留连接
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  
  await mongoose.connect(uri);

  // 🔥 核心修复：先播种角色和权限，再跑测试
  await seedRBAC();
});

afterEach(async () => {
  // 🔥 核心修复：只清空业务数据，保留系统数据 (Roles, Permissions)
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    if (key !== 'roles' && key !== 'permissions') {
      await collections[key].deleteMany({});
    }
  }
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});