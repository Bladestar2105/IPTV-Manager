import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as xtreamController from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';

vi.mock('../../src/services/authService.js', () => ({
  getXtreamUser: vi.fn(),
}));

const app = express();
app.get('/cpp', xtreamController.cppEndpoint);
app.get('/player_api.php', xtreamController.playerApi);

describe('Xtream Controller CPP pre-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true for /cpp endpoint', async () => {
    const res = await request(app).get('/cpp');
    expect(res.status).toBe(200);
    expect(res.text).toBe('true');
  });

  it('should return true for player_api.php with action=cpp without checking auth', async () => {
    const res = await request(app).get('/player_api.php?action=cpp');
    expect(res.status).toBe(200);
    expect(res.text).toBe('true');
    expect(getXtreamUser).not.toHaveBeenCalled();
  });
});
