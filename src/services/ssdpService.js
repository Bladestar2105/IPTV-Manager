import dgram from 'dgram';
import os from 'os';
import db from '../database/db.js';
import { PORT } from '../config/constants.js';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const DEVICE_TYPE = 'urn:schemas-upnp-org:device:MediaServer:1';
const ROOT_DEVICE = 'upnp:rootdevice';
const SEARCH_TARGETS = [
    ROOT_DEVICE,
    'ssdp:all',
    DEVICE_TYPE
];

// Get all non-internal IPv4 addresses
function getInterfaceAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        }
    }
    if (addresses.length === 0) return ['127.0.0.1'];
    return addresses;
}

// Send unicast response to M-SEARCH
function sendResponse(socket, rinfo, user, localIp, st) {
    const deviceID = `1234${user.id.toString(16).padStart(4, '0')}`;
    const location = `http://${localIp}:${PORT}/hdhr/${user.hdhr_token}/device.xml`;
    const date = new Date().toUTCString();

    const targets = [];
    if (st === 'ssdp:all') {
        targets.push(ROOT_DEVICE);
        targets.push(`uuid:${deviceID}`);
        targets.push(DEVICE_TYPE);
    } else {
        targets.push(st);
    }

    targets.forEach(target => {
        let usn = `uuid:${deviceID}`;
        if (!target.startsWith('uuid:')) {
            usn += `::${target}`;
        }

        const response = [
            'HTTP/1.1 200 OK',
            'CACHE-CONTROL: max-age=1800',
            `DATE: ${date}`,
            'EXT:',
            `LOCATION: ${location}`,
            'SERVER: Node.js/14 UPnP/1.0 IPTV-Manager/1.0',
            `ST: ${target}`,
            `USN: ${usn}`,
            'BOOTID.UPNP.ORG: 1',
            'CONFIGID.UPNP.ORG: 1',
            '', ''
        ].join('\r\n');

        const message = Buffer.from(response);
        socket.send(message, 0, message.length, rinfo.port, rinfo.address, (err) => {
            if (err) console.error(`SSDP Response Error to ${rinfo.address}:`, err);
        });
    });
}

function sendNotify(socket, user, localIp) {
    const deviceID = `1234${user.id.toString(16).padStart(4, '0')}`;
    const location = `http://${localIp}:${PORT}/hdhr/${user.hdhr_token}/device.xml`;

    const notifications = [
        { nt: ROOT_DEVICE, usn: `uuid:${deviceID}::${ROOT_DEVICE}` },
        { nt: `uuid:${deviceID}`, usn: `uuid:${deviceID}` },
        { nt: DEVICE_TYPE, usn: `uuid:${deviceID}::${DEVICE_TYPE}` }
    ];

    notifications.forEach(({ nt, usn }) => {
        const notify = [
            'NOTIFY * HTTP/1.1',
            `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
            'CACHE-CONTROL: max-age=1800',
            `LOCATION: ${location}`,
            `NT: ${nt}`,
            'NTS: ssdp:alive',
            'SERVER: Node.js/14 UPnP/1.0 IPTV-Manager/1.0',
            `USN: ${usn}`,
            'BOOTID.UPNP.ORG: 1',
            'CONFIGID.UPNP.ORG: 1',
            '', ''
        ].join('\r\n');

        const message = Buffer.from(notify);
        socket.send(message, 0, message.length, SSDP_PORT, SSDP_ADDRESS, (err) => {
            // Suppress errors (often EHOSTUNREACH if no route)
        });
    });
}

export function startSSDP() {
    try {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        socket.on('listening', () => {
            const address = socket.address();
            console.log(`📡 SSDP Service listening on ${address.address}:${address.port}`);

            try {
                // Increase TTL for better reachability
                socket.setMulticastTTL(4);
            } catch (e) {
                console.warn('SSDP: Failed to set Multicast TTL:', e.message);
            }

            // Join multicast group on all available interfaces
            const ips = getInterfaceAddresses();
            ips.forEach(ip => {
                try {
                    socket.addMembership(SSDP_ADDRESS, ip);
                    console.log(`📡 SSDP: Joined multicast group on ${ip}`);
                } catch (e) {
                    console.warn(`SSDP: Failed to join multicast group on ${ip}:`, e.message);
                }
            });
        });

        socket.on('message', (msg, rinfo) => {
            const message = msg.toString();
            const headers = {};

            message.split('\r\n').forEach(line => {
                const parts = line.split(':');
                if (parts.length >= 2) {
                    headers[parts[0].trim().toUpperCase()] = parts.slice(1).join(':').trim();
                }
            });

            // Handle M-SEARCH
            if (message.startsWith('M-SEARCH') && headers['MAN'] === '"ssdp:discover"') {
                const st = headers['ST'];

                // Check if ST is supported
                if (SEARCH_TARGETS.includes(st)) {
                    const ips = getInterfaceAddresses();
                    const primaryIp = ips[0] || '127.0.0.1';

                    try {
                        const users = db.prepare('SELECT id, username, hdhr_token FROM users WHERE hdhr_enabled = 1 AND is_active = 1').all();
                        users.forEach(user => {
                            sendResponse(socket, rinfo, user, primaryIp, st);
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

        // Bind to 0.0.0.0:1900 to listen on all interfaces
        socket.bind(SSDP_PORT, '0.0.0.0');

        // Periodic NOTIFY (every 60s)
        setInterval(() => {
            try {
                const ips = getInterfaceAddresses();
                const primaryIp = ips[0] || '127.0.0.1';
                const users = db.prepare('SELECT id, username, hdhr_token FROM users WHERE hdhr_enabled = 1 AND is_active = 1').all();

                users.forEach(user => {
                    sendNotify(socket, user, primaryIp);
                });
            } catch (e) {
                console.error('SSDP Periodic Notify Error:', e);
            }
        }, 60000);

    } catch (e) {
        console.error('Failed to start SSDP service:', e);
    }
}
