import db from '../database/db.js';
import { getXtreamUser } from '../services/authService.js';
import { PORT } from '../config/constants.js';

export const discover = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const deviceID = `1234${user.id.toString(16).padStart(4, '0')}`; // Simple unique ID
    const baseURL = `${req.protocol}://${req.get('host')}/hdhr/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password)}`;

    res.json({
      FriendlyName: `IPTV Manager (${user.username})`,
      ModelNumber: 'HDHR4-2US',
      FirmwareName: 'hdhomerun4_atsc',
      TunerCount: 3,
      DeviceID: deviceID,
      DeviceAuth: 'test',
      BaseURL: baseURL,
      LineupURL: `${baseURL}/lineup.json`
    });
  } catch (e) {
    console.error('HDHR discover error:', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const lineupStatus = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    res.json({
      ScanInProgress: 0,
      ScanPossible: 1,
      Source: "Cable",
      SourceList: ["Cable"]
    });
  } catch (e) {
    console.error('HDHR lineupStatus error:', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const lineup = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const channels = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.name,
        pc.stream_type,
        pc.mime_type,
        cat.name as category_name
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE cat.user_id = ? AND pc.stream_type != 'series'
      ORDER BY uc.sort_order
    `).all(user.id);

    const host = `${req.protocol}://${req.get('host')}`;
    const result = [];

    channels.forEach((ch, index) => {
      let ext = 'ts';
      let typePath = 'live';

      if (ch.stream_type === 'movie') {
         typePath = 'movie';
         ext = ch.mime_type || 'mp4';
      } else if (ch.stream_type === 'series') {
         typePath = 'series'; // Though query excludes series usually
         ext = ch.mime_type || 'mp4';
      }

      const streamUrl = `${host}/${typePath}/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password)}/${ch.user_channel_id}.${ext}`;

      result.push({
        GuideNumber: String(index + 1),
        GuideName: ch.name,
        URL: streamUrl
      });
    });

    res.json(result);
  } catch (e) {
    console.error('HDHR lineup error:', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const auto = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) {
      return res.status(401).send('Unauthorized');
    }

    const channelId = req.params.channelId;
    if (!channelId) return res.status(400).send('Bad Request');

    // Verify channel belongs to user
    const channel = db.prepare(`
      SELECT uc.id as user_channel_id, pc.stream_type, pc.mime_type
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE uc.id = ? AND cat.user_id = ?
    `).get(channelId, user.id);

    if (!channel) return res.status(404).send('Channel not found');

    let ext = 'ts';
    let typePath = 'live';

    if (channel.stream_type === 'movie') {
        typePath = 'movie';
        ext = channel.mime_type || 'mp4';
    }

    const host = `${req.protocol}://${req.get('host')}`;
    const streamUrl = `${host}/${typePath}/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password)}/${channel.user_channel_id}.${ext}`;

    res.redirect(streamUrl);

  } catch (e) {
    console.error('HDHR auto error:', e);
    res.status(500).send('Internal Server Error');
  }
};
