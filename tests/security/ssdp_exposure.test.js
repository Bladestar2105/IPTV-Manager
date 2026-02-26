import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startSSDP } from '../../src/services/ssdpService.js';
import dgram from 'dgram';
import db from '../../src/database/db.js';

// Mock dependencies
vi.mock('dgram');
vi.mock('../../src/database/db.js');
vi.mock('os', () => ({
    default: {
        networkInterfaces: () => ({
            'eth0': [{ family: 'IPv4', internal: false, address: '192.168.1.5' }]
        })
    }
}));

// We need to mock the helpers to control isUnsafeIP behavior if we were using it,
// but currently the code doesn't use it, so it's not strictly necessary to mock it
// for the "Fail" state, but we will need it for the "Pass" state.
// To avoid module hoisting issues, we mock it globally.
vi.mock('../../src/utils/helpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isUnsafeIP: vi.fn((ip) => {
        // Simple mock: 192.168.* and 10.* are unsafe (private)
        if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip === '127.0.0.1') return true;
        return false;
    })
  };
});

describe('SSDP Security', () => {
    let socketMock;
    let messageHandler;

    beforeEach(() => {
        socketMock = {
            on: vi.fn((event, handler) => {
                if (event === 'message') messageHandler = handler;
            }),
            bind: vi.fn(),
            send: vi.fn(),
            address: vi.fn(() => ({ address: '0.0.0.0', port: 1900 })),
            setMulticastTTL: vi.fn(),
            addMembership: vi.fn(),
            close: vi.fn()
        };
        dgram.createSocket.mockReturnValue(socketMock);

        // Mock DB users
        db.prepare.mockReturnValue({
            all: vi.fn().mockReturnValue([
                { id: 1, username: 'user1', hdhr_token: 'token123' }
            ])
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should respond to M-SEARCH from private IP', () => {
        startSSDP();

        // Ensure message handler was registered
        expect(messageHandler).toBeDefined();

        const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nMAN: "ssdp:discover"\r\nST: ssdp:all\r\n\r\n');
        const rinfo = { address: '192.168.1.100', port: 12345 };

        messageHandler(msg, rinfo);

        expect(socketMock.send).toHaveBeenCalled();
    });

    it('should NOT respond to M-SEARCH from public IP', () => {
        startSSDP();

        expect(messageHandler).toBeDefined();

        const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nMAN: "ssdp:discover"\r\nST: ssdp:all\r\n\r\n');
        const rinfo = { address: '8.8.8.8', port: 12345 };

        messageHandler(msg, rinfo);

        // This expectation is for the FIXED version.
        // Currently, it WILL call send, so we expect this test to FAIL initially.
        expect(socketMock.send).not.toHaveBeenCalled();
    });
});
