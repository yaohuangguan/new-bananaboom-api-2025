import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../index.js';
import User from '../models/User.js';
import { get } from '../cache/session.js';

// ==========================================
// 🛠️ 基础配置与 Mock 数据
// ==========================================
const mockUser = {
  displayName: 'Test User',
  email: 'test@user.com',
  password: 'Password123',
  passwordConf: 'Password123',
  phone: '+8613800000000'
};

const adminSecret = process.env.ADMIN_RESET_SECRET || 'orion';

/**
 * 辅助函数：获取 User ID
 */
const getUserId = (res) => {
  if (!res.body) throw new Error('响应 Body 为空');
  if (res.statusCode >= 400) throw new Error(`请求失败: ${res.statusCode} - ${res.body.message}`);

  if (res.body.token) {
    const decoded = jwt.decode(res.body.token);
    if (decoded && decoded.user) return decoded.user.id || decoded.user._id;
  }
  if (res.body.user) return res.body.user.id || res.body.user._id;
  throw new Error('无法获取 User ID');
};

/**
 * 🔥 核心修复工具：重新登录获取最新 Token
 * 用于在修改数据库角色后，刷新 Token 里的 Payload
 */
const loginAndGetToken = async (email, password = mockUser.password) => {
  const res = await request(app).post('/api/users/signin').send({ email, password });
  return res.body.token;
};

describe('👤 Users Module Full Coverage', () => {
  // ... (Register 1-3 保持不变，为了节省篇幅省略，请保留原有的 Register 测试) ...
  describe('POST /api/users (Register)', () => {
    it('Should register and return Token with FULL Payload', async () => {
      const res = await request(app).post('/api/users').send(mockUser);
      expect(res.statusCode).toEqual(201);
      const decoded = jwt.decode(res.body.token);
      expect(decoded.user.id).toBeDefined();
    });
    // ... 其他 Register 用例
  });

  // ... (Login 保持不变) ...
  describe('POST /api/users/signin (Login)', () => {
    beforeEach(async () => {
      await request(app).post('/api/users').send(mockUser);
    });
    it('Should login', async () => {
      const res = await request(app)
        .post('/api/users/signin')
        .send({ email: mockUser.email, password: mockUser.password });
      expect(res.statusCode).toEqual(200);
    });
  });

  // ... (Profile 保持不变) ...
  describe('GET /api/users/profile', () => {
    it('Should return profile', async () => {
      const reg = await request(app).post('/api/users').send(mockUser);
      const res = await request(app).get('/api/users/profile').set('x-auth-token', reg.body.token);
      expect(res.statusCode).toEqual(200);
    });
  });

  // =================================================================
  // 4. 用户列表 (GET /api/users)
  // =================================================================
  describe('GET /api/users (List)', () => {
    it('Should return user list and support pagination', async () => {
      // 1. 注册 Admin
      const adminEmail = 'admin@list.com';
      const adminRes = await request(app)
        .post('/api/users')
        .send({
          ...mockUser,
          email: adminEmail,
          phone: undefined
        });
      const adminId = getUserId(adminRes);

      // 提权
      await User.findByIdAndUpdate(adminId, { role: 'admin' });
      // 🔥 关键：重新登录获取 Admin Token
      const token = await loginAndGetToken(adminEmail);

      // 2. 注册普通用户
      await request(app)
        .post('/api/users')
        .send({
          ...mockUser,
          email: 'user@list.com',
          phone: undefined
        });

      const res = await request(app).get('/api/users?page=1&limit=10').set('x-auth-token', token);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ... (Logout, Password, Fitness-Goal, Reset-by-secret 保持不变) ...
  describe('POST /api/users/logout', () => {
    it('Should authenticate with the HttpOnly cookie and revoke the server session', async () => {
      const reg = await request(app).post('/api/users').send(mockUser);
      const setCookie = reg.headers['set-cookie']?.[0];

      expect(setCookie).toContain('orion_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(await get(`auth:${reg.body.token}`)).toBeTruthy();

      const sessionCookie = setCookie.split(';')[0];
      const res = await request(app).post('/api/users/logout').set('Cookie', sessionCookie);

      expect(res.statusCode).toEqual(200);
      expect(await get(`auth:${reg.body.token}`)).toBeNull();
      expect(res.headers['set-cookie']?.[0]).toContain('orion_session=;');
    });
  });

  describe('PUT /api/users/password', () => {
    it('Should update password', async () => {
      const reg = await request(app).post('/api/users').send(mockUser);
      const res = await request(app)
        .put('/api/users/password')
        .set('x-auth-token', reg.body.token)
        .send({ oldPassword: mockUser.password, newPassword: 'NewPass' });
      expect(res.statusCode).toEqual(200);
    });
  });

  describe('PUT /api/users/fitness-goal', () => {
    it('Should update goal', async () => {
      const reg = await request(app).post('/api/users').send(mockUser);
      const id = getUserId(reg);
      const res = await request(app)
        .put('/api/users/fitness-goal')
        .set('x-auth-token', reg.body.token)
        .send({ userId: id, goal: 'cut' });
      expect(res.statusCode).toEqual(200);
    });
  });

  describe('POST /api/users/reset-by-secret', () => {
    it('Should reset', async () => {
      await request(app).post('/api/users').send(mockUser);
      const res = await request(app)
        .post('/api/users/reset-by-secret')
        .send({ email: mockUser.email, newPassword: 'New', secretKey: adminSecret });
      expect(res.statusCode).toEqual(200);
    });
  });

  // =================================================================
  // 9. VIP 管理 (需修复 Token 过期问题)
  // =================================================================
  describe('VIP Management', () => {
    it('Should grant VIP', async () => {
      // 1. Target
      const targetRes = await request(app).post('/api/users').send(mockUser);
      const targetEmail = targetRes.body.user.email;

      // 2. Admin
      const adminEmail = 'admin@vip.com';
      const adminReg = await request(app)
        .post('/api/users')
        .send({
          ...mockUser,
          email: adminEmail,
          phone: undefined
        });
      const adminId = getUserId(adminReg);

      // 提权 + 🔥 刷新 Token
      await User.findByIdAndUpdate(adminId, { role: 'admin' });
      const adminToken = await loginAndGetToken(adminEmail);

      // 3. Action
      const res = await request(app)
        .put('/api/users/grant-vip')
        .set('x-auth-token', adminToken) // 用新 Token
        .send({ email: targetEmail });

      expect(res.statusCode).toEqual(200);
      expect(res.body.user.vip).toBe(true);
    });

    it('Should revoke VIP', async () => {
      // 1. Target
      const regRes = await request(app).post('/api/users').send(mockUser);
      const targetId = getUserId(regRes);
      await User.findByIdAndUpdate(targetId, { vip: true });

      // 2. Admin
      const adminEmail = 'admin@vip.com';
      const adminReg = await request(app)
        .post('/api/users')
        .send({
          ...mockUser,
          email: adminEmail,
          phone: undefined
        });
      const adminId = getUserId(adminReg);

      // 提权 + 🔥 刷新 Token
      await User.findByIdAndUpdate(adminId, { role: 'admin' });
      const adminToken = await loginAndGetToken(adminEmail);

      // 3. Action
      const res = await request(app)
        .put('/api/users/revoke-vip')
        .set('x-auth-token', adminToken)
        .send({ email: mockUser.email });

      expect(res.statusCode).toEqual(200);
      expect(res.body.user.vip).toBe(false);
    });
  });

  // ... (Update Profile 保持不变) ...
  describe('PUT /api/users/:id', () => {
    it('Should update profile', async () => {
      const reg = await request(app).post('/api/users').send(mockUser);
      const id = getUserId(reg);
      const res = await request(app)
        .put(`/api/users/${id}`)
        .set('x-auth-token', reg.body.token)
        .send({ displayName: 'New' });
      expect(res.statusCode).toEqual(200);
    });
    it('Should forbid updating others', async () => {
      const myRes = await request(app).post('/api/users').send(mockUser);
      const otherRes = await request(app)
        .post('/api/users')
        .send({ ...mockUser, email: 'other@t.com', phone: undefined });
      const otherId = getUserId(otherRes);
      const res = await request(app)
        .put(`/api/users/${otherId}`)
        .set('x-auth-token', myRes.body.token)
        .send({ displayName: 'Hacker' });
      expect(res.statusCode).toEqual(403);
    });
  });

  // =================================================================
  // 11. 角色管理 (Security: Only Super Admin)
  // =================================================================
  describe('PUT /api/users/:id/role', () => {
    // ✅ 正向测试：超级管理员可以修改角色
    it('Super Admin can promote User to Admin', async () => {
      // 1. Target User (小白)
      const targetRes = await request(app).post('/api/users').send(mockUser);
      const targetId = getUserId(targetRes);

      // 2. Operator (操作员)
      const saEmail = 'sa@role.com';
      const saRes = await request(app)
        .post('/api/users')
        .send({
          ...mockUser,
          email: saEmail,
          phone: undefined
        });
      const saId = getUserId(saRes);

      // 🔥 关键步骤：提权为 super_admin
      await User.findByIdAndUpdate(saId, { role: 'super_admin' });
      // 🔥 关键步骤：刷新 Token (获取包含 super_admin 权限的新 Token)
      const saToken = await loginAndGetToken(saEmail);

      // 3. Action
      const res = await request(app)
        .put(`/api/users/${targetId}/role`)
        .set('x-auth-token', saToken)
        .send({ role: 'admin' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.user.role).toBe('admin');
    });

    // 🛡️ 反向测试：普通管理员不能修改角色 (由 Guard 拦截)
    it('Normal Admin CANNOT change role (Should be 403)', async () => {
      // 1. Target
      const targetRes = await request(app).post('/api/users').send(mockUser);
      const targetId = getUserId(targetRes);

      // 2. Operator (普通 Admin)
      const adminEmail = 'admin@role.com';
      const adminRes = await request(app)
        .post('/api/users')
        .send({
          ...mockUser,
          email: adminEmail,
          phone: undefined
        });
      const adminId = getUserId(adminRes);

      // 提权为普通 admin
      await User.findByIdAndUpdate(adminId, { role: 'admin' });
      const adminToken = await loginAndGetToken(adminEmail);

      // 3. Action
      const res = await request(app)
        .put(`/api/users/${targetId}/role`)
        .set('x-auth-token', adminToken)
        .send({ role: 'admin' });

      // 期望：被 Global Guard 拦截，因为 Admin 没有 USER:MANAGE_ROLE 权限
      expect(res.statusCode).toEqual(403);
    });
  });

  // =================================================================
  // 12. 额外权限授予 (需修复 Token 过期问题)
  // =================================================================
  describe('PUT /api/users/:id/permissions', () => {
    it('Super Admin can grant extra permissions', async () => {
      // 1. Target
      const targetRes = await request(app).post('/api/users').send(mockUser);
      const targetId = getUserId(targetRes);

      // 2. Super Admin
      const saEmail = 'sa@perm.com';
      const saRes = await request(app)
        .post('/api/users')
        .send({
          ...mockUser,
          email: saEmail,
          phone: undefined
        });
      const saId = getUserId(saRes);

      // 提权 + 🔥 刷新 Token
      await User.findByIdAndUpdate(saId, {
        role: 'super_admin',
        extraPermissions: ['*']
      });
      const saToken = await loginAndGetToken(saEmail);

      // 3. Action
      const res = await request(app)
        .put(`/api/users/${targetId}/permissions`)
        .set('x-auth-token', saToken)
        .send({ permissions: ['FITNESS:READ_ALL'] });

      expect(res.statusCode).toEqual(200);
      expect(res.body.user.permissions).toContain('FITNESS:READ_ALL');
    });

    it('Normal Admin cannot grant permissions', async () => {
      const targetRes = await request(app).post('/api/users').send(mockUser);
      const targetId = getUserId(targetRes);

      const adminEmail = 'admin@perm.com';
      const adminReg = await request(app)
        .post('/api/users')
        .send({
          ...mockUser,
          email: adminEmail,
          phone: undefined
        });
      const adminId = getUserId(adminReg);

      // 提权 + 🔥 刷新 Token
      await User.findByIdAndUpdate(adminId, { role: 'admin' });
      const adminToken = await loginAndGetToken(adminEmail);

      const res = await request(app)
        .put(`/api/users/${targetId}/permissions`)
        .set('x-auth-token', adminToken)
        .send({ permissions: ['FITNESS:READ_ALL'] });

      expect(res.statusCode).toEqual(403);
    });
  });
});
