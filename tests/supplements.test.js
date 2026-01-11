import request from 'supertest';
import app from '../index.js';
import User from '../models/User.js';

let userToken, userId;

describe('💊 Supplement Tracking Tests', () => {
    beforeEach(async () => {
        // 1. 注册主角
        const res = await request(app).post('/api/users').send({
            displayName: 'Supp Guy',
            email: `supp_${Date.now()}@gym.com`,
            password: 'Password123',
            passwordConf: 'Password123'
        });

        userToken = res.body.token;
        userId = res.body.user._id;
    });

    it('POST /api/fitness - Should save supplement data', async () => {
        const res = await request(app)
            .post('/api/fitness')
            .set('x-auth-token', userToken)
            .send({
                date: new Date().toISOString(),
                supplements: {
                    protein: true,
                    vitamins: true,
                    details: 'Chocolate flavor'
                }
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.supplements.protein).toBe(true);
        expect(res.body.supplements.vitamins).toBe(true);
        expect(res.body.supplements.details).toBe('Chocolate flavor');
    });

    it('POST /api/fitness - Should update existing record with supplements', async () => {
        // 1. Initial record
        await request(app)
            .post('/api/fitness')
            .set('x-auth-token', userToken)
            .send({
                date: new Date().toISOString(),
                body: { weight: 70 }
            });

        // 2. Update with supplements
        const res = await request(app)
            .post('/api/fitness')
            .set('x-auth-token', userToken)
            .send({
                date: new Date().toISOString(),
                supplements: {
                    protein: true,
                    vitamins: false
                }
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.body.weight).toBe(70); // Should preserve existing data
        expect(res.body.supplements.protein).toBe(true);
        expect(res.body.supplements.vitamins).toBe(false);
    });
});
