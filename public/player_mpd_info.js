(function(root) {
  'use strict';

  function toArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function clean(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  function readAttr(source, key) {
    if (!source) return '';
    if (typeof source.getAttribute === 'function') return clean(source.getAttribute(key));
    return clean(source[key]);
  }

  function trimNumber(value) {
    var rounded = Math.round(value * 10) / 10;
    return String(rounded).replace(/\.0$/, '');
  }

  function parseIsoDurationSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    var text = clean(value);
    if (!text) return null;
    var numeric = Number(text);
    if (Number.isFinite(numeric)) return numeric;

    var match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(text);
    if (!match) return null;

    var days = Number(match[1] || 0);
    var hours = Number(match[2] || 0);
    var minutes = Number(match[3] || 0);
    var seconds = Number(match[4] || 0);
    return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
  }

  function formatDuration(value) {
    var seconds = parseIsoDurationSeconds(value);
    if (seconds === null) return clean(value);
    seconds = Math.max(0, Math.round(seconds));

    var parts = [];
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secs = seconds % 60;
    if (hours) parts.push(hours + 'h');
    if (minutes) parts.push(minutes + 'm');
    if (secs || parts.length === 0) parts.push(secs + 's');
    return parts.join(' ');
  }

  function formatBandwidth(value) {
    var bandwidth = Number(value);
    if (!Number.isFinite(bandwidth) || bandwidth <= 0) return clean(value);
    if (bandwidth >= 1000000) return trimNumber(bandwidth / 1000000) + ' Mbps';
    return trimNumber(bandwidth / 1000) + ' kbps';
  }

  function contentKind(set, rep) {
    var contentType = readAttr(set, 'contentType') || readAttr(rep, 'contentType');
    var mimeType = readAttr(rep, 'mimeType') || readAttr(set, 'mimeType');
    var text = (contentType + ' ' + mimeType).toLowerCase();
    if (text.includes('video')) return 'video';
    if (text.includes('audio')) return 'audio';
    if (readAttr(rep, 'width') || readAttr(rep, 'height')) return 'video';
    return '';
  }

  function trackInfo(set, rep, kind) {
    var codec = readAttr(rep, 'codecs') || readAttr(set, 'codecs');
    var bandwidth = formatBandwidth(readAttr(rep, 'bandwidth') || readAttr(set, 'bandwidth'));
    var info = {
      codec: codec,
      bandwidth: bandwidth
    };

    if (kind === 'video') {
      var width = readAttr(rep, 'width') || readAttr(set, 'width');
      var height = readAttr(rep, 'height') || readAttr(set, 'height');
      info.resolution = width && height ? width + 'x' + height : '';
    } else if (kind === 'audio') {
      info.language = readAttr(rep, 'lang') || readAttr(set, 'lang') || readAttr(rep, 'language') || readAttr(set, 'language');
    }

    return info;
  }

  function pushUnique(list, item, key) {
    if (!key || list.length >= 6) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i]._key === key) return;
    }
    item._key = key;
    list.push(item);
  }

  function stripKeys(list) {
    return list.map(function(item) {
      var copy = {};
      Object.keys(item).forEach(function(key) {
        if (key !== '_key') copy[key] = item[key];
      });
      return copy;
    });
  }

  function normalize(summary) {
    return {
      type: clean(summary.type) || 'static',
      duration: formatDuration(summary.duration),
      minBufferTime: formatDuration(summary.minBufferTime),
      profiles: clean(summary.profiles),
      periods: summary.periods || 0,
      adaptationSets: summary.adaptationSets || 0,
      representations: summary.representations || 0,
      video: stripKeys(summary.video || []),
      audio: stripKeys(summary.audio || [])
    };
  }

  function summarizeSets(mpdAttrs, periods, sets, allRepresentations) {
    var video = [];
    var audio = [];

    sets.forEach(function(set) {
      var reps = toArray(set.Representation || set.representations || set.representation);
      reps.forEach(function(rep) {
        var kind = contentKind(set, rep);
        if (kind === 'video') {
          var v = trackInfo(set, rep, kind);
          pushUnique(video, v, [v.resolution, v.codec, v.bandwidth].join('|'));
        } else if (kind === 'audio') {
          var a = trackInfo(set, rep, kind);
          pushUnique(audio, a, [a.language, a.codec, a.bandwidth].join('|'));
        }
      });
    });

    return normalize({
      type: readAttr(mpdAttrs, 'type'),
      duration: readAttr(mpdAttrs, 'mediaPresentationDuration'),
      minBufferTime: readAttr(mpdAttrs, 'minBufferTime'),
      profiles: readAttr(mpdAttrs, 'profiles'),
      periods: periods.length,
      adaptationSets: sets.length,
      representations: allRepresentations.length,
      video: video,
      audio: audio
    });
  }

  function fromDashManifest(manifest) {
    var periods = toArray(manifest.Period || manifest.periods);
    var sets = [];
    var reps = [];

    periods.forEach(function(period) {
      var periodSets = toArray(period.AdaptationSet || period.adaptationSets || period.adaptationSet);
      periodSets.forEach(function(set) {
        sets.push(set);
        reps = reps.concat(toArray(set.Representation || set.representations || set.representation));
      });
    });

    if (sets.length === 0) {
      sets = toArray(manifest.AdaptationSet || manifest.adaptationSets || manifest.adaptationSet);
      sets.forEach(function(set) {
        reps = reps.concat(toArray(set.Representation || set.representations || set.representation));
      });
    }

    return summarizeSets(manifest, periods, sets, reps);
  }

  function getElements(source, name) {
    if (!source || typeof source.getElementsByTagName !== 'function') return [];
    var items = Array.prototype.slice.call(source.getElementsByTagName(name));
    if (items.length || typeof source.getElementsByTagNameNS !== 'function') return items;
    return Array.prototype.slice.call(source.getElementsByTagNameNS('*', name));
  }

  function parseXmlWithDom(xmlText) {
    var parser = new root.DOMParser();
    var doc = parser.parseFromString(xmlText, 'application/xml');
    if (getElements(doc, 'parsererror').length) throw new Error('Invalid MPD XML');
    var mpd = doc.documentElement;
    if (!mpd || String(mpd.localName || mpd.nodeName).replace(/^.*:/, '') !== 'MPD') {
      throw new Error('MPD root not found');
    }

    var periods = getElements(doc, 'Period');
    var sets = getElements(doc, 'AdaptationSet');
    var reps = getElements(doc, 'Representation');

    sets.forEach(function(set) {
      set.Representation = getElements(set, 'Representation');
    });

    return summarizeSets(mpd, periods, sets, reps);
  }

  function readAttributes(text) {
    var attrs = {};
    var re = /([A-Za-z0-9_:.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var match;
    while ((match = re.exec(text))) {
      attrs[match[1].replace(/^.*:/, '')] = match[2] !== undefined ? match[2] : match[3];
    }
    return attrs;
  }

  function collectTags(xmlText, name) {
    var re = new RegExp('<(?:[A-Za-z0-9_.-]+:)?' + name + '\\b([^>]*)>', 'gi');
    var tags = [];
    var match;
    while ((match = re.exec(xmlText))) {
      tags.push(readAttributes(match[1] || ''));
    }
    return tags;
  }

  function collectAdaptationSets(xmlText) {
    var re = /<(?:[A-Za-z0-9_.-]+:)?AdaptationSet\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?AdaptationSet>/gi;
    var sets = [];
    var match;
    while ((match = re.exec(xmlText))) {
      var set = readAttributes(match[1] || '');
      set.Representation = collectTags(match[2] || '', 'Representation');
      sets.push(set);
    }
    return sets;
  }

  function parseXmlWithText(xmlText) {
    var mpdTags = collectTags(xmlText, 'MPD');
    if (!mpdTags.length) throw new Error('MPD root not found');
    var periods = collectTags(xmlText, 'Period');
    var sets = collectAdaptationSets(xmlText);
    var reps = collectTags(xmlText, 'Representation');
    return summarizeSets(mpdTags[0], periods, sets, reps);
  }

  function parseXml(xmlText) {
    if (!clean(xmlText)) throw new Error('MPD XML is empty');
    if (typeof root.DOMParser === 'function') return parseXmlWithDom(xmlText);
    return parseXmlWithText(xmlText);
  }

  root.IPTVPlayerMpdInfo = {
    parseXml: parseXml,
    fromDashManifest: fromDashManifest,
    formatDuration: formatDuration,
    formatBandwidth: formatBandwidth
  };
})(typeof window !== 'undefined' ? window : globalThis);
