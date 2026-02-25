import { describe, it, expect, beforeEach, vi } from 'vitest';
import streamManager from '../../src/services/streamManager.js';

describe('StreamManager Smart Limits', () => {
  describe('DB Implementation (SQL Verification)', () => {
    let mockDb;
    let mockStmt;

    beforeEach(() => {
      mockStmt = {
        get: vi.fn(),
        run: vi.fn(),
        all: vi.fn()
      };
      mockDb = {
        prepare: vi.fn().mockReturnValue(mockStmt)
      };
      streamManager.init(mockDb, null);
    });

    it('should use correct SQL for provider connection count', async () => {
      mockStmt.get.mockReturnValue({ count: 5 });

      const count = await streamManager.getProviderConnectionCount(123);

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT DISTINCT channel_name, ip, user_id')
      );
      expect(mockStmt.get).toHaveBeenCalledWith(123);
      expect(count).toBe(5);
    });

    it('should use correct SQL for checking active session', async () => {
      mockStmt.get.mockReturnValue(1);

      const isActive = await streamManager.isSessionActive(1, '1.1.1.1', 'Channel A', 100);

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT 1 FROM current_streams WHERE user_id = ? AND ip = ? AND channel_name = ? AND provider_id = ? LIMIT 1')
      );
      expect(mockStmt.get).toHaveBeenCalledWith(1, '1.1.1.1', 'Channel A', 100);
      expect(isActive).toBe(true);
    });
  });

  describe('Redis Implementation (Logic Verification)', () => {
    let mockRedis;

    beforeEach(() => {
      mockRedis = {
        hSet: vi.fn(),
        set: vi.fn(),
        hGet: vi.fn(),
        del: vi.fn(),
        hDel: vi.fn(),
        hGetAll: vi.fn(),
        get: vi.fn()
      };
      streamManager.init(null, mockRedis);
    });

    it('should count unique sessions correctly for provider limits', async () => {
      const streams = {
        '1': JSON.stringify({ user_id: 1, channel_name: 'Channel A', ip: '1.1.1.1', provider_id: 100 }),
        '2': JSON.stringify({ user_id: 1, channel_name: 'Channel A', ip: '1.1.1.1', provider_id: 100 }), // Same session
        '3': JSON.stringify({ user_id: 2, channel_name: 'Channel A', ip: '2.2.2.2', provider_id: 100 }), // Different user/ip
        '4': JSON.stringify({ user_id: 1, channel_name: 'Channel B', ip: '1.1.1.1', provider_id: 100 }), // Different channel
        '5': JSON.stringify({ user_id: 3, channel_name: 'Channel X', ip: '3.3.3.3', provider_id: 200 })  // Different provider
      };
      mockRedis.hGetAll.mockResolvedValue(streams);

      const count = await streamManager.getProviderConnectionCount(100);

      // Expected:
      // 1. User 1, Channel A, 1.1.1.1 (from '1' and '2')
      // 2. User 2, Channel A, 2.2.2.2 (from '3')
      // 3. User 1, Channel B, 1.1.1.1 (from '4')
      // Total 3
      expect(count).toBe(3);
    });

    it('should identify active sessions correctly', async () => {
       const streams = {
        '1': JSON.stringify({ user_id: 1, channel_name: 'Channel A', ip: '1.1.1.1', provider_id: 100 })
      };
      mockRedis.hGetAll.mockResolvedValue(streams);

      expect(await streamManager.isSessionActive(1, '1.1.1.1', 'Channel A', 100)).toBe(true);
      expect(await streamManager.isSessionActive(1, '1.1.1.1', 'Channel B', 100)).toBe(false);
      expect(await streamManager.isSessionActive(2, '1.1.1.1', 'Channel A', 100)).toBe(false);
    });
  });
});
