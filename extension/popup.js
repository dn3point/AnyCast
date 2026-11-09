/* Popup / cast panel. Also opened as a full tab from the in-page button. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var settings = null;
  var tabId = null;
  var page = null;
  var items = [];
  var picked = -1;
  var devices = [];
  var deviceId = null;
  var session = null;

  function msg(text, isError) {
    var el = $('msg');
    el.textContent = text;
    el.className = 'msg' + (isError ? ' err' : '');
    el.hidden = !text;
  }

  function radio(opts) {
    var div = document.createElement('div');
    div.className = 'item';
    div.setAttribute('role', 'radio');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-checked', opts.checked ? 'true' : 'false');
    var main = document.createElement('div');
    main.className = 'main';
    var n = document.createElement('div');
    n.className = 'name';
    n.textContent = opts.name;
    var m = document.createElement('div');
    m.className = 'meta';
    m.textContent = opts.meta || '';
    main.appendChild(n);
    main.appendChild(m);
    div.appendChild(main);
    if (opts.badge) {
      var b = document.createElement('span');
      b.className = 'badge';
      b.textContent = opts.badge;
      div.appendChild(b);
    }
    div.addEventListener('click', opts.onSelect);
    div.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onSelect(); }
    });
    return div;
  }

  function shortUrl(u) {
    try {
      var x = new URL(u);
      var file = x.pathname.split('/').pop() || x.pathname;
      return x.host + ' · ' + (file.length > 36 ? file.slice(0, 33) + '…' : file);
    } catch (e) { return u; }
  }

  var KIND = { hls: 'HLS', dash: 'DASH', progressive: '视频文件' };

  function renderMedia() {
    var box = $('media');
    box.innerHTML = '';
    if (!items.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '还没抓到视频。请先在网页里点播放，再打开本面板。';
      box.appendChild(e);
    }
    items.forEach(function (it, i) {
      var meta = shortUrl(it.url);
      if (it.size && it.kind === 'progressive') meta += ' · ' + (it.size / 1048576).toFixed(1) + ' MB';
      if (it.headers && Object.keys(it.headers).length) meta += ' · 已捕获请求头';
      box.appendChild(radio({
        name: (page && page.title) || '视频 ' + (i + 1),
        meta: meta,
        badge: KIND[it.kind] || it.kind,
        checked: i === picked,
        onSelect: function () { picked = i; renderMedia(); updateCast(); },
      }));
    });
    $('deep').hidden = !(page && page.page);
    updateCast();
  }

  function renderDevices() {
    var box = $('devices');
    box.innerHTML = '';
    if (!devices.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = settings.gateway ? '没有发现电视（确认在同一 Wi-Fi）' : '';
      box.appendChild(e);
    }
    devices.forEach(function (d) {
      box.appendChild(radio({
        name: d.name,
        meta: [{ dlna: 'DLNA', chromecast: 'Chromecast', web: '电视浏览器' }[d.type], d.model, d.host].filter(Boolean).join(' · '),
        checked: d.id === deviceId,
        onSelect: function () {
          deviceId = d.id;
          ext.storage.local.set({ lastDevice: d.id });
          renderDevices();
          updateCast();
        },
      }));
    });
    updateCast();
  }

  function updateCast() {
    $('cast').disabled = !(deviceId && items[picked] && !(page && page.drm));
  }

  function loadDevices() {
    return gatewayFetch(settings, 'GET', '/api/devices').then(function (r) {
      devices = r.devices || [];
      return ext.storage.local.get({ lastDevice: null }).then(function (s) {
        if (!devices.some(function (d) { return d.id === deviceId; })) {
          deviceId = devices.some(function (d) { return d.id === s.lastDevice; }) ? s.lastDevice : (devices[0] && devices[0].id);
        }
        renderDevices();
      });
    }).catch(function (e) { msg(e.message, true); renderDevices(); });
  }

  function cookieHeaderFor(url) {
    if (!ext.cookies) return Promise.resolve('');
    return ext.cookies.getAll({ url: url }).then(function (list) {
      return list.map(function (c) { return c.name + '=' + c.value; }).join('; ');
    }).catch(function () { return ''; });
  }

  function cast() {
    var it = items[picked];
    if (!it) return;
    $('cast').disabled = true;
    msg('正在投屏…');
    var headers = Object.assign({}, it.headers || {});
    if (!headers.referer) headers.referer = it.frameUrl || (page && page.page) || undefined;
    if (!headers['user-agent']) headers['user-agent'] = navigator.userAgent;
    // HttpOnly login cookies are invisible to page scripts but available here.
    (headers.cookie ? Promise.resolve(headers.cookie) : cookieHeaderFor(it.url)).then(function (cookie) {
      if (cookie) headers.cookie = cookie;
      return gatewayFetch(settings, 'POST', '/api/cast', {
        deviceId: deviceId,
        mode: $('mode').value,
        media: {
          url: it.url,
          kind: it.kind,
          mime: it.mime || undefined,
          headers: headers,
          title: page && page.title,
          pageUrl: page && page.page,
        },
      });
    }).then(function (r) {
      session = r.session;
      var mode = { direct: '直连', proxy: '网关代理', transcode: '转封装' }[session.mode] || session.mode;
      msg('已投到「' + session.deviceName + '」（' + mode + '）');
      $('now').hidden = false;
      $('nowText').textContent = (session.title || '网页视频') + ' → ' + session.deviceName;
      $('openGateway').href = settings.gateway.replace(/\/+$/, '') + '/';
    }).catch(function (e) {
      msg(e.message, true);
    }).then(updateCast);
  }

  function deepExtract() {
    if (!page || !page.page) return;
    $('deep').disabled = true;
    msg('网关正在解析网页（最长约 30 秒）…');
    cookieHeaderFor(page.page).then(function (cookie) {
      return gatewayFetch(settings, 'POST', '/api/extract', {
        url: page.page,
        cookie: cookie || undefined,
        userAgent: navigator.userAgent,
        candidates: items.map(function (i) { return { url: i.url, headers: i.headers, how: i.how }; }),
      });
    }).then(function (r) {
      if (!r.candidates.length) {
        msg(r.drm ? '该网页使用 DRM 版权保护，无法投屏' : '网关也没有找到视频', true);
        return;
      }
      items = r.candidates.map(function (c) {
        return { url: c.url, kind: c.kind, mime: c.mime, headers: c.headers, how: c.how || 'gateway', size: c.length };
      });
      picked = 0;
      msg('网关找到 ' + items.length + ' 个视频');
      renderMedia();
    }).catch(function (e) { msg(e.message, true); }).then(function () { $('deep').disabled = false; });
  }

  function control(action) {
    if (!session) return;
    gatewayFetch(settings, 'POST', '/api/sessions/' + session.id + '/control', { action: action })
      .then(function (r) { if (r.ended) { $('now').hidden = true; session = null; msg('已停止'); } })
      .catch(function (e) { msg(e.message, true); });
  }

  function currentTabId() {
    var q = new URLSearchParams(location.search).get('tab');
    if (q) return Promise.resolve(Number(q));
    return ext.tabs.query({ active: true, currentWindow: true }).then(function (t) { return t[0] && t[0].id; });
  }

  function init() {
    getSettings().then(function (s) {
      settings = s;
      $('setup').hidden = Boolean(s.gateway);
      return currentTabId();
    }).then(function (id) {
      tabId = id;
      return ext.runtime.sendMessage({ type: 'anycast:getTab', tabId: tabId });
    }).then(function (data) {
      page = data || {};
      items = (data && data.items) || [];
      picked = items.length ? 0 : -1;
      $('page').textContent = page.title || page.page || '';
      if (page.drm) {
        $('drm').hidden = false;
        $('drm').textContent = '该网页使用了 ' + page.drm + ' DRM 加密播放，第三方无法投屏，请使用官方 App。';
      }
      renderMedia();
      if (settings.gateway) loadDevices();
    }).catch(function (e) { msg(e.message, true); });
  }

  $('setupForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('gatewayInput').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(v)) v = 'http://' + v;
    var test = Object.assign({}, settings, { gateway: v });
    gatewayFetch(test, 'GET', '/api/info').then(function () {
      return ext.storage.local.set({ gateway: v });
    }).then(function () {
      msg('已连接网关');
      init();
    }).catch(function (err) { msg(err.message, true); });
  });
  $('openOptions').addEventListener('click', function (e) {
    e.preventDefault();
    ext.runtime.openOptionsPage();
  });
  $('cast').addEventListener('click', cast);
  $('deep').addEventListener('click', deepExtract);
  Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (b) {
    b.addEventListener('click', function () { control(b.getAttribute('data-act')); });
  });
  init();
})();
