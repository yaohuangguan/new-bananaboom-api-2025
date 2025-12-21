const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');
const cache = require('../cache/session'); // 确保指向你的 MongoDB Session 包装器
const permissionService = require('../services/permissionService');

const app = express();
app.use(express.json());

// 模拟受保护路由
app.get('/test/middleware', authMiddleware, (req, res) => {
  res.json({ 
    user: req.user,
    isAuthenticated: !!req.user 
  });
});

const SECRET = process.env.SECRET_JWT || "test_jwt_secret";

// 🏆 你的核心需求：验证这个 Payload 结构在经过中间件后依然完整
const mockUserId = "654321000000000000000001";
const mockPayload = {
  user: {
    id: mockUserId,
    displayName: "Banana Boom", // 主字段
    name: "Banana Boom",        // 兼容字段
    email: "test@banana.com",
    role: "admin"
  }
};

describe('🛡️ Auth Middleware - Payload Integrity Tests', () => {

  it('Should ensure user object ALWAYS has both name & displayName', async () => {
    // 1. 签发 Token
    const token = jwt.sign(mockPayload, SECRET, { expiresIn: '1h' });

    // 🔥 修正点 1：必须带 auth: 前缀
    // 🔥 修正点 2：Value 必须是 ID
    await cache.set(`auth:${token}`, mockUserId);

    // 💡 修正点 3：Mock 掉 Service 的实时补全方法，确保它返回你想要的双字段对象
    // 这样我们就不需要真的去查数据库，也能验证中间件的挂载逻辑
    const buildSpy = jest.spyOn(permissionService, 'getLiveUserPayload').mockImplementation(async (id) => {
      // 这里模拟 permissionService.buildUserPayload 处理后的结果
      return {
        id: id,
        _id: id,
        displayName: "Banana Boom",
        name: "Banana Boom", 
        email: "test@banana.com",
        role: "admin",
        permissions: ["*"]
      };
    });

    const res = await request(app)
      .get('/test/middleware')
      .set('x-auth-token', token);

    // 断言 1：认证必须通过
    expect(res.statusCode).toEqual(200);

    const user = res.body.user;
    expect(user).toBeTruthy();
    
    // 🔥 断言 2：核心需求验证 - 两个字段必须同时存在且正确
    expect(user.displayName).toBe("Banana Boom");
    expect(user.name).toBe("Banana Boom"); 
    
    expect(user.id).toBe(mockUserId);
    
    // 清理 Mock
    buildSpy.mockRestore();
  });

  it('Should reject expired or deleted sessions with 401', async () => {
    const token = jwt.sign(mockPayload, SECRET, { expiresIn: '1h' });
    
    // 故意不 setToken
    const res = await request(app)
      .get('/test/middleware')
      .set('x-auth-token', token);

    expect(res.statusCode).toEqual(401);
    expect(res.body.message || res.body.message_cn).toMatch(/Session expired|登录已失效/i);
  });
});