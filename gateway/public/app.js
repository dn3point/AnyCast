/* AnyCast phone UI – plain JS, no build step. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    devices: [],
    deviceId: null,
    candidates: [],
    candidateIndex: -1,
    pageUrl: null,
    title: null,
    session: null,
    pollTimer: null,
    seeking: false,
    token: null,
  };

  // ---------- storage (best effort) ----------
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem('anycast.' + key);
      if (value === null) localStorage.removeItem('anycast.' + key);
      else localStorage.setItem('anycast.' + key, value);
    } catch (e) { /* private mode */ }
    return null;
  }

  // ---------- api ----------
  function api(method, path, body) {
    var headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          if (!res.ok) {
            var err = new Error(json.error || ('HTTP ' + res.status));
            err.code = json.code;
            throw err;
          }
          return json;
        });
      });
  }

  var toastTimer = null;
  function toast(msg, warn, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (warn ? ' warn' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || (warn ? 7000 : 3000));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function radioItem(opts) {
    var item = el('div', {
      class: 'item' + (opts.warn ? ' drm' : ''),
      role: 'radio',
      tabindex: '0',
      'aria-checked': opts.checked ? 'true' : 'false',
      onclick: opts.onSelect,
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onSelect(); } },
    }, [
      el('span', { class: 'icon', 'aria-hidden': 'true', text: opts.icon }),
      el('div', { class: 'main' }, [
        el('div', { class: 'name', text: opts.name }),
        el('div', { class: 'meta', text: opts.meta || '' }),
      ]),
      opts.badge ? el('span', { class: 'badge' + (opts.warn ? ' warn' : ''), text: opts.badge }) : null,
    ]);
    return item;
  }

  // ---------- gateway info ----------
  function loadInfo() {
    api('GET', '/api/info').then(function (info) {
      var f = info.features || {};
      var box = $('features');
      box.innerHTML = '';
      [['ffmpeg', '转封装'], ['ytdlp', 'yt-dlp'], ['headless', '深度解析']].forEach(function (p) {
        box.appendChild(el('span', { class: f[p[0]] ? 'on' : '', title: f[p[0]] ? '已启用' : '未安装', text: p[1] }));
      });
      $('tvUrl').textContent = location.origin + '/tv';
    }).catch(function (e) {
      if (e.code === 'UNAUTHORIZED') askToken();
    });
  }

  function askToken() {
    var t = window.prompt('网关启用了访问令牌，请输入：');
    if (t) {
      state.token = t;
      store('token', t);
      init();
    }
  }

  // ---------- devices ----------
  var ICONS = { dlna: '📺', chromecast: '📡', web: '🌐' };
  var TYPE_NAMES = { dlna: 'DLNA', chromecast: 'Chromecast', web: '电视浏览器' };

  function loadDevices() {
    return api('GET', '/api/devices').then(function (r) {
      state.devices = r.devices || [];
      if (!state.devices.some(function (d) { return d.id === state.deviceId; })) {
        var remembered = store('device');
        var hit = state.devices.filter(function (d) { return d.id === remembered; })[0];
        state.deviceId = hit ? hit.id : (state.devices[0] ? state.devices[0].id : null);
      }
      renderDevices();
    }).catch(function () {});
  }

  function renderDevices() {
    var box = $('devices');
    box.innerHTML = '';
    if (!state.devices.length) {
      box.appendChild(el('div', { class: 'empty', text: '正在搜索同一网络下的电视…' }));
    }
    state.devices.forEach(function (d) {
      box.appendChild(radioItem({
        icon: ICONS[d.type] || '📺',
        name: d.name,
        meta: [TYPE_NAMES[d.type] || d.type, d.model, d.host].filter(Boolean).join(' · '),
        checked: d.id === state.deviceId,
        onSelect: function () {
          state.deviceId = d.id;
          store('device', d.id);
          renderDevices();
          updateCastButton();
        },
      }));
    });
    updateCastButton();
  }

  $('refreshDevices').addEventListener('click', function () {
    api('POST', '/api/devices/refresh').catch(function () {});
    $('devices').innerHTML = '<div class="empty"><span class="spinner"></span> 正在搜索…</div>';
    setTimeout(loadDevices, 2500);
  });

  $('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('addInput').value.trim();
    if (!v) return;
    var body = /^https?:\/\//.test(v) ? { location: v } : { type: 'chromecast', host: v.split(':')[0], port: Number(v.split(':')[1]) || 8009 };
    api('POST', '/api/devices', body).then(function (r) {
      toast('已添加：' + r.device.name);
      state.deviceId = r.device.id;
      $('addInput').value = '';
      loadDevices();
    }).catch(function (err) { toast('添加失败：' + err.message, true); });
  });

  // ---------- candidates ----------
  function kindBadge(c) {
    if (c.audioUrl) return '音视频分离';
    if (c.kind === 'hls') return c.live ? 'HLS 直播' : 'HLS';
    if (c.kind === 'dash') return 'DASH';
    var m = (c.mime || '').split('/')[1] || 'video';
    return m.replace('x-', '').toUpperCase();
  }

  function describe(c) {
    var host = '';
    try {
      var u = new URL(c.url);
      host = u.host + u.pathname.replace(/^.*(\/[^/]{0,40})$/, '…$1');
    } catch (e) { host = c.url; }
    var bits = [];
    if (c.label) bits.push(c.label);
    if (c.variants) bits.push(c.variants + ' 种清晰度');
    if (c.length && c.kind === 'progressive') bits.push((c.length / 1048576).toFixed(1) + ' MB');
    bits.push(host);
    return bits.join(' · ');
  }

  function renderCandidates(message) {
    var box = $('candidates');
    box.innerHTML = '';
    if (message) box.appendChild(el('div', { class: 'empty', text: message }));
    state.candidates.forEach(function (c, i) {
      box.appendChild(radioItem({
        icon: c.drm ? '🔒' : '🎬',
        name: c.title || state.title || '视频 ' + (i + 1),
        meta: c.drm ? ('受 ' + c.drm + ' DRM 保护，无法投屏') : describe(c),
        badge: c.drm ? 'DRM' : kindBadge(c),
        warn: Boolean(c.drm),
        checked: i === state.candidateIndex,
        onSelect: function () {
          state.candidateIndex = i;
          renderCandidates();
          updateCastButton();
        },
      }));
    });
    updateCastButton();
  }

  function runExtract(payload) {
    $('extractBtn').disabled = true;
    state.candidates = [];
    state.candidateIndex = -1;
    renderCandidates('');
    $('candidates').innerHTML = '<div class="empty"><span class="spinner"></span> 正在解析视频地址（最长约 30 秒）…</div>';
    return api('POST', '/api/extract', payload).then(function (r) {
      state.title = r.title || state.title;
      state.candidates = (r.candidates || []);
      state.candidateIndex = state.candidates.findIndex(function (c) { return !c.drm; });
      if (!state.candidates.length) {
        renderCandidates(r.drm
          ? '该网页使用 DRM 版权保护，无法投屏。'
          : '没有找到可播放的视频。请先在网页里点播放，再用书签脚本或扩展投屏。');
      } else {
        renderCandidates();
      }
    }).catch(function (err) {
      renderCandidates('解析失败：' + err.message);
    }).then(function () {
      $('extractBtn').disabled = false;
    });
  }

  $('extractForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var url = $('urlInput').value.trim();
    if (!url) return;
    state.pageUrl = url;
    var headers = {};
    if ($('refererInput').value.trim()) headers.referer = $('refererInput').value.trim();
    runExtract({ url: url, cookie: $('cookieInput').value.trim() || undefined, headers: headers });
  });

  // ---------- bookmarklet hand-off (#p=<base64url JSON>) ----------
  function decodePayload(b64) {
    var s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function handleHandoff() {
    var m = /^#p=([\w-]+)/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    var p;
    try { p = decodePayload(m[1]); } catch (e) { toast('无法读取网页传来的数据', true); return; }
    state.pageUrl = p.page;
    state.title = p.title;
    $('handoff').hidden = false;
    $('handoffTitle').textContent = p.title || p.page;
    try { $('handoffHost').textContent = new URL(p.page).host; } catch (e) { /* ignore */ }
    $('urlInput').value = p.page || '';
    if (p.cookie) $('cookieInput').value = p.cookie;
    if (p.drm) toast('该网页使用了 DRM 加密播放器，可能无法投屏', true);
    runExtract({
      url: p.page,
      title: p.title,
      cookie: p.cookie,
      userAgent: p.ua,
      candidates: p.cands || [],
      frames: p.frames || [],
      drm: p.drm ? 'DRM' : undefined,
    });
  }

  // ---------- cast ----------
  function updateCastButton() {
    var c = state.candidates[state.candidateIndex];
    $('castBtn').disabled = !(state.deviceId && c && !c.drm);
  }

  $('castBtn').addEventListener('click', function () {
    var c = state.candidates[state.candidateIndex];
    if (!c || !state.deviceId) return;
    var btn = $('castBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 正在投屏…';
    var media = {
      url: c.url,
      audioUrl: c.audioUrl,
      kind: c.kind,
      mime: c.mime,
      headers: c.headers,
      title: c.title || state.title,
      pageUrl: state.pageUrl,
      live: c.live,
      drm: c.drm || undefined,
    };
    api('POST', '/api/cast', { deviceId: state.deviceId, media: media, mode: $('modeSelect').value })
      .then(function (r) {
        state.session = r.session;
        var modeName = { direct: '直连', proxy: '网关代理', transcode: '转封装' }[r.session.mode] || r.session.mode;
        toast('已投屏（' + modeName + '）');
        showNow();
      })
      .catch(function (err) { toast(err.message, true, 10000); })
      .then(function () {
        btn.textContent = '投屏到电视';
        updateCastButton();
      });
  });

  // ---------- now playing ----------
  function fmt(t) {
    if (t == null || !isFinite(t)) return '--:--';
    t = Math.max(0, Math.floor(t));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  var STATE_TEXT = { playing: '播放中', paused: '已暂停', stopped: '已停止', loading: '加载中', idle: '空闲', unknown: '状态未知', offline: '电视离线' };

  function showNow() {
    var s = state.session;
    $('now').hidden = false;
    $('nowTitle').textContent = s.title || '网页视频';
    $('nowDevice').textContent = '→ ' + s.deviceName;
    $('nowMode').textContent = { direct: '直连', proxy: '网关代理', transcode: '转封装' }[s.mode] || s.mode;
    store('session', s.id);
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(poll, 2000);
    poll();
  }

  function poll() {
    if (!state.session) return;
    api('GET', '/api/sessions/' + state.session.id).then(function (r) {
      var st = r.status || {};
      $('nowState').textContent = (STATE_TEXT[st.state] || st.state || '') + (st.error ? ' · ' + st.error : '');
      $('playPause').textContent = st.state === 'playing' ? '⏸' : '▶';
      if (!state.seeking) {
        var seek = $('seek');
        seek.max = st.duration || 0;
        seek.value = st.position || 0;
        seek.disabled = !st.duration || r.live;
      }
      $('posText').textContent = fmt(st.position);
      $('durText').textContent = r.live ? '直播' : fmt(st.duration);
      if (st.volume != null && document.activeElement !== $('volume')) $('volume').value = st.volume;
    }).catch(function (err) {
      if (err.code === 'NO_SESSION') endNow();
    });
  }

  function endNow() {
    clearInterval(state.pollTimer);
    state.session = null;
    store('session', null);
    $('now').hidden = true;
  }

  function control(action, value) {
    if (!state.session) return Promise.resolve();
    return api('POST', '/api/sessions/' + state.session.id + '/control', { action: action, value: value })
      .then(function (r) {
        if (r.ended) endNow();
        else setTimeout(poll, 400);
      })
      .catch(function (err) { toast(err.message, true); });
  }

  $('playPause').addEventListener('click', function () {
    control($('playPause').textContent === '⏸' ? 'pause' : 'play');
  });
  $('stopBtn').addEventListener('click', function () { control('stop'); });
  $('back10').addEventListener('click', function () { control('seek', Math.max(0, Number($('seek').value) - 10)); });
  $('fwd10').addEventListener('click', function () { control('seek', Number($('seek').value) + 10); });
  $('seek').addEventListener('input', function () { state.seeking = true; $('posText').textContent = fmt(Number($('seek').value)); });
  $('seek').addEventListener('change', function () {
    control('seek', Number($('seek').value)).then(function () { state.seeking = false; });
  });
  $('volume').addEventListener('change', function () { control('volume', Number($('volume').value)); });

  function resumeSession() {
    var id = store('session');
    if (!id) return;
    api('GET', '/api/sessions/' + id).then(function (r) {
      state.session = r;
      showNow();
    }).catch(function () { store('session', null); });
  }

  // ---------- bookmarklet ----------
  function setupBookmarklet() {
    fetch('/static/bookmarklet.js').then(function (r) { return r.text(); }).then(function (src) {
      var code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/__GATEWAY__/g, location.origin)
        .split('\n').map(function (l) { return l.trim(); }).join('');
      var href = 'javascript:' + encodeURIComponent(code);
      var a = $('bookmarklet');
      a.href = href;
      a.addEventListener('click', function (e) {
        e.preventDefault();
        toast('请把它加入书签（长按/拖到书签栏），在视频网页上点它');
      });
      $('copyBm').addEventListener('click', function () {
        var done = function () { toast('已复制，新建书签并把网址替换成这段代码'); };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(href).then(done, function () { window.prompt('复制这段代码：', href); });
        } else {
          window.prompt('复制这段代码：', href);
        }
      });
    });
  }

  function init() {
    loadInfo();
    loadDevices();
    resumeSession();
  }

  state.token = new URLSearchParams(location.search).get('token') || store('token');
  if (new URLSearchParams(location.search).get('token')) store('token', state.token);
  init();
  setInterval(loadDevices, 10000);
  setupBookmarklet();
  handleHandoff();
  window.addEventListener('hashchange', handleHandoff);
})();
