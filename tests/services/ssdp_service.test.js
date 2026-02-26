import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dgram from 'dgram';
import os from 'os';

// Mock config/constants.js
vi.mock('../../src/config/constants.js', () => ({
  PORT: 3000
}));

// Mock better-sqlite3 so it doesn't try to load the native module
vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn().mockReturnValue({
      prepare: vi.fn().mockReturnValue({ all: vi.fn(), run: vi.fn(), get: vi.fn() }),
      exec: vi.fn(),
      pragma: vi.fn(),
      close: vi.fn()
    })
  };
});

// Mock db.js with a factory to avoid loading the real file
vi.mock('../../src/database/db.js', () => {
  return {
    default: {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([])
      })
    }
  };
});

// Now import modules
import db from '../../src/database/db.js';
import { startSSDP } from '../../src/services/ssdpService.js';
import { PORT } from '../../src/config/constants.js';

vi.mock('dgram');
vi.mock('os');

describe('SSDP Service', () => {
  let mockSocket;
  let socketListeners = {};
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    socketListeners = {};

    mockSocket = {
      on: vi.fn((event, callback) => {
        socketListeners[event] = callback;
      }),
      bind: vi.fn(),
      addMembership: vi.fn(),
      setMulticastTTL: vi.fn(),
      send: vi.fn((msg, offset, length, port, address, cb) => {
        if (cb) cb(null);
      }),
      close: vi.fn(),
      address: vi.fn(() => ({ address: '0.0.0.0', port: 1900 })),
    };

    dgram.createSocket.mockReturnValue(mockSocket);

    // Mock OS interfaces
    os.networkInterfaces.mockReturnValue({
      'eth0': [{ family: 'IPv4', internal: false, address: '192.168.1.100' }],
      'lo': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
    });

    // Reset DB mock for each test
    db.prepare.mockReturnValue({
      all: vi.fn().mockReturnValue([
        { id: 1, username: 'testuser', hdhr_token: 'token123' }
      ])
    });

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should initialize socket and bind to port 1900', () => {
    startSSDP();

    expect(dgram.createSocket).toHaveBeenCalledWith({ type: 'udp4', reuseAddr: true });
    expect(mockSocket.on).toHaveBeenCalledWith('listening', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockSocket.bind).toHaveBeenCalledWith(1900, '0.0.0.0');
  });

  it('should set up multicast on listening event', () => {
    startSSDP();

    // Trigger listening event
    if (socketListeners['listening']) {
      socketListeners['listening']();
    }

    expect(mockSocket.setMulticastTTL).toHaveBeenCalledWith(4);
    expect(mockSocket.addMembership).toHaveBeenCalledWith('239.255.255.250', '192.168.1.100');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('SSDP Service listening'));
  });

  it('should respond to M-SEARCH requests', () => {
    startSSDP();

    const rinfo = { address: '192.168.1.50', port: 12345 };
    const searchMessage = [
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 1',
      'ST: ssdp:all'
    ].join('\r\n');

    // Trigger message event
    if (socketListeners['message']) {
      socketListeners['message'](Buffer.from(searchMessage), rinfo);
    }

    // Expect 3 responses per user for ssdp:all (root, uuid, device type)
    expect(mockSocket.send).toHaveBeenCalledTimes(3);

    // Verify response content contains expected headers
    const sentBuffer = mockSocket.send.mock.calls[0][0];
    const response = sentBuffer.toString();

    expect(response).toContain('HTTP/1.1 200 OK');
    expect(response).toContain(`LOCATION: http://192.168.1.100:${PORT}/hdhr/token123/device.xml`);
    expect(response).toContain('ST: upnp:rootdevice');
  });

  it('should filter M-SEARCH requests by ST header', () => {
    startSSDP();

    const rinfo = { address: '192.168.1.50', port: 12345 };
    const searchMessage = [
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 1',
      'ST: upnp:rootdevice' // Specific target
    ].join('\r\n');

    if (socketListeners['message']) {
      socketListeners['message'](Buffer.from(searchMessage), rinfo);
    }

    // Expect 1 response for specific target
    expect(mockSocket.send).toHaveBeenCalledTimes(1);

    const sentBuffer = mockSocket.send.mock.calls[0][0];
    const response = sentBuffer.toString();
    expect(response).toContain('ST: upnp:rootdevice');
  });

  it('should ignore invalid M-SEARCH requests', () => {
    startSSDP();

    const rinfo = { address: '192.168.1.50', port: 12345 };
    const invalidMessage = [
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:invalid"', // Wrong MAN
      'ST: ssdp:all'
    ].join('\r\n');

    if (socketListeners['message']) {
      socketListeners['message'](Buffer.from(invalidMessage), rinfo);
    }

    expect(mockSocket.send).not.toHaveBeenCalled();
  });

  it('should send periodic NOTIFY messages', () => {
    startSSDP();

    // Fast-forward time by 60 seconds
    vi.advanceTimersByTime(60000);

    // Expect 3 notifications per user (root, uuid, device type)
    expect(mockSocket.send).toHaveBeenCalledTimes(3);

    const sentBuffer = mockSocket.send.mock.calls[0][0];
    const notify = sentBuffer.toString();

    expect(notify).toContain('NOTIFY * HTTP/1.1');
    expect(notify).toContain('NTS: ssdp:alive');
    expect(notify).toContain(`LOCATION: http://192.168.1.100:${PORT}/hdhr/token123/device.xml`);
  });

  it('should handle socket errors gracefully', () => {
    startSSDP();

    const error = new Error('Socket failure');

    if (socketListeners['error']) {
      socketListeners['error'](error);
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('SSDP Socket Error'));
    expect(mockSocket.close).toHaveBeenCalled();
  });

  it('should handle send errors in M-SEARCH response', () => {
    mockSocket.send = vi.fn((msg, offset, length, port, address, cb) => {
      if (cb) cb(new Error('Send failed'));
    });

    startSSDP();

    const rinfo = { address: '192.168.1.50', port: 12345 };
    const searchMessage = [
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"',
        'ST: ssdp:all'
    ].join('\r\n');

    if (socketListeners['message']) {
        socketListeners['message'](Buffer.from(searchMessage), rinfo);
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('SSDP Response Error'), expect.any(Error));
  });

  it('should fallback to 127.0.0.1 if no external interface found', () => {
    os.networkInterfaces.mockReturnValue({}); // No interfaces

    startSSDP();

    // Trigger listening
    if (socketListeners['listening']) {
        socketListeners['listening']();
    }

    // Should still try to join multicast group
    expect(mockSocket.addMembership).toHaveBeenCalledWith('239.255.255.250', '127.0.0.1');
  });

  it('should handle database errors during M-SEARCH', () => {
    db.prepare.mockImplementation(() => {
        throw new Error('DB Error');
    });

    startSSDP();

    const rinfo = { address: '192.168.1.50', port: 12345 };
    const searchMessage = [
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"',
        'ST: ssdp:all'
    ].join('\r\n');

    if (socketListeners['message']) {
        socketListeners['message'](Buffer.from(searchMessage), rinfo);
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith('SSDP DB Error:', expect.any(Error));
  });

  it('should handle database errors during periodic notify', () => {
    startSSDP();

    // Make DB fail
    db.prepare.mockImplementation(() => {
        throw new Error('DB Error');
    });

    // Advance time
    vi.advanceTimersByTime(60000);

    expect(consoleErrorSpy).toHaveBeenCalledWith('SSDP Periodic Notify Error:', expect.any(Error));
  });
});
