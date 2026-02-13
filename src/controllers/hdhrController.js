import db from '../database/db.js';
import { getXtreamUser } from '../services/authService.js';

export const discover = async (req, res) => {
  try {
    // getXtreamUser now supports req.params.token (checking hdhr_token)
    const user = await getXtreamUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!user.hdhr_enabled) {
        return res.status(403).json({ error: 'HDHomeRun emulation is disabled for this user' });
    }

    const deviceID = `1234${user.id.toString(16).padStart(4, '0')}`; // Simple unique ID
    // BaseURL uses the token, shielding the username/password
    const baseURL = `${req.protocol}://${req.get('host')}/hdhr/${user.hdhr_token}`;

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
    if (!user.hdhr_enabled) return res.status(403).json({ error: 'Disabled' });

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
    if (!user.hdhr_enabled) return res.status(403).json({ error: 'Disabled' });

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
      WHERE cat.user_id = ? AND pc.stream_type = 'live'
      ORDER BY uc.sort_order
    `).all(user.id);

    const host = `${req.protocol}://${req.get('host')}`;
    const result = [];

    channels.forEach((ch, index) => {
      const streamUrl = `${host}/hdhr/${user.hdhr_token}/stream/${ch.user_channel_id}.ts`;

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
    if (!user.hdhr_enabled) return res.status(403).send('Disabled');

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
    let typePath = 'stream'; // maps to proxyLive

    if (channel.stream_type === 'movie') {
        typePath = 'movie'; // maps to proxyMovie
        ext = channel.mime_type || 'mp4';
    }

    const host = `${req.protocol}://${req.get('host')}`;
    // Redirect to the tokenized stream URL which is handled by streamController via mapped routes
    const streamUrl = `${host}/hdhr/${user.hdhr_token}/${typePath}/${channel.user_channel_id}.${ext}`;

    res.redirect(streamUrl);

  } catch (e) {
    console.error('HDHR auto error:', e);
    res.status(500).send('Internal Server Error');
  }
};

export const deviceXml = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) {
      return res.status(401).send('Unauthorized');
    }
    if (!user.hdhr_enabled) {
      return res.status(403).send('Disabled');
    }

    const deviceID = `1234${user.id.toString(16).padStart(4, '0')}`;
    const baseURL = `${req.protocol}://${req.get('host')}/hdhr/${user.hdhr_token}`;
    const friendlyName = `IPTV Manager (${user.username})`;

    const escapeXml = (unsafe) => {
        return unsafe.replace(/[<>&'"]/g, function (c) {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
            }
        });
    };

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${escapeXml(friendlyName)}</friendlyName>
    <manufacturer>Silicondust</manufacturer>
    <modelName>HDHR4-2US</modelName>
    <modelNumber>HDHR4-2US</modelNumber>
    <serialNumber>${deviceID}</serialNumber>
    <UDN>uuid:${deviceID}</UDN>
    <presentationURL>${baseURL}</presentationURL>
    <URLBase>${baseURL}/</URLBase>
  </device>
</root>`;

    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (e) {
    console.error('HDHR deviceXml error:', e);
    res.status(500).send('Internal Server Error');
  }
};
