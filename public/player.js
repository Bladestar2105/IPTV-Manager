(function() {
  'use strict';

  // ─── Credentials ───
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const username = urlParams.get('username');
  const password = urlParams.get('password');

  if (!token && (!username || !password)) {
    document.body.innerHTML = '<div class="alert alert-danger m-4">' + t('missingCredentials') + '</div>';
    throw new Error('Missing credentials');
  }

  // ─── State ───
  let currentType = 'live';
  let allChannels = [];
  let currentChannels = [];
  let epgSchedule = {};
  let activeStream = null;
  let castSession = null;
  let hls = null;
  let flvPlayer = null;
  let dashPlayer = null;
  let isRetrying = false;
  let retryCount = 0;
  const MAX_RETRIES = 3;

  const video = document.getElementById('video');

  // ─── Timeline Config ───
  const PIXELS_PER_MINUTE = 4;
  const ROW_HEIGHT = 48;
  const TIMELINE_HOURS = 24;
  let timelineStart = Math.floor(Date.now() / 1000) - 3600;
  timelineStart = timelineStart - (timelineStart % 1800);

  // ─── DOM Elements ───
  const catSelect = document.getElementById('category-select');
  const searchInput = document.getElementById('search-input');
  const sidebarEl = document.getElementById('channel-sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const epgGridEl = document.getElementById('epg-grid');
  const epgRowsEl = document.getElementById('epg-rows');
  const timeHeaderEl = document.getElementById('time-header');
  const loadingEl = document.getElementById('loading-overlay');
  const currentTimeIndicator = document.getElementById('current-time-indicator');
  const timelineView = document.getElementById('timeline-view');
  const listView = document.getElementById('list-view');
  const nowPlayingChannel = document.getElementById('now-playing-channel');
  const nowPlayingProgram = document.getElementById('now-playing-program');
  const playerStatus = document.getElementById('player-status');
  const tooltip = document.getElementById('program-tooltip');

  // ─── Platform Detection ───
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const hasNativeHLS = video.canPlayType('application/vnd.apple.mpegurl') !== '';
  const hasMSE = typeof MediaSource !== 'undefined';

  console.log('Platform: iOS=' + isIOS + ', Safari=' + isSafari + ', Mobile=' + isMobile + ', NativeHLS=' + hasNativeHLS + ', MSE=' + hasMSE);

  // ─── i18n ───
  function translatePage() {
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    document.title = t('playerTitle');
  }
  translatePage();

  function getProxiedUrl(url) {
    if (!url) return '';
    // If we are on HTTPS and the URL is HTTP, use proxy
    if (window.location.protocol === 'https:' && url.startsWith('http://')) {
      return `/api/proxy/image?url=${encodeURIComponent(url)}&token=${token}`;
    }
    return url;
  }

  // ─── Cast Integration ───
  window['__onGCastApiAvailable'] = function(isAvailable) {
    if (isAvailable) {
      cast.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
      });

      cast.framework.CastContext.getInstance().addEventListener(
        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        function(event) {
          switch (event.sessionState) {
            case cast.framework.SessionState.SESSION_STARTED:
            case cast.framework.SessionState.SESSION_RESUMED:
              castSession = event.session;
              if (activeStream) loadRemoteMedia(activeStream);
              break;
            case cast.framework.SessionState.SESSION_ENDED:
              castSession = null;
              if (activeStream) playStream(activeStream); // Resume local
              break;
          }
        }
      );
    }
  };

  function loadRemoteMedia(stream) {
    if (!castSession) return;
    destroyAllPlayers();
    setPlayerStatus('Casting', 'info');
    document.getElementById('player-container').classList.add('show-info'); // Show info bar

    var url = stream.url;
    if (token && !url.includes('token=')) {
      url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }
    var fullUrl = new URL(url, window.location.href).href;

    var contentType = 'application/x-mpegurl';
    if (fullUrl.includes('.mpd')) contentType = 'application/dash+xml';
    else if (fullUrl.includes('.mp4')) contentType = 'video/mp4';

    var mediaInfo = new chrome.cast.media.MediaInfo(fullUrl, contentType);
    mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = stream.name;
    if (nowPlayingProgram && nowPlayingProgram.textContent) {
      mediaInfo.metadata.subtitle = nowPlayingProgram.textContent;
    }
    if (stream.logo) {
      mediaInfo.metadata.images = [{url: new URL(stream.logo, window.location.href).href}];
    }

    var request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.autoplay = true;

    castSession.loadMedia(request).then(
      function() { console.log('Cast load success'); },
      function(e) { console.error('Cast load error', e); }
    );
  }

  // ─── Clock ───
  function updateClock() {
    document.getElementById('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  updateClock();
  setInterval(function() {
    updateClock();
    if (currentType === 'live') {
      updateCurrentTimeLine();
      updateNowPlayingInfo();
    }
  }, 30000);

  // ─── Auth Helper ───
  function getAuthParams() {
    if (token) return 'token=' + encodeURIComponent(token);
    return 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
  }

  // ─── Toast Notification ───
  function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    var existing = document.querySelector('.player-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'player-toast alert alert-' + type + ' mb-0';
    toast.textContent = message;
    document.getElementById('player-container').appendChild(toast);
    setTimeout(function() { toast.remove(); }, duration);
  }

  // ─── Status Badge ───
  function setPlayerStatus(text, color) {
    if (!text) { playerStatus.innerHTML = ''; return; }
    playerStatus.innerHTML = '<span class="badge bg-' + color + '">' + text + '</span>';
  }

  // ─── Init ───
  async function init() {
    loadingEl.style.display = 'flex';
    try {
      // 1. Fetch Playlist
      var res = await fetch('/api/player/playlist?' + getAuthParams());
      if (!res.ok) throw new Error('Playlist Fetch Error: ' + res.status);
      var text = await res.text();
      allChannels = parseM3U(text);
      console.log('Loaded ' + allChannels.length + ' channels');

      // 2. Fetch EPG Schedule
      var start = Math.floor(Date.now() / 1000) - 7200;
      var end = start + (TIMELINE_HOURS * 3600) + 7200;
      try {
        var epgRes = await fetch('/api/epg/schedule?start=' + start + '&end=' + end + '&' + getAuthParams());
        if (epgRes.ok) {
          epgSchedule = await epgRes.json();
          console.log('EPG loaded: ' + Object.keys(epgSchedule).length + ' channels with data');
        }
      } catch (e) {
        console.warn('EPG fetch failed:', e.message);
      }

      updateCategories();
      renderView();

      // Scroll to current time
      if (currentType === 'live') {
        requestAnimationFrame(function() {
          var now = Math.floor(Date.now() / 1000);
          var offset = ((now - timelineStart) / 60) * PIXELS_PER_MINUTE;
          epgGridEl.scrollLeft = Math.max(0, offset - (epgGridEl.clientWidth / 3));
          updateCurrentTimeLine();
        });
      }
    } catch (e) {
      console.error('Init error:', e);
      showToast(t('errorLoadingData') + ': ' + e.message, 'danger', 10000);
    } finally {
      loadingEl.style.display = 'none';
    }
  }

  // ─── M3U Parser ───
  function parseM3U(content) {
    var lines = content.split('\n');
    var result = [];
    var currentItem = {};

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        var info = line.substring(8);
        var commaIndex = info.lastIndexOf(',');
        var attrs = '', title = '';
        if (commaIndex !== -1) {
          attrs = info.substring(0, commaIndex);
          title = info.substring(commaIndex + 1).trim();
        } else {
          attrs = info;
        }

        currentItem = { name: title, group: 'Uncategorized', logo: '' };
        var matches = attrs.match(/([a-zA-Z0-9-]+)="([^"]*)"/g);
        if (matches) {
          matches.forEach(function(m) {
            var eqIdx = m.indexOf('=');
            var key = m.substring(0, eqIdx);
            var val = m.substring(eqIdx + 2, m.length - 1);
            if (key === 'group-title') currentItem.group = val;
            if (key === 'tvg-logo') currentItem.logo = val;
            if (key === 'tvg-id') currentItem.epg_id = val;
            if (key === 'plot') currentItem.plot = val;
          });
        }
      } else if (line.startsWith('#KODIPROP:')) {
        var prop = line.substring(10).trim();
        var eqIdx = prop.indexOf('=');
        if (eqIdx !== -1) {
          var key = prop.substring(0, eqIdx);
          var val = prop.substring(eqIdx + 1);
          if (!currentItem.drm) currentItem.drm = {};
          if (key === 'inputstream.adaptive.license_type') currentItem.drm.license_type = val;
          if (key === 'inputstream.adaptive.license_key') currentItem.drm.license_key = val;
        }
      } else if (!line.startsWith('#')) {
        if (currentItem.name) {
          currentItem.url = line;
          if (line.includes('/movie/')) currentItem.type = 'movie';
          else if (line.includes('/series/')) currentItem.type = 'series';
          else currentItem.type = 'live';
          result.push(currentItem);
          currentItem = {};
        }
      }
    }
    return result;
  }

  // ─── Categories ───
  function updateCategories() {
    var groups = new Set();
    allChannels.forEach(function(c) {
      if (c.type === currentType && c.group) groups.add(c.group);
    });
    catSelect.innerHTML = '<option value="">' + t('allCategories') + '</option>';
    Array.from(groups).sort().forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      catSelect.appendChild(opt);
    });
  }

  // ─── View Switching ───
  function renderView() {
    if (currentType === 'live') {
      timelineView.style.display = 'flex';
      listView.style.display = 'none';
      renderTimeline();
    } else {
      timelineView.style.display = 'none';
      listView.style.display = 'block';
      renderList();
    }
  }

  // ─── VOD List Renderer ───
  function renderList() {
    var catId = catSelect.value;
    var search = searchInput.value.toLowerCase();

    var filtered = allChannels.filter(function(s) {
      if (s.type !== currentType) return false;
      return (!catId || s.group === catId) && (!search || s.name.toLowerCase().includes(search));
    });

    listView.innerHTML = '';
    if (filtered.length === 0) {
      listView.innerHTML = '<div class="text-muted p-3">' + t('noResults', { search: search }) + '</div>';
      return;
    }

    var frag = document.createDocumentFragment();
    filtered.slice(0, 150).forEach(function(s) {
      var a = document.createElement('a');
      a.className = 'list-group-item list-group-item-action vod-item bg-dark text-light';

      var div = document.createElement('div');
      div.className = 'd-flex align-items-center';

      if (s.logo) {
        var img = document.createElement('img');
        img.src = getProxiedUrl(s.logo);
        img.style.cssText = 'width:40px;height:40px;object-fit:contain;margin-right:10px;border-radius:4px;background:#1a1a24;';
        img.loading = 'lazy';
        img.onerror = function() { img.style.display = 'none'; };
        div.appendChild(img);
      }

      var info = document.createElement('div');
      info.style.overflow = 'hidden';
      var name = document.createElement('div');
      name.className = 'fw-bold text-truncate';
      name.textContent = s.name;
      info.appendChild(name);
      if (s.plot) {
        var plot = document.createElement('div');
        plot.className = 'small text-muted text-truncate';
        plot.textContent = s.plot;
        info.appendChild(plot);
      }
      div.appendChild(info);
      a.appendChild(div);

      a.onclick = (function(stream, el) {
        return function() {
          document.querySelectorAll('.vod-item').forEach(function(e) { e.classList.remove('active'); });
          el.classList.add('active');
          playStream(stream);
        };
      })(s, a);
      frag.appendChild(a);
    });
    listView.appendChild(frag);
  }

  // ─── EPG Timeline Renderer ───
  function renderTimeline() {
    var catId = catSelect.value;
    var search = searchInput.value.toLowerCase();

    currentChannels = allChannels.filter(function(s) {
      if (s.type !== 'live') return false;
      return (!catId || s.group === catId) && (!search || s.name.toLowerCase().includes(search));
    });

    sidebarEl.innerHTML = '';
    epgRowsEl.innerHTML = '';
    timeHeaderEl.innerHTML = '';

    var headerWidth = TIMELINE_HOURS * 60 * PIXELS_PER_MINUTE;
    timeHeaderEl.style.width = headerWidth + 'px';

    // Time markers (every 30 min)
    for (var i = 0; i < TIMELINE_HOURS * 2; i++) {
      var tSec = timelineStart + (i * 1800);
      var date = new Date(tSec * 1000);
      var marker = document.createElement('div');
      marker.className = 'time-marker';
      marker.style.left = (i * 30 * PIXELS_PER_MINUTE) + 'px';
      if (i % 2 === 0) {
        marker.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      timeHeaderEl.appendChild(marker);
    }

    var fragSidebar = document.createDocumentFragment();
    var fragRows = document.createDocumentFragment();
    var now = Math.floor(Date.now() / 1000);
    var renderLimit = 200;

    currentChannels.slice(0, renderLimit).forEach(function(ch) {
      // Sidebar channel entry
      var rowDiv = document.createElement('div');
      rowDiv.className = 'channel-row';
      if (activeStream && activeStream.epg_id === ch.epg_id && activeStream.name === ch.name) {
        rowDiv.classList.add('active');
      }

      if (ch.logo) {
        var img = document.createElement('img');
        img.src = getProxiedUrl(ch.logo);
        img.loading = 'lazy';
        img.onerror = function() { this.style.display = 'none'; };
        rowDiv.appendChild(img);
      }

      var nameContainer = document.createElement('div');
      nameContainer.style.cssText = 'min-width:0;flex:1;';
      var nameSpan = document.createElement('div');
      nameSpan.className = 'channel-name';
      nameSpan.textContent = ch.name;
      nameContainer.appendChild(nameSpan);

      // Show current program under channel name
      var programs = epgSchedule[ch.epg_id] || [];
      var currentProg = null;
      for (var p = 0; p < programs.length; p++) {
        if (programs[p].start <= now && programs[p].stop >= now) {
          currentProg = programs[p];
          break;
        }
      }
      if (currentProg) {
        var epgNow = document.createElement('div');
        epgNow.className = 'channel-epg-now';
        epgNow.textContent = currentProg.title;
        nameContainer.appendChild(epgNow);
      }

      rowDiv.appendChild(nameContainer);

      rowDiv.onclick = (function(channel, row) {
        return function() {
          document.querySelectorAll('.channel-row').forEach(function(el) { el.classList.remove('active'); });
          row.classList.add('active');
          playStream(channel);
          if (isMobile) closeSidebar();
        };
      })(ch, rowDiv);

      fragSidebar.appendChild(rowDiv);

      // EPG Row
      var epgRow = document.createElement('div');
      epgRow.className = 'epg-row';
      epgRow.style.width = headerWidth + 'px';

      programs.forEach(function(prog) {
        var progStart = Math.max(prog.start, timelineStart);
        var progEnd = Math.min(prog.stop, timelineStart + TIMELINE_HOURS * 3600);
        if (progEnd <= timelineStart || progStart >= timelineStart + TIMELINE_HOURS * 3600) return;

        var startOffset = progStart - timelineStart;
        var duration = progEnd - progStart;
        var left = (startOffset / 60) * PIXELS_PER_MINUTE;
        var width = (duration / 60) * PIXELS_PER_MINUTE;

        if (width < 2) return;

        var bar = document.createElement('div');
        bar.className = 'program-bar';
        if (prog.start <= now && prog.stop >= now) bar.classList.add('current');

        bar.style.left = left + 'px';
        bar.style.width = Math.max(2, width - 2) + 'px';

        var timeStr = new Date(prog.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        var timeSpan = document.createElement('span');
        timeSpan.className = 'program-time';
        timeSpan.textContent = timeStr;

        var titleSpan = document.createElement('span');
        titleSpan.className = 'program-title';
        titleSpan.textContent = prog.title;

        bar.appendChild(timeSpan);
        bar.appendChild(titleSpan);

        // Tooltip on hover
        bar.addEventListener('mouseenter', (function(program) {
          return function(e) {
            var ttTitle = tooltip.querySelector('.tt-title');
            var ttTime = tooltip.querySelector('.tt-time');
            var ttDesc = tooltip.querySelector('.tt-desc');
            ttTitle.textContent = program.title;
            ttTime.textContent = new Date(program.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' \u2013 ' + new Date(program.stop * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            ttDesc.textContent = program.desc || '';
            tooltip.style.display = 'block';
            positionTooltip(e);
          };
        })(prog));
        bar.addEventListener('mousemove', positionTooltip);
        bar.addEventListener('mouseleave', function() { tooltip.style.display = 'none'; });

        // Click to play from EPG
        bar.addEventListener('click', (function(channel) {
          return function(e) {
            e.stopPropagation();
            document.querySelectorAll('.channel-row').forEach(function(el) { el.classList.remove('active'); });
            var sidebarRows = sidebarEl.querySelectorAll('.channel-row');
            var idx = currentChannels.indexOf(channel);
            if (idx >= 0 && sidebarRows[idx]) sidebarRows[idx].classList.add('active');
            playStream(channel);
          };
        })(ch));

        epgRow.appendChild(bar);
      });

      // If no EPG data, show empty clickable row
      if (programs.length === 0) {
        epgRow.style.cursor = 'pointer';
        epgRow.onclick = (function(channel) {
          return function() {
            document.querySelectorAll('.channel-row').forEach(function(el) { el.classList.remove('active'); });
            var sidebarRows = sidebarEl.querySelectorAll('.channel-row');
            var idx = currentChannels.indexOf(channel);
            if (idx >= 0 && sidebarRows[idx]) sidebarRows[idx].classList.add('active');
            playStream(channel);
          };
        })(ch);
      }

      fragRows.appendChild(epgRow);
    });

    sidebarEl.appendChild(fragSidebar);
    epgRowsEl.appendChild(fragRows);

    // Sync sidebar scroll with EPG grid
    epgGridEl.onscroll = function() {
      sidebarEl.scrollTop = epgGridEl.scrollTop;
    };

    updateCurrentTimeLine();
  }

  function positionTooltip(e) {
    var x = e.clientX + 12;
    var y = e.clientY + 12;
    if (x + 320 > window.innerWidth) x = e.clientX - 330;
    if (y + 150 > window.innerHeight) y = e.clientY - 160;
    tooltip.style.left = Math.max(0, x) + 'px';
    tooltip.style.top = Math.max(0, y) + 'px';
  }

  // ─── Current Time Line ───
  function updateCurrentTimeLine() {
    var now = Math.floor(Date.now() / 1000);
    var offset = now - timelineStart;
    if (offset >= 0) {
      var left = (offset / 60) * PIXELS_PER_MINUTE;
      currentTimeIndicator.style.left = left + 'px';
      var contentHeight = Math.max(
        epgRowsEl.offsetHeight + timeHeaderEl.offsetHeight,
        epgGridEl.clientHeight
      );
      currentTimeIndicator.style.height = contentHeight + 'px';
    }
  }

  // ─── Now Playing Info ───
  function updateNowPlayingInfo() {
    if (!activeStream) return;
    var programs = epgSchedule[activeStream.epg_id] || [];
    var now = Math.floor(Date.now() / 1000);
    var currentProg = null;
    for (var i = 0; i < programs.length; i++) {
      if (programs[i].start <= now && programs[i].stop >= now) {
        currentProg = programs[i];
        break;
      }
    }
    if (currentProg) {
      var startTime = new Date(currentProg.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var endTime = new Date(currentProg.stop * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      nowPlayingProgram.textContent = startTime + ' \u2013 ' + endTime + '  ' + currentProg.title;
    } else {
      nowPlayingProgram.textContent = '';
    }
  }

  // ─── Player Logic ───
  var transcodeSwitch = document.getElementById('transcode-switch');
  transcodeSwitch.checked = localStorage.getItem('transcode_enabled') === 'true';

  transcodeSwitch.addEventListener('change', function() {
    localStorage.setItem('transcode_enabled', transcodeSwitch.checked);
    if (activeStream) playStream(activeStream);
  });

  function playStream(stream) {
    activeStream = stream;
    retryCount = 0;
    isRetrying = false;

    // Update now-playing
    nowPlayingChannel.textContent = stream.name;
    updateNowPlayingInfo();
    document.getElementById('player-container').classList.add('show-info');
    setTimeout(function() { document.getElementById('player-container').classList.remove('show-info'); }, 3000);

    if (castSession) {
      loadRemoteMedia(stream);
      return;
    }

    var url = stream.url;
    if (token && !url.includes('token=')) {
      url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }

    var wantTranscode = transcodeSwitch.checked;
    var streamType = stream.type || 'live';

    // Store DRM info
    if (stream.drm) {
      video.dataset.drm = JSON.stringify(stream.drm);
    } else {
      delete video.dataset.drm;
    }

    // ─── Playback Strategy ───
    if (url.includes('.mpd')) {
      initDashPlayer(url);
    } else if (url.includes('.ts')) {
      if (wantTranscode) {
        var mp4Url = url.replace(/\.ts($|\?)/, '.mp4$1');
        var mp4TranscodeUrl = mp4Url + (mp4Url.includes('?') ? '&' : '?') + 'transcode=true';
        initNativePlayer(mp4TranscodeUrl, streamType);
      } else if (isIOS) {
        var hlsUrl2 = url.replace(/\.ts($|\?)/, '.m3u8$1');
        initNativePlayer(hlsUrl2, streamType);
      } else if (typeof mpegts !== 'undefined' && mpegts.isSupported()) {
        initMpegtsPlayer(url, streamType);
      } else if (hasNativeHLS) {
        var hlsUrl4 = url.replace(/\.ts($|\?)/, '.m3u8$1');
        initNativePlayer(hlsUrl4, streamType);
      } else {
        initNativePlayer(url, streamType);
      }
    } else if (url.includes('.m3u8')) {
      if (isIOS) {
        initNativePlayer(url, streamType);
      } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        initHlsPlayer(url, streamType, null);
      } else {
        initNativePlayer(url, streamType);
      }
    } else if (url.match(/\.(mkv|avi|mp4|mov|wmv)($|\?)/i)) {
      if (wantTranscode && !url.match(/\.(mkv|avi)($|\?)/i)) {
        var vodTranscodeUrl = url + (url.includes('?') ? '&' : '?') + 'transcode=true';
        initNativePlayer(vodTranscodeUrl, streamType);
      } else {
        initNativePlayer(url, streamType);
      }
    } else {
      initNativePlayer(url, streamType);
    }
  }

  // ─── Destroy All Players ───
  function destroyAllPlayers() {
    if (flvPlayer) {
      try {
        flvPlayer.pause();
        flvPlayer.unload();
        flvPlayer.detachMediaElement();
        flvPlayer.destroy();
      } catch (e) { /* ignore */ }
      flvPlayer = null;
    }
    if (hls) {
      try { hls.destroy(); } catch (e) { /* ignore */ }
      hls = null;
    }
    if (dashPlayer) {
      try { dashPlayer.destroy(); } catch (e) { /* ignore */ }
      dashPlayer = null;
    }
    video.removeAttribute('src');
    video.onerror = null;
    try { video.load(); } catch(e) { /* ignore */ }
  }

  // ─── HLS.js Player ───
  function initHlsPlayer(url, type, fallbackTsUrl) {
    destroyAllPlayers();
    setPlayerStatus('HLS', 'primary');
    console.log('HLS.js: ' + url);

    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: type === 'live' ? 30 : 60,
      maxMaxBufferLength: type === 'live' ? 60 : 120,
      startFragPrefetch: true,
      testBandwidth: true,
      progressive: true,
      fragLoadingMaxRetry: 3,
      manifestLoadingMaxRetry: 3,
      levelLoadingMaxRetry: 3
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, function() {
      console.log('HLS manifest parsed');
      video.play().catch(function(e) { console.log('Autoplay blocked:', e.message); });
    });

    hls.on(Hls.Events.ERROR, function(event, data) {
      console.warn('HLS error:', data.type, data.details, data.fatal);

      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            if (retryCount < MAX_RETRIES) {
              retryCount++;
              console.log('HLS network error, retry ' + retryCount + '/' + MAX_RETRIES);
              hls.startLoad();
            } else if (fallbackTsUrl && !isRetrying) {
              console.log('HLS failed, falling back to mpegts.js');
              isRetrying = true;
              retryCount = 0;
              initMpegtsPlayer(fallbackTsUrl, type);
            } else {
              handlePlaybackFailure(type);
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            if (retryCount < 2) {
              retryCount++;
              console.log('HLS media error, attempting recovery');
              hls.recoverMediaError();
            } else if (!transcodeSwitch.checked && !isRetrying) {
              enableTranscodeAndRetry(type);
            } else if (fallbackTsUrl && !isRetrying) {
              isRetrying = true;
              initMpegtsPlayer(fallbackTsUrl, type);
            } else {
              handlePlaybackFailure(type);
            }
            break;
          default:
            if (fallbackTsUrl && !isRetrying) {
              isRetrying = true;
              initMpegtsPlayer(fallbackTsUrl, type);
            } else {
              handlePlaybackFailure(type);
            }
        }
      }
    });
  }

  // ─── mpegts.js Player ───
  function initMpegtsPlayer(url, type) {
    destroyAllPlayers();
    isRetrying = false;
    retryCount = 0;
    setPlayerStatus('MPEG-TS', 'warning');
    console.log('mpegts.js: ' + url);

    if (typeof mpegts === 'undefined' || !mpegts.isSupported()) {
      console.warn('mpegts.js not supported, falling back to native');
      initNativePlayer(url, type);
      return;
    }

    var isLive = (type === 'live');
    flvPlayer = mpegts.createPlayer({
      type: 'mpegts',
      url: url,
      isLive: isLive,
      cors: true
    }, {
      enableWorker: true,
      liveBufferLatencyChasing: isLive,
      liveBufferLatencyMaxLatency: 20,
      liveBufferLatencyMinRemain: 3
    });

    flvPlayer.attachMediaElement(video);
    flvPlayer.load();

    var errorHandled = false;
    var UNSUPPORTED_AUDIO = ['ac-3', 'ec-3', 'eac3', 'eac-3', 'dts', 'dtsc', 'dtse', 'dtsh', 'dtsl'];

    if (flvPlayer.on && mpegts.Events.MEDIA_INFO) {
      flvPlayer.on(mpegts.Events.MEDIA_INFO, function(mediaInfo) {
        if (errorHandled) return;
        var audioCodec = mediaInfo && mediaInfo.audioCodec;
        if (audioCodec) {
          var codecLower = audioCodec.toLowerCase();
          var isUnsupported = UNSUPPORTED_AUDIO.some(function(c) { return codecLower.includes(c); });
          if (isUnsupported) {
            console.warn('Unsupported audio codec: ' + audioCodec);
            errorHandled = true;
            enableTranscodeAndRetry(type);
          }
        }
      });
    }

    flvPlayer.on(mpegts.Events.ERROR, function(errorType, errorDetail, errorInfo) {
      console.warn('mpegts error:', errorType, errorDetail, errorInfo);
      if (errorHandled) return;
      if (errorType === mpegts.ErrorTypes.MEDIA_ERROR) {
        errorHandled = true;
        enableTranscodeAndRetry(type);
      }
    });

    flvPlayer.play().catch(function(e) { console.log('Autoplay blocked:', e.message); });
  }

  // ─── DASH Player ───
  function initDashPlayer(url) {
    destroyAllPlayers();
    setPlayerStatus('DASH', 'info');
    console.log('dash.js: ' + url);

    if (typeof dashjs === 'undefined') {
      console.error('dash.js not loaded');
      initNativePlayer(url, 'live');
      return;
    }

    dashPlayer = dashjs.MediaPlayer().create();
    dashPlayer.initialize(video, url, true);

    if (video.dataset.drm) {
      try {
        var drm = JSON.parse(video.dataset.drm);
        var protData = {};

        if (drm.license_type && drm.license_key) {
          var keySystem = drm.license_type;
          if (keySystem === 'clearkey') keySystem = 'org.w3.clearkey';
          if (keySystem === 'widevine') keySystem = 'com.widevine.alpha';
          if (keySystem === 'playready') keySystem = 'com.microsoft.playready';

          var licenseUrl = drm.license_key;
          var headers = {};

          if (licenseUrl.includes('|')) {
            var parts = licenseUrl.split('|');
            licenseUrl = parts[0];
            for (var i = 1; i < parts.length; i++) {
              var hParts = parts[i].split('=');
              if (hParts[0] && hParts[1]) headers[hParts[0]] = hParts[1];
            }
          }

          if (keySystem === 'org.w3.clearkey' && !licenseUrl.startsWith('http')) {
            var ckParts = licenseUrl.split(':');
            if (ckParts.length === 2) {
              var ck = {};
              ck[ckParts[0]] = ckParts[1];
              protData[keySystem] = { clearkeys: ck };
            }
          } else {
            protData[keySystem] = { serverURL: licenseUrl, httpRequestHeaders: headers };
          }

          dashPlayer.setProtectionData(protData);
        }
      } catch (e) {
        console.error('DRM Setup Error:', e);
      }
    }
  }

  // ─── Native Player ───
  function initNativePlayer(url, type) {
    destroyAllPlayers();
    setPlayerStatus(hasNativeHLS ? 'Native HLS' : 'Native', 'success');
    console.log('Native: ' + url);

    video.src = url;
    video.load();
    video.play().catch(function(e) { console.log('Autoplay blocked:', e.message); });

    video.onerror = function() {
      var err = video.error;
      console.error('Native playback error:', err);
      if (err && (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || err.code === MediaError.MEDIA_ERR_DECODE)) {
        if (!transcodeSwitch.checked && !isRetrying) {
          enableTranscodeAndRetry(type);
        } else {
          handlePlaybackFailure(type);
        }
      }
    };
  }

  // ─── Auto-Transcode & Retry ───
  function enableTranscodeAndRetry(type) {
    if (isRetrying) return;
    isRetrying = true;

    if (!transcodeSwitch.checked) {
      console.log('Auto-enabling audio transcode...');
      showToast(t('autoFixingAudio') || 'Unsupported codec detected. Enabling audio fix...', 'info');
      transcodeSwitch.checked = true;
      localStorage.setItem('transcode_enabled', 'true');
    }

    destroyAllPlayers();

    setTimeout(function() {
      if (!activeStream) return;
      var url = activeStream.url;
      if (token && !url.includes('token=')) {
        url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
      }

      if (url.includes('.ts')) {
        var mp4Url = url.replace(/\.ts($|\?)/, '.mp4$1');
        var mp4TranscodeUrl = mp4Url + (mp4Url.includes('?') ? '&' : '?') + 'transcode=true';
        initNativePlayer(mp4TranscodeUrl, type);
      } else {
        var transcodeUrl2 = url + (url.includes('?') ? '&' : '?') + 'transcode=true';
        initNativePlayer(transcodeUrl2, type);
      }
    }, 500);
  }

  // ─── Final Failure Handler ───
  function handlePlaybackFailure(type) {
    console.error('All playback methods failed');
    showToast(t('playbackError') || 'Playback Error: Codec might not be supported', 'danger', 6000);
    setPlayerStatus('Error', 'danger');
  }

  // ─── Event Listeners ───

  // Tab switching
  document.querySelectorAll('#player-tabs .nav-link').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      document.querySelectorAll('#player-tabs .nav-link').forEach(function(l) { l.classList.remove('active'); });
      e.target.classList.add('active');
      currentType = e.target.dataset.type;
      catSelect.value = '';
      searchInput.value = '';
      updateCategories();
      renderView();
    });
  });

  // Category filter
  catSelect.addEventListener('change', function() {
    if (currentType === 'live') renderTimeline();
    else renderList();
  });

  // Search
  searchInput.addEventListener('input', debounce(function() {
    if (currentType === 'live') renderTimeline();
    else renderList();
  }, 400));

  // Sidebar toggle (mobile)
  var sidebarToggle = document.getElementById('sidebar-toggle');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', function() {
      sidebarEl.classList.toggle('open');
      sidebarOverlay.classList.toggle('active');
    });
  }
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar);
  }

  function closeSidebar() {
    sidebarEl.classList.remove('open');
    sidebarOverlay.classList.remove('active');
  }

  // Debounce utility
  function debounce(func, wait) {
    var timeout;
    return function() {
      var context = this, args = arguments;
      clearTimeout(timeout);
      timeout = setTimeout(function() { func.apply(context, args); }, wait);
    };
  }

  // ─── Start ───
  init();

})();
