export const channelsJsonCache = new Map();

export const clearChannelsCache = (userId) => {
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
};
