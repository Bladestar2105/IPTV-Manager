import dgram from 'dgram';
import os from 'os';
import db from '../database/db.js';
import { PORT } from '../config/constants.js';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
    'upnp:rootdevice',
    'ssdp:all',
    'urn:schemas-upnp-org:device:MediaServer:1'
];

function getInterfaceAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

function sendResponse(socket, rinfo, user, ip) {
    const deviceID = `1234${user.id.toString(16).padStart(4, '0')}`;
    // Using IP address for Location URL as SSDP requires it
    const location = `http://${ip}:${PORT}/hdhr/${user.hdhr_token}/device.xml`;
    const usn = `uuid:${deviceID}::urn:schemas-upnp-org:device:MediaServer:1`;
    const date = new Date().toUTCString();

    const response = [
        'HTTP/1.1 200 OK',
        'CACHE-CONTROL: max-age=1800',
        `DATE: ${date}`,
        'EXT:',
        `LOCATION: ${location}`,
        'SERVER: Node.js/14 UPnP/1.0 IPTV-Manager/1.0',
        'ST: urn:schemas-upnp-org:device:MediaServer:1',
        `USN: ${usn}`,
        'BOOTID.UPNP.ORG: 1',
        'CONFIGID.UPNP.ORG: 1',
        '', ''
    ].join('\r\n');

    const message = Buffer.from(response);
    socket.send(message, 0, message.length, rinfo.port, rinfo.address, (err) => {
        if (err) console.error('SSDP Response Error:', err);
    });
}

function sendNotify(socket, user, ip) {
    const deviceID = `1234${user.id.toString(16).padStart(4, '0')}`;
    const location = `http://${ip}:${PORT}/hdhr/${user.hdhr_token}/device.xml`;
    const usn = `uuid:${deviceID}::urn:schemas-upnp-org:device:MediaServer:1`;

    const notify = [
        'NOTIFY * HTTP/1.1',
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
        'CACHE-CONTROL: max-age=1800',
        `LOCATION: ${location}`,
        'NT: urn:schemas-upnp-org:device:MediaServer:1',
        'NTS: ssdp:alive',
        'SERVER: Node.js/14 UPnP/1.0 IPTV-Manager/1.0',
        `USN: ${usn}`,
        '', ''
    ].join('\r\n');

    const message = Buffer.from(notify);
    socket.send(message, 0, message.length, SSDP_PORT, SSDP_ADDRESS, (err) => {
        if (err) console.error('SSDP Notify Error:', err);
    });
}

export function startSSDP() {
    try {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        socket.on('listening', () => {
            const address = socket.address();
            console.log(`📡 SSDP Service listening on ${address.address}:${address.port}`);
            try {
                socket.addMembership(SSDP_ADDRESS);
            } catch (e) {
                console.error('Failed to add multicast membership:', e);
            }
        });

        socket.on('message', (msg, rinfo) => {
            const message = msg.toString();

            // Parse headers
            const headers = {};
            message.split('\r\n').forEach(line => {
                const parts = line.split(':');
                if (parts.length >= 2) {
                    headers[parts[0].trim().toUpperCase()] = parts.slice(1).join(':').trim();
                }
            });

            if (message.startsWith('M-SEARCH') && headers['MAN'] === '"ssdp:discover"') {
                const st = headers['ST'];
                if (SEARCH_TARGETS.includes(st)) {
                    const ip = getInterfaceAddress();
                    try {
                        const users = db.prepare('SELECT id, username, hdhr_token FROM users WHERE hdhr_enabled = 1 AND is_active = 1').all();
                        users.forEach(user => {
                            sendResponse(socket, rinfo, user, ip);
                        });
                    } catch (dbError) {
                        console.error('SSDP DB Error:', dbError);
                    }
                }
            }
        });

        socket.on('error', (err) => {
            console.error(`SSDP Socket Error:\n${err.stack}`);
            try { socket.close(); } catch(e) {}
        });

        socket.bind(SSDP_PORT);

        // Periodic notifications
        setInterval(() => {
            try {
                const ip = getInterfaceAddress();
                const users = db.prepare('SELECT id, username, hdhr_token FROM users WHERE hdhr_enabled = 1 AND is_active = 1').all();
                users.forEach(user => {
                    sendNotify(socket, user, ip);
                });
            } catch (e) {
                console.error('SSDP Periodic Notify Error:', e);
            }
        }, 60000); // Every 60 seconds

    } catch (e) {
        console.error('Failed to start SSDP service:', e);
    }
}
