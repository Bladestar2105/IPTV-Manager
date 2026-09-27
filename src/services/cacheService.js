import cluster from 'node:cluster';

export const channelsJsonCache = new Map();

let started = false;
let clearEpgLogos = () => {};

// The primary relays invalidations over the existing cluster IPC channel.
// Received messages clear locally without rebroadcasting them.
export function startChannelsCacheInvalidation(invalidateEpgLogos = () => {}) {
    if (started) return;
    started = true;
    clearEpgLogos = invalidateEpgLogos;
    if (cluster.isPrimary) {
        cluster.on('message', (_worker, message) => {
            if (message?.type === 'invalidate_channels_cache') {
                clearChannelsCache(message.userId, {epg: message.epg === true});
            }
        });
    } else {
        process.on('message', message => {
            if (message?.type === 'invalidate_channels_cache') {
                clearChannelsCache(message.userId, {broadcast: false, epg: message.epg === true});
            }
        });
    }
}

export const clearChannelsCache = (userId, {broadcast = true, epg = false} = {}) => {
    if (userId) {
        // Clear all caches that start with user_{userId}_ or guest_{userId}_
        const keysToRemove = [];
        for (const key of channelsJsonCache.keys()) {
            if (key.startsWith(`user_${userId}_`) || key.startsWith(`guest_${userId}_`)) {
                keysToRemove.push(key);
            }
        }
        for (const key of keysToRemove) {
            channelsJsonCache.delete(key);
        }
    } else {
        channelsJsonCache.clear();
    }
    if (epg) clearEpgLogos();
    if (!started || !broadcast) return;
    const message = {type: 'invalidate_channels_cache', userId, epg};
    // A worker exiting during the notification must not turn a committed sync
    // into an error. Its replacement starts with empty caches.
    if (cluster.isPrimary) {
        for (const worker of Object.values(cluster.workers)) {
            if (worker?.isConnected()) worker.send(message, () => {});
        }
    } else if (process.connected) {
        process.send(message, () => {});
    }
};
