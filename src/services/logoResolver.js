import db from '../database/db.js';
import epgDb from '../database/epgDb.js';
import crypto from 'crypto';

// Cache for EPG logos: Map<epg_channel_id, logo_url>
let epgLogosCache = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 300000; // 5 minutes

// In-memory cache for provider icon mappings: Map<provider_id, Set<cache_hash>>
const providerIconMemoryCache = new Map();

/**
 * Load EPG logos from epg_channels table into memory cache
 */
export function loadEpgLogosCache() {
    const now = Date.now();
    if (epgLogosCache && (now - lastCacheUpdate) < CACHE_TTL) {
        return epgLogosCache;
    }

    try {
        const channels = epgDb.prepare(`
            SELECT id, logo
            FROM epg_channels
            WHERE logo IS NOT NULL AND logo != ''
        `).all();

        epgLogosCache = new Map();
        for (const ch of channels) {
            epgLogosCache.set(ch.id, ch.logo);
        }
        lastCacheUpdate = now;
        console.log(`✅ Loaded ${epgLogosCache.size} EPG logos into cache`);
        return epgLogosCache;
    } catch (e) {
        console.error('Failed to load EPG logos cache:', e.message);
        return epgLogosCache || new Map();
    }
}

/**
 * Get logo for a channel, preferring EPG logo if useEpgLogo is true
 * @param {Object} options - Options object
 * @param {string} options.providerLogo - Original provider channel logo
 * @param {string} options.epgChannelId - EPG channel ID (mapped or original)
 * @param {boolean} options.useEpgLogo - Whether to prefer EPG logo
 * @returns {string|null} - The best logo URL to use
 */
export function resolveChannelLogo({ providerLogo, epgChannelId, useEpgLogo = false }) {
    if (!useEpgLogo || !epgChannelId) {
        return providerLogo || null;
    }

    const epgLogos = loadEpgLogosCache();
    const epgLogo = epgLogos.get(epgChannelId);

    // Prefer EPG logo if available, otherwise fall back to provider logo
    return epgLogo || providerLogo || null;
}

/**
 * Get EPG logo for a channel ID
 * @param {string} epgChannelId - EPG channel ID
 * @returns {string|null} - EPG logo URL or null
 */
export function getEpgLogo(epgChannelId) {
    if (!epgChannelId) return null;

    const epgLogos = loadEpgLogosCache();
    return epgLogos.get(epgChannelId) || null;
}

/**
 * Generate a cache hash for a logo URL
 * @param {string} logoUrl - Logo URL to hash
 * @returns {string} - MD5 hash of the URL
 */
export function getLogoCacheHash(logoUrl) {
    if (!logoUrl) return null;
    return crypto.createHash('md5').update(logoUrl).digest('hex');
}

/**
 * Get a cache key for provider-specific logo caching
 * This ensures that channels from the same provider share the same cached logo
 * @param {number} providerId - Provider ID
 * @param {string} logoUrl - Original logo URL
 * @returns {string} - Cache key for the picon
 */
export function getPiconCacheKey(providerId, logoUrl) {
    if (!logoUrl) return null;
    // Use MD5 hash of URL - this allows sharing across all users with same provider
    return getLogoCacheHash(logoUrl);
}

/**
 * Register a cached icon for a provider
 * This tracks which icons have been cached for each provider
 * @param {number} providerId - Provider ID
 * @param {string} logoUrl - Logo URL that was cached
 * @param {string} cacheHash - The cache hash (MD5 of URL)
 */
export function registerProviderCachedIcon(providerId, logoUrl, cacheHash) {
    if (!providerId || !logoUrl || !cacheHash) return;

    try {
        db.prepare(`
            INSERT INTO provider_icon_cache (provider_id, logo_url, cache_hash, last_accessed, access_count)
            VALUES (?, ?, ?, strftime('%s', 'now'), 1)
            ON CONFLICT (provider_id, logo_url) DO UPDATE SET
            last_accessed = strftime('%s', 'now'),
            access_count = provider_icon_cache.access_count + 1
        `).run(providerId, logoUrl, cacheHash);

        // Update memory cache
        if (!providerIconMemoryCache.has(providerId)) {
            providerIconMemoryCache.set(providerId, new Set());
        }
        providerIconMemoryCache.get(providerId).add(cacheHash);
    } catch (e) {
        console.error('Failed to register provider cached icon:', e.message);
    }
}

/**
 * Check if an icon is already cached for a provider
 * @param {number} providerId - Provider ID
 * @param {string} logoUrl - Logo URL to check
 * @returns {Object|null} - Cache info or null if not cached
 */
export function getProviderCachedIcon(providerId, logoUrl) {
    if (!providerId || !logoUrl) return null;

    try {
        const row = db.prepare(`
            SELECT cache_hash, last_accessed, access_count
            FROM provider_icon_cache
            WHERE provider_id = ? AND logo_url = ?
        `).get(providerId, logoUrl);

        if (row) {
            // Update last accessed time
            db.prepare(`
                UPDATE provider_icon_cache
                SET last_accessed = strftime('%s', 'now'), access_count = access_count + 1
                WHERE provider_id = ? AND logo_url = ?
            `).run(providerId, logoUrl);
        }

        return row || null;
    } catch (e) {
        console.error('Failed to get provider cached icon:', e.message);
        return null;
    }
}

/**
 * Get all cached icons for a provider
 * @param {number} providerId - Provider ID
 * @returns {Array} - Array of cached icon info
 */
export function getProviderCachedIcons(providerId) {
    if (!providerId) return [];

    try {
        return db.prepare(`
            SELECT logo_url, cache_hash, created_at, last_accessed, access_count
            FROM provider_icon_cache
            WHERE provider_id = ?
            ORDER BY access_count DESC
        `).all(providerId);
    } catch (e) {
        console.error('Failed to get provider cached icons:', e.message);
        return [];
    }
}

/**
 * Pre-populate icon cache entries for a provider's channels
 * Call this after syncing channels to prepare cache entries
 * @param {number} providerId - Provider ID
 */
export function prePopulateProviderIconCache(providerId) {
    if (!providerId) return;

    try {
        // Get unique logos from provider's channels
        const channels = db.prepare(`
            SELECT DISTINCT logo
            FROM provider_channels
            WHERE provider_id = ? AND logo IS NOT NULL AND logo != ''
        `).all(providerId);

        let count = 0;
        db.transaction(() => {
            const insertStmt = db.prepare(`
                INSERT OR IGNORE INTO provider_icon_cache (provider_id, logo_url, cache_hash)
                VALUES (?, ?, ?)
            `);

            for (const ch of channels) {
                if (ch.logo) {
                    const hash = getLogoCacheHash(ch.logo);
                    insertStmt.run(providerId, ch.logo, hash);
                    count++;
                }
            }
        })();

        // Update memory cache
        providerIconMemoryCache.set(providerId, new Set(
            channels.filter(ch => ch.logo).map(ch => getLogoCacheHash(ch.logo))
        ));

        if (count > 0) {
            console.log(`✅ Pre-populated ${count} icon cache entries for provider ${providerId}`);
        }
    } catch (e) {
        console.error('Failed to pre-populate provider icon cache:', e.message);
    }
}

/**
 * Clear icon cache entries for a provider
 * @param {number} providerId - Provider ID
 */
export function clearProviderIconCache(providerId) {
    if (!providerId) return;

    try {
        db.prepare('DELETE FROM provider_icon_cache WHERE provider_id = ?').run(providerId);
        providerIconMemoryCache.delete(providerId);
        console.log(`🗑️ Cleared icon cache entries for provider ${providerId}`);
    } catch (e) {
        console.error('Failed to clear provider icon cache:', e.message);
    }
}

/**
 * Get cache statistics
 * @returns {Object} - Cache statistics
 */
export function getIconCacheStats() {
    try {
        const stats = db.prepare(`
            SELECT
                COUNT(DISTINCT provider_id) as provider_count,
                COUNT(*) as total_entries,
                SUM(access_count) as total_accesses
            FROM provider_icon_cache
        `).get();

        return stats || { provider_count: 0, total_entries: 0, total_accesses: 0 };
    } catch (e) {
        console.error('Failed to get icon cache stats:', e.message);
        return { provider_count: 0, total_entries: 0, total_accesses: 0 };
    }
}

/**
 * Resolve logos for multiple channels efficiently
 * @param {Array} channels - Array of channel objects with logo, epg_channel_id, and optionally manual_epg_id
 * @param {boolean} useEpgLogo - Whether to prefer EPG logos
 * @returns {Array} - Channels with resolved logos
 */
export function resolveLogosForChannels(channels, useEpgLogo = false) {
    if (!useEpgLogo || channels.length === 0) {
        return channels;
    }

    const epgLogos = loadEpgLogosCache();

    return channels.map(ch => {
        const epgId = ch.manual_epg_id || ch.epg_channel_id;
        if (epgId && epgLogos.has(epgId)) {
            return { ...ch, logo: epgLogos.get(epgId) };
        }
        return ch;
    });
}

/**
 * Invalidate the EPG logos cache (call after EPG update)
 */
export function invalidateEpgLogosCache() {
    epgLogosCache = null;
    lastCacheUpdate = 0;
    providerIconMemoryCache.clear();
    console.log('🔄 EPG logos cache invalidated');
}

export default {
    loadEpgLogosCache,
    resolveChannelLogo,
    getEpgLogo,
    getLogoCacheHash,
    getPiconCacheKey,
    registerProviderCachedIcon,
    getProviderCachedIcon,
    getProviderCachedIcons,
    prePopulateProviderIconCache,
    clearProviderIconCache,
    getIconCacheStats,
    resolveLogosForChannels,
    invalidateEpgLogosCache
};