/*
 * AnyCast background worker.
 *
 * webRequest is the most reliable sniffer we have: it sees every request the
 * page makes (including from workers and cross-origin iframes) together with
 * the exact request headers (Referer, Origin, Cookie, Authorization, custom
 * X-* tokens). Those headers are what the gateway relay replays so the TV can
 * play hot-link-protected streams.
 */
'use strict';

var ext = globalThis.browser || globalThis.chrome;

var URL_RE = /\.(m3u8|mpd|mp4|m4v|webm|flv|mov|mkv)(\?|#|$)|[?&](type|format)=m3u8/i;
var SEGMENT_RE = /\.(ts|m4s|aac|vtt|key|jpg|jpeg|png|gif|webp)(\?|#|$)/i;
var MANIFEST_CT = /mpegurl|dash\+xml/i;
var VIDEO_CT = /^video\/(?!mp2t|iso\.segment)/i;
var KEEP_HEADERS = /^(referer|origin|cookie|user-agent|authorization|x-[\w-]+)$/i;
var MAX_ITEMS = 40;

var tabs = new Map(); // tabId -> { page, title, drm, mse, items: [] }
var pendingHeaders = new Map(); // requestId -> headers

function tabState(tabId) {
  var t = tabs.get(tabId);
  if (!t) {
    t = { page: null, title: null, drm: null, mse: false, items: [] };
    tabs.set(tabId, t);
  }
  return t;
}

function classify(url, ct) {
  if (MANIFEST_CT.test(ct || '')) return /dash/i.test(ct) ? 'dash' : 'hls';
  if (/\.m3u8?(\?|#|$)|[?&](type|format)=m3u8/i.test(url)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
  if (VIDEO_CT.test(ct || '') && !SEGMENT_RE.test(url)) return 'progressive';
  if (URL_RE.test(url) && !SEGMENT_RE.test(url)) return 'progressive';
  return null;
}

function addItem(tabId, item) {
  var t = tabState(tabId);
  var existing = t.items.find(function (i) { return i.url === item.url; });
  if (existing) {
    // Prefer network-captured details over page-script guesses.
    if (item.headers && !existing.headers) existing.headers = item.headers;
    if (item.how === 'network') existing.how = 'network';
    if (item.kind && !existing.kind) existing.kind = item.kind;
    if (item.mime && !existing.mime) existing.mime = item.mime;
    if (item.size && !existing.size) existing.size = item.size;
    return;
  }
  item.ts = Date.now();
  t.items.push(item);
  if (t.items.length > MAX_ITEMS) t.items.shift();
  updateBadge(tabId);
  persist();
}

function rank(t) {
  var score = function (i) {
    var s = { hls: 40, dash: 30, progressive: 20 }[i.kind] || 10;
    if (i.how === 'network') s += 5;
    if (i.size && i.size < 2 * 1024 * 1024 && i.kind === 'progressive') s -= 20;
    if (/\b(ad|ads|advert|preroll)\b/i.test(i.url)) s -= 30;
    if (/master|playlist/i.test(i.url)) s += 3;
    return s;
  };
  return t.items
    .filter(function (i) { return i.kind; })
    .slice()
    .sort(function (a, b) { return score(b) - score(a) || b.ts - a.ts; });
}

function updateBadge(tabId) {
  var t = tabs.get(tabId);
  var n = t ? rank(t).length : 0;
  try {
    ext.action.setBadgeBackgroundColor({ tabId: tabId, color: t && t.drm ? '#b45309' : '#0f766e' });
    ext.action.setBadgeText({ tabId: tabId, text: n ? String(n) : '' });
  } catch (e) { /* tab gone */ }
}

// ---- persistence across service-worker restarts (Chrome MV3) ----
var persistTimer = null;
function persist() {
  if (!ext.storage || !ext.storage.session) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(function () {
    var obj = {};
    tabs.forEach(function (v, k) { obj[k] = v; });
    ext.storage.session.set({ tabs: obj }).catch(function () {});
  }, 300);
}
if (ext.storage && ext.storage.session) {
  ext.storage.session.get('tabs').then(function (r) {
    Object.keys((r && r.tabs) || {}).forEach(function (k) {
      if (!tabs.has(Number(k))) tabs.set(Number(k), r.tabs[k]);
    });
  }).catch(function () {});
}

// ---- webRequest sniffing ----
var filter = { urls: ['<all_urls>'] };

function onBeforeSendHeaders(details) {
  if (details.tabId < 0) return;
  if (details.type === 'main_frame') {
    tabs.set(details.tabId, { page: details.url, title: null, drm: null, mse: false, items: [] });
    updateBadge(details.tabId);
    return;
  }
  if (details.type === 'image' || details.type === 'stylesheet' || details.type === 'font' || details.type === 'script') return;
  var headers = {};
  (details.requestHeaders || []).forEach(function (h) {
    if (KEEP_HEADERS.test(h.name)) headers[h.name.toLowerCase()] = h.value;
  });
  pendingHeaders.set(details.requestId, headers);
}

function onHeadersReceived(details) {
  if (details.tabId < 0) return;
  var headers = pendingHeaders.get(details.requestId);
  pendingHeaders.delete(details.requestId);
  if (details.statusCode >= 400) return;
  var ct = '';
  var size = 0;
  (details.responseHeaders || []).forEach(function (h) {
    var n = h.name.toLowerCase();
    if (n === 'content-type') ct = h.value || '';
    if (n === 'content-range') size = Number(String(h.value).split('/')[1]) || size;
    if (n === 'content-length' && !size) size = Number(h.value) || 0;
  });
  var kind = classify(details.url, ct);
  if (!kind) return;
  var frameUrl = details.documentUrl || details.frameUrl || null;
  if (headers && !headers.referer && frameUrl) headers.referer = frameUrl;
  addItem(details.tabId, {
    url: details.url,
    kind: kind,
    mime: ct.split(';')[0] || null,
    headers: headers || null,
    frameUrl: frameUrl,
    size: size || null,
    how: 'network',
  });
}

function cleanup(details) {
  pendingHeaders.delete(details.requestId);
}

try {
  // Chrome needs 'extraHeaders' to expose Cookie / Referer.
  ext.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, filter, ['requestHeaders', 'extraHeaders']);
} catch (e) {
  ext.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, filter, ['requestHeaders']);
}
ext.webRequest.onHeadersReceived.addListener(onHeadersReceived, filter, ['responseHeaders']);
ext.webRequest.onErrorOccurred.addListener(cleanup, filter);
ext.webRequest.onCompleted.addListener(cleanup, filter);

ext.tabs.onRemoved.addListener(function (tabId) {
  tabs.delete(tabId);
  persist();
});

// ---- messages from content scripts / popup ----
ext.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return undefined;
  var tabId = sender.tab ? sender.tab.id : msg.tabId;

  if (msg.type === 'anycast:found' && tabId != null) {
    var t = tabState(tabId);
    if (msg.isTop) {
      t.page = msg.frameUrl || t.page;
      if (msg.title) t.title = msg.title;
    }
    if (msg.drm) t.drm = msg.drm;
    if (msg.mse) t.mse = true;
    (msg.items || []).forEach(function (i) {
      var kind = i.kind || classify(i.url, '');
      if (!kind) return;
      addItem(tabId, { url: i.url, kind: kind, headers: null, frameUrl: msg.frameUrl, how: i.how || 'page' });
    });
    updateBadge(tabId);
    sendResponse({ count: rank(t).length });
    return undefined;
  }

  if (msg.type === 'anycast:getTab') {
    var st = tabs.get(msg.tabId) || { page: null, title: null, drm: null, mse: false, items: [] };
    sendResponse({ page: st.page, title: st.title, drm: st.drm, mse: st.mse, items: rank(st) });
    return undefined;
  }

  if (msg.type === 'anycast:openPanel' && tabId != null) {
    ext.tabs.create({ url: ext.runtime.getURL('popup.html?tab=' + tabId), index: sender.tab ? sender.tab.index + 1 : undefined });
    return undefined;
  }
  return undefined;
});
