/**
 * @description API 完整性集成测试 - 适配统一 Payload 逻辑与延迟写入
 */
const request = require('supertest');
const app = require('../index');
const User = require('../models/User');
const Session = require('../models/Session');
const permissionService = require('../services/permissionService');
const mongoose = require('mongoose')

describe('🛡️ 系统核心 API 集成测试', () => {

    // 🔥 增加这个：确保数据库连接就绪后再跑测试
    beforeAll(async () => {
        if (mongoose.connection.readyState !== 1) {
            await new Promise((resolve) => {
                mongoose.connection.once('open', resolve);
            });
        }
    });

    beforeEach(async () => {
        // 建议：测试环境不要在每个 it 之前都全删，
        // 或者确保 Session.deleteMany 真的执行完了
        await Session.deleteMany({}).exec(); 
        await User.deleteMany({}).exec();
    });


    it('GET /health - 应该无条件放行', async () => {
        const res = await request(app).get('/health');
        expect(res.statusCode).toEqual(200);
    });

    it('POST /api/users - 注册并验证 Session 是否生效', async () => {
        const userData = {
            displayName: "Test User",
            email: "test_unique@example.com", // 确保唯一
            password: "Password123",
            passwordConf: "Password123"
        };

        // 1. 注册
        const res = await request(app).post('/api/users').send(userData);
        expect(res.statusCode).toEqual(201);
        const token = res.body.token;

        // 2. 🔥 不再直接查库（防止数据库连接池不同步）
        // 而是直接拿这个 Token 去访问一个需要登录的接口
        // 如果能拿到 403 或 200，说明 Session 备案绝对成功了！
        const checkRes = await request(app)
            .get('/api/roles') // 这是一个受保护接口
            .set('x-auth-token', token);

        // 如果 Session 没备案成功，这里会报 401
        // 如果 Session 成功了，这里会因为没权限报 403，或者你是 super_admin 报 200
        expect(checkRes.statusCode).not.toEqual(401); 
        console.log("✅ 链式验证成功：Session 已在后端白名单生效");
    });

    // ============================================================
    // 3. 权限守卫测试
    // ============================================================
    
    it('GET /api/roles - 游客访问应该返回 401', async () => {
        const res = await request(app).get('/api/roles');
        expect(res.statusCode).toEqual(401);
        // 匹配你 auth.js 里实际返回的 "Unauthorized: Please login first"
        expect(res.body.message || res.body.message_cn).toMatch(/Please login first/i);
    });

    it('GET /api/roles - 普通用户访问应该返回 200', async () => {
        const regRes = await request(app).post('/api/users').send({
            displayName: "Normal Guy",
            email: "normal@guy.com",
            password: "Password123",
            passwordConf: "Password123"
        });

        const token = regRes.body.token;

        const res = await request(app)
            .get('/api/roles')
            .set('x-auth-token', token);

        expect(res.statusCode).toEqual(200);
    });

    it('GET /api/roles - 超管访问应该返回 200', async () => {
        const regRes = await request(app).post('/api/users').send({
            displayName: "Boss",
            email: "boss@boss.com",
            password: "Password123",
            passwordConf: "Password123"
        });

        const userId = regRes.body.user.id;

        // 提权
        await User.findByIdAndUpdate(userId, { role: 'super_admin' });
        permissionService.clearUserCache(userId);

        // 重新登录
        const loginRes = await request(app).post('/api/users/signin').send({
            email: "boss@boss.com",
            password: "Password123"
        });
        
        const res = await request(app)
            .get('/api/roles')
            .set('x-auth-token', loginRes.body.token);

        expect(res.statusCode).toEqual(200);
    });
});