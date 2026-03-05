import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import db, { initDb } from '../../src/database/db.js';
import * as channelController from '../../src/controllers/channelController.js';

const app = express();
app.use(express.json());
// Mock auth middleware to set req.user
app.use((req, res, next) => {
    req.user = { id: 1, is_admin: true };
    next();
});

app.get('/api/users/:userId/categories', channelController.getUserCategories);
app.post('/api/users/:userId/categories', channelController.createUserCategory);

describe('Channel Functional Tests', () => {
    beforeAll(() => {
        initDb(true);
        db.prepare('DELETE FROM user_categories').run();
    });

    it('should create and retrieve a category', async () => {
        const res = await request(app)
            .post('/api/users/1/categories')
            .send({ name: 'News', type: 'live' });

        expect(res.status).toBe(200);
        expect(res.body.id).toBeDefined();

        const getRes = await request(app).get('/api/users/1/categories');
        expect(getRes.status).toBe(200);
        expect(getRes.body.length).toBe(1);
        expect(getRes.body[0].name).toBe('News');
    });
});
