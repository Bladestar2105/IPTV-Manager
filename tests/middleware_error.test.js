import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import multer from 'multer';
import { errorHandler } from '../src/middleware/errorHandler.js';

describe('Error Handling Middleware', () => {
    const app = express();

    // Setup routes that throw errors
    app.get('/error', (req, res, next) => {
        next(new Error('Generic Error'));
    });

    app.get('/multer-error', (req, res, next) => {
        const err = new multer.MulterError('LIMIT_FILE_SIZE');
        next(err);
    });

    app.get('/multer-other-error', (req, res, next) => {
        const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE');
        next(err);
    });

    app.get('/body-parser-error', (req, res, next) => {
        const err = new Error('Payload too large');
        err.type = 'entity.too.large';
        next(err);
    });

    // Register middleware
    app.use(errorHandler);

    it('should return 500 JSON for generic errors', async () => {
        const res = await request(app).get('/error');
        expect(res.status).toBe(500);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body).toEqual({ error: 'Generic Error' });
    });

    it('should return 400 JSON for Multer LIMIT_FILE_SIZE', async () => {
        const res = await request(app).get('/multer-error');
        expect(res.status).toBe(400);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body).toEqual({ error: 'File too large' });
    });

    it('should return 400 JSON for other Multer errors', async () => {
        const res = await request(app).get('/multer-other-error');
        expect(res.status).toBe(400);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body).toEqual({ error: 'Unexpected field' });
    });

    it('should return 413 JSON for body parser limit errors', async () => {
        const res = await request(app).get('/body-parser-error');
        expect(res.status).toBe(413);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body).toEqual({ error: 'Payload too large' });
    });
});
