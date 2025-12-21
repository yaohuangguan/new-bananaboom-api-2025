const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');
const redis = require('../cache/session');

const app = express();
app.use(express.json());

app.get('/test/middleware', authMiddleware, (req, res) => {
  res.json({ 
    user: req.user,
    isAuthenticated: !!req.user 
  });
});

const SECRET = process.env.SECRET_JWT || "test_jwt_secret";

// 🔥🔥🔥 核心更新：完全匹配你代码里的 Payload 结构
const mockPayload = {
  user: {
    id: "654321000000000000000001",
    displayName: "Test Middleware User",
    name: "Test Middleware User", // ✅ 你的双字段策略
    email: "middleware@test.com",
    phone: "+8613800000000",
    photoURL: "http://avatar.com/1.jpg",
    vip: false,
    role: "admin"
  }
};

describe('🛡️ Auth Middleware Integration Tests', () => {

  it('Should attach full user payload (name & displayName) to req.user', async () => {
    const token = jwt.sign(mockPayload, SECRET, { expiresIn: '1h' });
    await redis.set(token, token);

    const res = await request(app)
      .get('/test/middleware')
      .set('x-auth-token', token);

    expect(res.statusCode).toEqual(200);

    const user = res.body.user;
    expect(user).toBeTruthy();
    
    // 🔥 验证双字段是否存在
    expect(user.displayName).toBe(mockPayload.user.displayName);
    expect(user.name).toBe(mockPayload.user.name); // ✅ 确保 name 也在
    
    // 验证其他核心字段
    expect(user.email).toBe(mockPayload.user.email);
    expect(user.phone).toBe(mockPayload.user.phone);
    expect(user.role).toBe(mockPayload.user.role);
    expect(user.vip).toBe(false);
    
    // 验证 ID 自动补全
    expect(user.id).toBe(mockPayload.user.id);
    expect(user._id).toBe(mockPayload.user.id);
  });

  // ... (下面的游客模式、过期测试等保持不变)
  it('Should verify Gentle Mode: No token should pass without error', async () => {
    const res = await request(app).get('/test/middleware');
    expect(res.statusCode).toEqual(200);
    expect(res.body.user).toBeUndefined();
  });

  it('Should reject if Token is valid signature but missing in Redis', async () => {
    // 🔥🔥🔥 核心修复：修改 Payload，确保生成一个全新的、Redis里绝对没有的 Token
    const uniquePayload = { 
      ...mockPayload, 
      nonce: Date.now() + Math.random() // 加个随机数改变 Hash
    };
    
    // 生成的新 Token，签名肯定和上一个测试不一样
    const token = jwt.sign(uniquePayload, SECRET, { expiresIn: '1h' });

    // 这一步不需要了，Redis 里肯定没有这个新 Token
    // await redis.set(token, token); 

    const res = await request(app)
      .get('/test/middleware')
      .set('x-auth-token', token);

    // 期望：401 (Session expired)
    expect(res.statusCode).toEqual(401);
    expect(res.body.message).toMatch(/Session expired/);
  });

});