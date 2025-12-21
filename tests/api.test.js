const request = require('supertest');
const app = require('../index'); // 引入你的 Express app
const User = require('../models/User'); // 引入模型以便验证数据

describe('API Integration Tests', () => {

  // ==========================================
  // 1. 基础健康检查
  // ==========================================
  it('GET /health should return 200 OK', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toEqual(200);
    expect(res.text).toEqual('OK');
  });

  // ==========================================
  // 2. 注册与登录测试
  // ==========================================
  it('POST /api/users should register a new user', async () => {
    const userData = {
      displayName: "Test User",
      email: "test@example.com",
      password: "Password123",
      passwordConf: "Password123"
    };

    const res = await request(app)
      .post('/api/users')
      .send(userData);

    // 期望返回 201 Created
    expect(res.statusCode).toEqual(201);
    // 期望返回 Token
    expect(res.body).toHaveProperty('token');
    // 期望 DB 里真的有这个人
    const user = await User.findOne({ email: "test@example.com" });
    expect(user).toBeTruthy();
    expect(user.displayName).toBe("Test User");
  });

  // ==========================================
  // 3. 权限守卫测试 (Global Guard)
  // ==========================================
  it('GET /api/roles should be blocked for public users', async () => {
    // 尝试不带 Token 访问需要 Super Admin 权限的接口
    const res = await request(app).get('/api/roles');
    
    // 期望 401 Unauthorized (因为没有登录)
    // 注意：你的 Guard 逻辑如果是 "Public 放行，其他先查登录"，这里应该是 401
    expect(res.statusCode).toEqual(401);
  });

  it('GET /api/roles should be blocked for normal users', async () => {
    // 1. 先注册一个普通用户
    const registerRes = await request(app).post('/api/users').send({
        displayName: "Normal Guy",
        email: "normal@guy.com",
        password: "Password123",
        passwordConf: "Password123"
    });
    const token = registerRes.body.token;

    // 2. 用普通用户的 Token 去访问 Super Admin 接口
    const res = await request(app)
      .get('/api/roles')
      .set('x-auth-token', token); // 或者 .set('Authorization', `Bearer ${token}`)

    // 期望 403 Forbidden (登录了，但权限不足)
    expect(res.statusCode).toEqual(403);
  });
  
});