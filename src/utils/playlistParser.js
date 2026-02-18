/**
 * M3U Playlist Parser
 * Parses M3U files with support for Xtream/VLC/Kodi extensions.
 */
import readline from 'readline';

class M3uParser {
  constructor() {
    this.channels = [];
    this.categories = new Map();
    this.currentChannel = {};
    this.currentHeaders = {};
    this.currentDrm = {};
    this.isM3u = false;
    this.firstLine = true;
  }

  processLine(line) {
    if (!line) return;

    if (this.firstLine) {
      this.firstLine = false;
      if (line.startsWith('#EXTM3U')) {
        this.isM3u = true;
        return;
      }
    }

    if (line.startsWith('#EXTINF:')) {
      this.resetCurrent();

      const info = line.substring(8);
      const commaIndex = info.lastIndexOf(',');
      let attrs = '';
      let title = '';

      if (commaIndex !== -1) {
        attrs = info.substring(0, commaIndex);
        title = info.substring(commaIndex + 1).trim();
      } else {
        attrs = info;
      }

      this.currentChannel.name = title;
      parseAttributes(attrs, this.currentChannel);

      if (this.currentChannel.group) {
        const catName = this.currentChannel.group;
        if (!this.categories.has(catName)) {
          this.categories.set(catName, {
            category_id: this.categories.size + 1,
            category_name: catName,
            category_type: 'live'
          });
        }
      }
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.substring(11).trim();
      const parts = opt.split('=');
      const key = parts[0].toLowerCase();
      const val = parts.slice(1).join('=');

      if (key === 'http-user-agent') this.currentHeaders['User-Agent'] = val;
      if (key === 'http-referrer' || key === 'http-referer') this.currentHeaders['Referer'] = val;
    } else if (line.startsWith('#KODIPROP:')) {
      const prop = line.substring(10).trim();
      const parts = prop.split('=');
      const key = parts[0];
      const val = parts.slice(1).join('=');

      if (key === 'inputstream.adaptive.license_type') this.currentDrm.license_type = val;
      if (key === 'inputstream.adaptive.license_key') this.currentDrm.license_key = val;

      if (key === 'inputstream.adaptive.manifest_headers') {
        const headers = val.split('&');
        headers.forEach(h => {
          const hParts = h.split('=');
          if (hParts.length >= 2) {
            const hKey = decodeURIComponent(hParts[0]);
            const hVal = decodeURIComponent(hParts.slice(1).join('='));
            this.currentHeaders[hKey] = hVal;
          }
        });
      }
    } else if (!line.startsWith('#')) {
      if (this.currentChannel.name) {
        this.currentChannel.url = line;

        const metadata = {};
        if (Object.keys(this.currentHeaders).length > 0) metadata.http_headers = this.currentHeaders;
        if (Object.keys(this.currentDrm).length > 0) metadata.drm = this.currentDrm;

        this.currentChannel.metadata = metadata;
        this.currentChannel.category_id = this.currentChannel.group ? this.categories.get(this.currentChannel.group).category_id : 0;

        if (line.includes('.mpd')) this.currentChannel.stream_type = 'live';
        else if (line.includes('/movie/') || line.endsWith('.mp4') || line.endsWith('.mkv')) this.currentChannel.stream_type = 'movie';
        else if (line.includes('/series/')) this.currentChannel.stream_type = 'series';
        else this.currentChannel.stream_type = 'live';

        this.channels.push(this.currentChannel);
        this.resetCurrent();
      }
    }
  }

  resetCurrent() {
    this.currentChannel = {};
    this.currentHeaders = {};
    this.currentDrm = {};
  }

  getResult() {
    return {
      channels: this.channels,
      categories: Array.from(this.categories.values()),
      isM3u: this.isM3u
    };
  }
}

export function parseM3u(content) {
  const parser = new M3uParser();

  let start = 0;
  let end = 0;
  const len = content.length;

  while (start < len) {
    end = content.indexOf('\n', start);
    if (end === -1) end = len;

    const line = content.substring(start, end).replace(/^\uFEFF/, '').trim();
    start = end + 1;

    parser.processLine(line);
  }

  const result = parser.getResult();
  return {
    channels: result.channels,
    categories: result.categories
  };
}

export function parseM3uStream(readableStream) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: readableStream,
      crlfDelay: Infinity
    });

    const parser = new M3uParser();

    rl.on('line', (rawLine) => {
        const line = rawLine.replace(/^\uFEFF/, '').trim();
        parser.processLine(line);
    });

    rl.on('close', () => {
        resolve(parser.getResult());
    });

    rl.on('error', (err) => {
        reject(err);
    });
  });
}

// Optimization: Compile regex once and reuse. Safe as function is synchronous.
const attrRegex = /([a-zA-Z0-9-]+)="([^"]*)"/g;

function parseAttributes(attrs, currentChannel) {
  attrRegex.lastIndex = 0;
  let match;
  while ((match = attrRegex.exec(attrs)) !== null) {
      const key = match[1];
      const val = match[2];

      if (key === 'group-title') currentChannel.group = val;
      else if (key === 'tvg-logo') currentChannel.logo = val;
      else if (key === 'tvg-id') currentChannel.epg_id = val;
      else if (key === 'tvg-name') currentChannel.tvg_name = val;
  }
}
