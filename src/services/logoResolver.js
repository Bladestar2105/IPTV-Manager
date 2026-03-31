import db from '../database/db.js';
import epgDb from '../database/epgDb.js';
import crypto from 'crypto';

// Cache for EPG logos: Map<epg_channel_id, logo_url>
let epgLogosCache = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 300000; // 5 minutes

// Provider-specific logo cache: Map<provider_id, Map<epg_channel_id, logo_url>>
const providerLogoCache = new Map();

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
 * Get a cache key for provider-specific logo caching
 * This ensures that channels from the same provider share the same cached logo
 * @param {number} providerId - Provider ID
 * @param {string} logoUrl - Original logo URL
 * @returns {string} - Cache key for the picon
 */
export function getPiconCacheKey(providerId, logoUrl) {
    if (!logoUrl) return null;
    // Create a hash that includes provider ID for deduplication
    // Channels with same provider and same logo URL will share the cached file
    const hash = crypto.createHash('md5').update(logoUrl).digest('hex');
    return hash; // The proxy endpoint already uses MD5 of URL for caching
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
    providerLogoCache.clear();
    console.log('🔄 EPG logos cache invalidated');
}

export default {
    loadEpgLogosCache,
    resolveChannelLogo,
    getEpgLogo,
    getPiconCacheKey,
    resolveLogosForChannels,
    invalidateEpgLogosCache
};