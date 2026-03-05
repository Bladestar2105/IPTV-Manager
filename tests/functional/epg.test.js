import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import db, { initDb } from '../../src/database/db.js';
import * as epgController from '../../src/controllers/epgController.js';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    req.user = { id: 1, is_admin: true };
    next();
});

app.get('/api/epg-sources', epgController.getEpgSources);
app.post('/api/epg-sources', epgController.createEpgSource);

describe('EPG Functional Tests', () => {
    beforeAll(() => {
        initDb(true);
        db.prepare('DELETE FROM epg_sources').run();
    });

    it('should create and list EPG sources', async () => {
        const res = await request(app)
            .post('/api/epg-sources')
            .send({ name: 'Test EPG', url: 'http://example.com/epg.xml' });

        expect(res.status).toBe(200);
        expect(res.body.id).toBeDefined();

        const getRes = await request(app).get('/api/epg-sources');
        expect(getRes.status).toBe(200);
        expect(getRes.body.some(s => s.name === 'Test EPG')).toBe(true);
    });
});
