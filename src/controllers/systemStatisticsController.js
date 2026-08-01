import db from '../database/db.js';
import streamManager from '../services/streamManager.js';
import si from 'systeminformation';
import { getEpgLogo, loadEpgLogosCache } from '../services/logoResolver.js';

let initialNetStats = null;
si.networkStats().then(stats => {
  const primaryNet = stats.find(net => net.operstate === 'up') || stats[0] || {};
  initialNetStats = {
    rx_bytes: primaryNet.rx_bytes || 0,
    tx_bytes: primaryNet.tx_bytes || 0
  };
}).catch(() => {
  initialNetStats = { rx_bytes: 0, tx_bytes: 0 };
});

export const getStatistics = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});

    // Load EPG logos cache for logo resolution
    loadEpgLogosCache();

    const topChannels = db.prepare(`
      SELECT ss.views, ss.last_viewed, pc.name, pc.logo, pc.epg_channel_id,
             map.epg_channel_id as manual_epg_id, p.use_mapped_epg_icon
      FROM stream_stats ss
      JOIN provider_channels pc ON pc.id = ss.channel_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      LEFT JOIN providers p ON p.id = pc.provider_id
      ORDER BY ss.views DESC
      LIMIT 10
    `).all();

    // Resolve EPG logos for top channels
    const topChannelsWithLogos = topChannels.map(ch => {
      const epgId = ch.manual_epg_id || ch.epg_channel_id;
      let logo = ch.logo;
      if (ch.use_mapped_epg_icon && epgId) {
        const epgLogo = getEpgLogo(epgId);
        if (epgLogo) logo = epgLogo;
      }
      return { ...ch, logo };
    });

    const allStreams = await streamManager.getAll();

    // ⚡ Bolt: Hoist the prepared statement outside the loop to prevent parsing/compiling the SQL on every iteration.
    // This provides a massive speedup without the memory overhead of fetching tens of thousands of channels.
    const getChannelStmt = db.prepare(`
      SELECT pc.logo, pc.epg_channel_id, map.epg_channel_id as manual_epg_id, p.use_mapped_epg_icon
      FROM provider_channels pc
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      LEFT JOIN providers p ON p.id = pc.provider_id
      WHERE pc.name = ? AND pc.provider_id = ? LIMIT 1
    `);
    const channelCache = new Map();

    const streams = allStreams.map(s => {
      // Find logo if possible (for Active Streams)
      let logo = null;
      if (s.channel_name && s.provider_id) {
          const cacheKey = `${s.provider_id}:${s.channel_name}`;
          let ch = channelCache.get(cacheKey);
          if (!channelCache.has(cacheKey)) {
            ch = getChannelStmt.get(s.channel_name, s.provider_id) || null;
            channelCache.set(cacheKey, ch);
          }
          if (ch) {
            logo = ch.logo;
            // Try to resolve EPG logo if provider has use_mapped_epg_icon enabled
            if (ch.use_mapped_epg_icon) {
              const epgId = ch.manual_epg_id || ch.epg_channel_id;
              if (epgId) {
                const epgLogo = getEpgLogo(epgId);
                if (epgLogo) logo = epgLogo;
              }
            }
          }
      }
      return {
        ...s,
        logo: logo,
        duration: Math.floor((Date.now() - s.start_time) / 1000)
      };
    });

    const [cpuLoad, cpuInfo, memInfo, fsSize, netStats] = await Promise.all([
      si.currentLoad(),
      si.cpu(),
      si.mem(),
      si.fsSize(),
      si.networkStats()
    ]);

    const primaryFs = fsSize.find(fs => fs.mount === '/') || fsSize[0] || {};
    const primaryNet = netStats.find(net => net.operstate === 'up') || netStats[0] || {};

    // Calculate total bandwidth since app start
    let rxTotal = primaryNet.rx_bytes || 0;
    let txTotal = primaryNet.tx_bytes || 0;
    if (initialNetStats) {
       rxTotal = Math.max(0, rxTotal - initialNetStats.rx_bytes);
       txTotal = Math.max(0, txTotal - initialNetStats.tx_bytes);
    }

    const systemInfo = {
      cpu: {
        utilization: cpuLoad.currentLoad.toFixed(2),
        cores: cpuInfo.cores || cpuLoad.cpus.length
      },
      memory: {
        total: memInfo.total,
        used: memInfo.active,
        free: memInfo.available,
        utilization: ((memInfo.active / memInfo.total) * 100).toFixed(2)
      },
      hdd: {
        total: primaryFs.size || 0,
        used: primaryFs.used || 0,
        free: (primaryFs.size || 0) - (primaryFs.used || 0),
        utilization: primaryFs.use ? primaryFs.use.toFixed(2) : '0.00'
      },
      bandwidth: {
        rx_sec: primaryNet.rx_sec || 0,
        tx_sec: primaryNet.tx_sec || 0,
        rx_total: rxTotal,
        tx_total: txTotal
      }
    };

    res.json({
      active_streams: streams,
      top_channels: topChannelsWithLogos,
      system_info: systemInfo
    });
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const terminateActiveStream = async (req, res) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'Access denied' });

    const streamId = (req.params.streamId || '').trim();
    if (!streamId) return res.status(400).json({ error: 'Stream ID required' });

    const allStreams = await streamManager.getAll();
    const stream = allStreams.find(s => s.id === streamId);
    if (!stream) return res.status(404).json({ error: 'Stream not found' });

    // If the stream belongs to this worker, terminate directly.
    if (!stream.worker_pid || stream.worker_pid === process.pid) {
      await streamManager.remove(streamId);
      return res.json({ success: true });
    }

    // In cluster mode, ask primary process to forward the terminate command
    // to the worker that owns this stream resource.
    if (typeof process.send === 'function') {
      process.send({
        type: 'terminate_stream',
        streamId,
        targetPid: stream.worker_pid
      });
      return res.json({ success: true, forwarded: true });
    }

    // Single-process fallback.
    await streamManager.remove(streamId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const resetStatistics = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    db.prepare('DELETE FROM stream_stats').run();
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};
