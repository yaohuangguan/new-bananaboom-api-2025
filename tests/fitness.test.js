import request from 'supertest';
import app from '../index.js';
import User from '../models/User.js';
import Role from '../models/Role.js';

let userToken, userId, userEmail;
let otherToken, otherEmail;

describe('🏋️‍♀️ Fitness Module Tests', () => {
  beforeEach(async () => {
    // 1. 注册主角 (Fit Guy)
    const res = await request(app).post('/api/users').send({
      displayName: 'Fit Guy',
      email: 'fit@gym.com',
      password: 'Password123',
      passwordConf: 'Password123'
    });

    userToken = res.body.token;
    // 🔥🔥🔥 核心修复：使用 ._id 而不是 .id
    userId = res.body.user._id;
    userEmail = res.body.user.email;

    // 2. 注册配角 (Other Guy)
    const resOther = await request(app).post('/api/users').send({
      displayName: 'Other Guy',
      email: 'other@gym.com',
      password: 'Password123',
      passwordConf: 'Password123'
    });

    otherToken = resOther.body.token;
    // 🔥🔥🔥 核心修复：使用 ._id 而不是 .id
    otherEmail = resOther.body.user.email;
  });

  // ==========================================
  // 1. 创建记录 (Height Auto-fill)
  // ==========================================
  it('POST /api/fitness - Should auto-fill height from user profile', async () => {
    // 1. 确保 userId 存在再操作
    if (!userId) throw new Error('User ID setup failed!');

    // 2. 给主角设定身高
    await User.findByIdAndUpdate(userId, {
      height: 180
    });

    // 3. 发请求 (不传 height)
    const res = await request(app)
      .post('/api/fitness')
      .set('x-auth-token', userToken)
      .send({
        date: new Date().toISOString(),
        body: {
          weight: 75
        }
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.body.weight).toBe(75);
    expect(res.body.body.height).toBe(180); // 应该自动补全
  });

  // ==========================================
  // 2. 查看列表 (Permissions)
  // ==========================================
  it('GET /api/fitness - Should see own records', async () => {
    // 先创建一条
    await request(app).post('/api/fitness').set('x-auth-token', userToken).send({
      date: new Date().toISOString()
    });

    const res = await request(app).get('/api/fitness').set('x-auth-token', userToken);

    expect(res.statusCode).toEqual(200);
    expect(res.body.length).toBeGreaterThan(0);
    // 验证返回的 User ID 是否匹配
    expect(res.body[0].user._id).toEqual(userId);
  });

  it('GET /api/fitness - Should NOT see others records (Normal User)', async () => {
    const res = await request(app).get(`/api/fitness?email=${otherEmail}`).set('x-auth-token', userToken);

    expect(res.statusCode).toEqual(403);
    expect(res.body.msg).toMatch(/权限不足/);
  });

  it('GET /api/fitness - Super Admin CAN see others records', async () => {
    // 1. 动态提权 (修改数据库)
    await User.findByIdAndUpdate(userId, {
      role: 'super_admin'
    });

    // 2. 🔥🔥🔥 核心修复：重新登录以刷新 Token
    // 旧的 userToken 里写死了 role: 'user'，必须重新签发
    const loginRes = await request(app).post('/api/users/signin').send({
      email: userEmail, // 使用 beforeEach 里保存的邮箱
      password: 'Password123' // 注册时用的密码
    });

    // 拿到印着 "super_admin" 的新身份证
    const superAdminToken = loginRes.body.token;

    // 3. 使用新 Token 发请求
    const res = await request(app).get(`/api/fitness?email=${otherEmail}`).set('x-auth-token', superAdminToken); // 👈 关键：用新 Token

    expect(res.statusCode).toEqual(200);
  });

  // ==========================================
  // 3. 删除记录
  // ==========================================
  it('DELETE /api/fitness/:id - Should delete own record', async () => {
    // 1. 创建记录
    const createRes = await request(app).post('/api/fitness').set('x-auth-token', userToken).send({
      date: new Date().toISOString()
    });
    const recordId = createRes.body._id;

    // 2. 删除
    const delRes = await request(app).delete(`/api/fitness/${recordId}`).set('x-auth-token', userToken);

    expect(delRes.statusCode).toEqual(200);
    expect(delRes.body.msg).toBe('Record removed');
  });

  // ==========================================
  // 4. 🔥 专门测试 Global Guard (门卫拦截)
  // ==========================================
  it('Guard Test: User WITHOUT "FITNESS:USE" permission should be blocked globally', async () => {
    // 1. 在数据库造一个 "废柴角色" (No Permissions)
    await Role.create({
      name: 'banned_role',
      permissions: [] // 🔥 空权限
    });

    // 2. 注册一个倒霉蛋，并分配这个废柴角色
    // (注意：这里我们直接操作数据库改角色，因为注册接口默认给 'user' 角色)
    const res = await request(app).post('/api/users').send({
      displayName: 'No Perm Guy',
      email: 'noperm@test.com',
      password: 'Password123',
      passwordConf: 'Password123'
    });
    const token = res.body.token;
    const userId = res.body.user._id;

    // 修改角色为无权限角色
    await User.findByIdAndUpdate(userId, {
      role: 'banned_role'
    });

    // 3. 重新登录刷新 Token (让 Token 里的 role 变成 banned_role)
    const loginRes = await request(app).post('/api/users/signin').send({
      email: 'noperm@test.com',
      password: 'Password123'
    });
    const newToken = loginRes.body.token;

    const accessRes = await request(app).get('/api/fitness').set('x-auth-token', newToken);

    expect(accessRes.statusCode).toEqual(403);

    // 🔥 修正：匹配 message 字段，而不是 msg
    expect(accessRes.body.message || accessRes.body.message_cn).toMatch(/Access Denied|权限不足/i);
    expect(accessRes.body.required).toMatch(/FITNESS:USE/i);
  });

  // ==========================================
  // 5. 🔥 查看图片墙 (Photos Gallery)
  // ==========================================
  it('GET /api/fitness/photos - Regular User should only see own photos', async () => {
    // 1. 创建全新的独立用户，防止 beforeEach 污染或冲突
    const resU1 = await request(app).post('/api/users').send({
      displayName: 'PhotoUser1',
      email: 'p1@test.com',
      password: 'Password123',
      passwordConf: 'Password123'
    });
    const token1 = resU1.body.token;

    const resU2 = await request(app).post('/api/users').send({
      displayName: 'PhotoUser2',
      email: 'p2@test.com',
      password: 'Password123',
      passwordConf: 'Password123'
    });
    const token2 = resU2.body.token;

    // 2. 给 U1 造一条带图记录
    await request(app).post('/api/fitness').set('x-auth-token', token1).send({
      date: new Date().toISOString(),
      photos: ['http://img.com/my_abs.jpg']
    });

    // 3. 给 U2 造一条带图记录
    await request(app).post('/api/fitness').set('x-auth-token', token2).send({
      date: new Date().toISOString(),
      photos: ['http://img.com/others_abs.jpg']
    });

    // 4. U1 查 -> 只能看自己
    const res = await request(app).get('/api/fitness/photos').set('x-auth-token', token1);

    expect(res.statusCode).toEqual(200);
    const allPhotos = res.body.flatMap((r) => r.photos);
    expect(allPhotos).toContain('http://img.com/my_abs.jpg');
    expect(allPhotos).not.toContain('http://img.com/others_abs.jpg');
  });

  it('GET /api/fitness/photos - Super Admin should see ALL photos', async () => {
    // 1. 创建 Admin 用户
    const resAdmin = await request(app).post('/api/users').send({
      displayName: 'PhotoAdmin',
      email: 'admin@test.com',
      password: 'Password123',
      passwordConf: 'Password123'
    });
    const adminId = resAdmin.body.user._id;

    // 提权
    await User.findByIdAndUpdate(adminId, { role: 'super_admin' });

    // 重新登录拿 Token
    const loginRes = await request(app).post('/api/users/signin').send({
      email: 'admin@test.com',
      password: 'Password123'
    });
    const adminToken = loginRes.body.token;

    // 2. 还需要制造一些普通用户数据 (或者复用数据库里已有的? 最好新建确保存在)
    // 创建一个受害者
    const resVictim = await request(app).post('/api/users').send({
      displayName: 'Victim',
      email: 'victim@test.com',
      password: 'Password123',
      passwordConf: 'Password123'
    });
    await request(app).post('/api/fitness').set('x-auth-token', resVictim.body.token).send({
      date: new Date().toISOString(),
      photos: ['http://img.com/victim_abs.jpg']
    });

    // 3. Admin 查 -> 应该看到所有 (包括 Victim 的)
    const res = await request(app).get('/api/fitness/photos').set('x-auth-token', adminToken);

    expect(res.statusCode).toEqual(200);
    const allPhotos = res.body.flatMap((r) => r.photos);
    expect(allPhotos).toContain('http://img.com/victim_abs.jpg');
  });

  it('GET /api/fitness/photos - Should filter by date range', async () => {
    // 1. 创建用户
    const resUser = await request(app).post('/api/users').send({
      displayName: 'DateUser',
      email: 'date@test.com',
      password: 'Password123',
      passwordConf: 'Password123'
    });
    const token = resUser.body.token;

    // 2. 造数据：昨天 (不在范围内)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await request(app).post('/api/fitness').set('x-auth-token', token).send({
      date: yesterday.toISOString(),
      photos: ['http://img.com/yesterday.jpg']
    });

    // 3. 造数据：上个月 (在范围内)
    // 假设查询范围是 [30天前, 今天] ??
    // 等等，测试逻辑应该是：
    // 造一个 2023-01-01 -> 'http://img.com/old.jpg'
    // 造一个 2023-02-01 -> 'http://img.com/newer.jpg'
    // 查 2023-01-15 ~ 2023-02-15 -> 应该只有 newer.jpg

    const d1 = new Date('2023-01-01');
    await request(app).post('/api/fitness').set('x-auth-token', token).send({
      date: d1.toISOString(),
      photos: ['http://img.com/old.jpg']
    });

    const d2 = new Date('2023-02-01');
    await request(app).post('/api/fitness').set('x-auth-token', token).send({
      date: d2.toISOString(),
      photos: ['http://img.com/newer.jpg']
    });

    // 4. 发起查询 (只查2月份)
    const res = await request(app)
      .get('/api/fitness/photos?start=2023-01-15&end=2023-02-15')
      .set('x-auth-token', token);

    expect(res.statusCode).toEqual(200);
    const allPhotos = res.body.flatMap((r) => r.photos);

    expect(allPhotos).toContain('http://img.com/newer.jpg');
    expect(allPhotos).not.toContain('http://img.com/old.jpg');
  });
});
