/*
 * AnyCast page-world sniffer. Runs in the page's own JS world at
 * document_start (all frames) so it sees what the site's player does:
 *   - fetch() / XMLHttpRequest URLs and response types (catches m3u8 / mpd
 *     loaded by hls.js, dash.js, video.js, DPlayer, xgplayer, ...)
 *   - MediaSource attachment (blob: video src means "real URL is elsewhere")
 *   - EME (requestMediaKeySystemAccess) => the stream is DRM protected
 *   - <video src=...> assignments and play events
 * Findings are posted to the isolated-world content script via postMessage.
 */
(function () {
  'use strict';
  if (window.__anycastSniffer) return;
  window.__anycastSniffer = true;

  var RE = /\.(m3u8|mpd|mp4|m4v|webm|flv|mov|mkv)(\?|#|$)|[?&](type|format)=m3u8/i;
  var SEGMENT = /\.(ts|m4s|aac|vtt|key)(\?|#|$)/i;
  var seen = Object.create(null);

  function post(msg) {
    msg.__anycast = 1;
    try { window.postMessage(msg, '*'); } catch (e) { /* ignore */ }
  }

  function abs(u) {
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  }

  function report(url, how, kind) {
    if (!url || typeof url !== 'string' || /^(blob|data|about):/i.test(url)) return;
    var u = abs(url);
    if (!u) return;
    // Re-report once the response confirms the type (URL first, content-type later).
    if (seen[u] && (!kind || seen[u] === kind)) return;
    if (!kind && (!RE.test(u) || SEGMENT.test(u))) return;
    seen[u] = kind || 'url';
    post({ items: [{ url: u, how: how, kind: kind || null }] });
  }

  function kindFromType(ct) {
    ct = String(ct || '').toLowerCase();
    if (ct.indexOf('mpegurl') >= 0) return 'hls';
    if (ct.indexOf('dash+xml') >= 0) return 'dash';
    return null;
  }

  // fetch()
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && (input.url || String(input)));
      report(url, 'fetch');
      var p = origFetch.apply(this, arguments);
      try {
        p.then(function (res) {
          var k = kindFromType(res.headers.get('content-type'));
          if (k) report(res.url || url, 'fetch', k);
        }, function () {});
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  // XMLHttpRequest
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      try {
        this.__anycastUrl = url;
        report(String(url), 'xhr');
        this.addEventListener('load', function () {
          try {
            var k = kindFromType(this.getResponseHeader('content-type'));
            if (!k && (this.responseType === '' || this.responseType === 'text')) {
              var t = String(this.responseText || '').slice(0, 64).trimStart();
              if (t.indexOf('#EXTM3U') === 0) k = 'hls';
              else if (/<MPD[\s>]/.test(String(this.responseText || '').slice(0, 512))) k = 'dash';
            }
            if (k) report(this.responseURL || String(this.__anycastUrl), 'xhr', k);
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
  }

  // MediaSource => player is streaming via MSE.
  var origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    try {
      if (window.MediaSource && obj instanceof window.MediaSource) post({ mse: true });
    } catch (e) { /* ignore */ }
    return origCreate.apply(this, arguments);
  };

  // EME => DRM.
  if (navigator.requestMediaKeySystemAccess) {
    var origEme = navigator.requestMediaKeySystemAccess;
    navigator.requestMediaKeySystemAccess = function (keySystem) {
      if (!/clearkey/i.test(String(keySystem))) post({ drm: String(keySystem) });
      return origEme.apply(this, arguments);
    };
  }

  // <video>.src = ...
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          report(String(v), 'video-src', RE.test(String(v)) ? null : 'progressive');
          return desc.set.call(this, v);
        },
      });
    }
  } catch (e) { /* ignore */ }

  // play events (capture: they do not bubble)
  document.addEventListener('play', function (e) {
    var v = e.target;
    if (v && v.currentSrc) report(v.currentSrc, 'play', RE.test(v.currentSrc) ? null : 'progressive');
  }, true);

  // Anything fetched before we were injected (fallback injection path).
  function scanPast() {
    try {
      performance.getEntriesByType('resource').forEach(function (e) { report(e.name, 'perf'); });
    } catch (e) { /* ignore */ }
    try {
      Array.prototype.forEach.call(document.querySelectorAll('video,source'), function (v) {
        var src = v.currentSrc || v.src;
        if (src) report(src, 'dom', RE.test(src) ? null : 'progressive');
      });
    } catch (e) { /* ignore */ }
  }
  scanPast();
  document.addEventListener('DOMContentLoaded', scanPast);
  post({ hello: true });
})();
