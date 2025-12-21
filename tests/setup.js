// tests/setup.js
const dotenv = require('dotenv');
dotenv.config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const permissionService = require('../services/permissionService');

// 引入模型以便播种数据
const Permission = require('../models/Permission');
const Role = require('../models/Role');

// ==========================================
// 1. Redis Mock (修复：移除 _clear 逻辑，让 Token 持久化)
// ==========================================
jest.mock('../cache/session', () => {
  const store = new Map();
  return {
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
    // 我们不再需要手动 clear，让它随进程结束消亡即可，或者只在 beforeAll 清理
  };
});

let mongoServer;

// ==========================================
// 2. 数据播种函数 (Seed)
// ==========================================
const seedRBAC = async () => {
  // 1. 创建基础权限
  const perms = ['FITNESS:USE', 'FITNESS:READ_ALL', 'BLOG:INTERACT', 'MENU:USE', '*'];
  for (const key of perms) {
    await Permission.create({ key, name: key, description: 'Test Perm' });
  }

  // 2. 创建基础角色
  // 普通用户
  await Role.create({ 
    name: 'user', 
    permissions: ['FITNESS:USE', 'BLOG:INTERACT'] 
  });
  
  // 管理员
  await Role.create({ 
    name: 'admin', 
    permissions: ['FITNESS:USE', 'BLOG:INTERACT', 'MENU:USE'] 
  });

  // 超级管理员
  await Role.create({ 
    name: 'super_admin', 
    permissions: ['*'] 
  });
  
  // 3. 刷新服务缓存
  await permissionService.load();
};

// ==========================================
// 3. 生命周期钩子
// ==========================================
beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
  
  // 🔥 核心修复：先播种角色和权限，再跑测试
  await seedRBAC();
});

afterEach(async () => {
  // 🔥 核心修复：只清空业务数据 (Users, Fitness)，保留系统数据 (Roles, Permissions)
  // 否则下一个测试用例一跑，角色定义没了，权限又会挂
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    if (key !== 'roles' && key !== 'permissions') {
       await collections[key].deleteMany();
    }
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});