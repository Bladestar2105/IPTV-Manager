/**
 * M3U Playlist Parser
 * Parses M3U files with support for Xtream/VLC/Kodi extensions.
 */
import readline from 'readline';

export function parseM3u(content) {
  const lines = content.split('\n');
  const channels = [];
  const categories = new Map();

  let currentChannel = {};
  let currentHeaders = {};
  let currentDrm = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      // New channel start - reset temp objects
      currentChannel = {};
      currentHeaders = {};
      currentDrm = {};

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

      currentChannel.name = title;

      // Parse Attributes
      parseAttributes(attrs, currentChannel);

      // Add to categories
      if (currentChannel.group) {
          const catName = currentChannel.group;
          // Simple ID generation for category
          if (!categories.has(catName)) {
              categories.set(catName, {
                  category_id: categories.size + 1,
                  category_name: catName,
                  category_type: 'live' // Assume live for M3U import
              });
          }
      }

    } else if (line.startsWith('#EXTVLCOPT:')) {
      // VLC Options (often used for headers)
      // Format: #EXTVLCOPT:http-user-agent=Mozilla...
      const opt = line.substring(11).trim();
      const parts = opt.split('=');
      const key = parts[0].toLowerCase();
      const val = parts.slice(1).join('=');

      if (key === 'http-user-agent') currentHeaders['User-Agent'] = val;
      if (key === 'http-referrer' || key === 'http-referer') currentHeaders['Referer'] = val;
      // Generic header support? e.g. http-header-key=val

    } else if (line.startsWith('#KODIPROP:')) {
      // Kodi Properties (DRM, Headers)
      // Format: #KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
      const prop = line.substring(10).trim();
      const parts = prop.split('=');
      const key = parts[0];
      const val = parts.slice(1).join('=');

      if (key === 'inputstream.adaptive.license_type') currentDrm.license_type = val;
      if (key === 'inputstream.adaptive.license_key') currentDrm.license_key = val;

      // Headers in KODIPROP? usually inputstream.adaptive.manifest_headers
      if (key === 'inputstream.adaptive.manifest_headers') {
          // Format: Header=Value&Header2=Value2 or similar?
          // Kodi docs say: "header=value&header2=value2" url encoded
          const headers = val.split('&');
          headers.forEach(h => {
             const hParts = h.split('=');
             if (hParts.length >= 2) {
                 const hKey = decodeURIComponent(hParts[0]);
                 const hVal = decodeURIComponent(hParts.slice(1).join('='));
                 currentHeaders[hKey] = hVal;
             }
          });
      }

    } else if (!line.startsWith('#')) {
      // URL Line - Finalize channel
      if (currentChannel.name) {
        currentChannel.url = line;

        // Populate Metadata
        const metadata = {};
        if (Object.keys(currentHeaders).length > 0) metadata.http_headers = currentHeaders;
        if (Object.keys(currentDrm).length > 0) metadata.drm = currentDrm;

        currentChannel.metadata = metadata;
        currentChannel.category_id = currentChannel.group ? categories.get(currentChannel.group).category_id : 0;

        // Detect Type
        if (line.includes('.mpd')) currentChannel.stream_type = 'live'; // Treat MPD as live for now
        else if (line.includes('/movie/') || line.endsWith('.mp4') || line.endsWith('.mkv')) currentChannel.stream_type = 'movie';
        else if (line.includes('/series/')) currentChannel.stream_type = 'series';
        else currentChannel.stream_type = 'live';

        // Store original line info if needed, but we have url

        channels.push(currentChannel);

        // Reset
        currentChannel = {};
        currentHeaders = {};
        currentDrm = {};
      }
    }
  }

  return {
    channels,
    categories: Array.from(categories.values())
  };
}

export function parseM3uStream(readableStream) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: readableStream,
      crlfDelay: Infinity
    });

    const channels = [];
    const categories = new Map();

    let currentChannel = {};
    let currentHeaders = {};
    let currentDrm = {};
    let isM3u = false;
    let firstLine = true;

    rl.on('line', (rawLine) => {
        let line = rawLine.replace(/^\uFEFF/, '').trim();
        if (!line) return;

        if (firstLine) {
            firstLine = false;
            if (line.startsWith('#EXTM3U')) {
                isM3u = true;
            }
        }

        if (line.startsWith('#EXTINF:')) {
            // New channel start - reset temp objects
            currentChannel = {};
            currentHeaders = {};
            currentDrm = {};

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

            currentChannel.name = title;

            // Parse Attributes
            parseAttributes(attrs, currentChannel);

            // Add to categories
            if (currentChannel.group) {
                const catName = currentChannel.group;
                // Simple ID generation for category
                if (!categories.has(catName)) {
                    categories.set(catName, {
                        category_id: categories.size + 1,
                        category_name: catName,
                        category_type: 'live' // Assume live for M3U import
                    });
                }
            }

        } else if (line.startsWith('#EXTVLCOPT:')) {
            const opt = line.substring(11).trim();
            const parts = opt.split('=');
            const key = parts[0].toLowerCase();
            const val = parts.slice(1).join('=');

            if (key === 'http-user-agent') currentHeaders['User-Agent'] = val;
            if (key === 'http-referrer' || key === 'http-referer') currentHeaders['Referer'] = val;

        } else if (line.startsWith('#KODIPROP:')) {
            const prop = line.substring(10).trim();
            const parts = prop.split('=');
            const key = parts[0];
            const val = parts.slice(1).join('=');

            if (key === 'inputstream.adaptive.license_type') currentDrm.license_type = val;
            if (key === 'inputstream.adaptive.license_key') currentDrm.license_key = val;

            if (key === 'inputstream.adaptive.manifest_headers') {
                const headers = val.split('&');
                headers.forEach(h => {
                   const hParts = h.split('=');
                   if (hParts.length >= 2) {
                       const hKey = decodeURIComponent(hParts[0]);
                       const hVal = decodeURIComponent(hParts.slice(1).join('='));
                       currentHeaders[hKey] = hVal;
                   }
                });
            }

        } else if (!line.startsWith('#')) {
            // URL Line - Finalize channel
            if (currentChannel.name) {
              currentChannel.url = line;

              // Populate Metadata
              const metadata = {};
              if (Object.keys(currentHeaders).length > 0) metadata.http_headers = currentHeaders;
              if (Object.keys(currentDrm).length > 0) metadata.drm = currentDrm;

              currentChannel.metadata = metadata;
              currentChannel.category_id = currentChannel.group ? categories.get(currentChannel.group).category_id : 0;

              // Detect Type
              if (line.includes('.mpd')) currentChannel.stream_type = 'live';
              else if (line.includes('/movie/') || line.endsWith('.mp4') || line.endsWith('.mkv')) currentChannel.stream_type = 'movie';
              else if (line.includes('/series/')) currentChannel.stream_type = 'series';
              else currentChannel.stream_type = 'live';

              channels.push(currentChannel);

              // Reset
              currentChannel = {};
              currentHeaders = {};
              currentDrm = {};
            }
        }
    });

    rl.on('close', () => {
        resolve({
            channels,
            categories: Array.from(categories.values()),
            isM3u
        });
    });

    rl.on('error', (err) => {
        reject(err);
    });
  });
}

function parseAttributes(attrs, currentChannel) {
  const attrRegex = /([a-zA-Z0-9-]+)="([^"]*)"/g;
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
