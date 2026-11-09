/*
 * AnyCast bookmarklet. Served as a template: the phone UI replaces __GATEWAY__,
 * strips comments and joins lines into a javascript: URL. Keep every statement
 * terminated with a semicolon and never rely on line breaks.
 *
 * It cannot hook the page's network stack after the fact, so it collects:
 *  - Resource Timing entries (every URL the page already fetched, incl. m3u8)
 *  - <video>/<source> src (non-blob), plus same-origin iframes recursively
 *  - stream URLs embedded in the HTML / inline scripts
 *  - cross-origin iframe URLs (the gateway extracts those server-side)
 *  - document.cookie, UA, title; and whether a <video> uses EME (DRM)
 * Then it shows a small sheet whose button opens the gateway with the data in
 * the URL fragment (a top-level navigation is allowed from HTTPS pages, unlike
 * fetch() to an http:// LAN address, which is blocked as mixed content).
 */
(function () {
var GW = '__GATEWAY__';
var RE = /\.(m3u8|mpd|mp4|m4v|webm|flv|mov|mkv)(\?|#|$)/i;
var seen = {};
var list = [];
var frames = [];
var drm = false;
function add(u, how) {
  if (!u || typeof u !== 'string' || /^(blob|data|about):/i.test(u)) { return; }
  try { u = new URL(u, location.href).href; } catch (e) { return; }
  if (seen[u]) { return; }
  seen[u] = 1;
  list.push({ url: u, how: how });
}
function scan(win, depth) {
  var d;
  try { d = win.document; } catch (e) { return; }
  try {
    var entries = win.performance && win.performance.getEntriesByType ? win.performance.getEntriesByType('resource') : [];
    for (var i = 0; i < entries.length; i++) {
      var n = entries[i].name;
      if (RE.test(n) || /[?&](type|format)=m3u8/i.test(n)) { add(n, 'perf'); }
    }
  } catch (e) {}
  var vids = d.querySelectorAll('video,audio,source');
  for (var j = 0; j < vids.length; j++) {
    var v = vids[j];
    add(v.currentSrc || v.src || v.getAttribute('data-src'), 'dom');
    if (v.mediaKeys) { drm = true; }
  }
  try {
    var html = d.documentElement.innerHTML.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/');
    var m = html.match(/https?:\/\/[^"'\s<>\\()]+?\.(m3u8|mpd|mp4)(\?[^"'\s<>\\()]*)?/gi) || [];
    for (var k = 0; k < m.length && k < 40; k++) { add(m[k].replace(/&amp;/g, '&'), 'html'); }
  } catch (e) {}
  var ifr = d.querySelectorAll('iframe');
  for (var f = 0; f < ifr.length; f++) {
    var w = null;
    try { w = ifr[f].contentWindow; if (!w.document) { w = null; } } catch (e) { w = null; }
    if (w && depth < 3) { scan(w, depth + 1); }
    else if (ifr[f].src && /^https?:/.test(ifr[f].src)) { frames.push(ifr[f].src); }
  }
}
scan(window, 0);
var payload = { v: 1, page: location.href, title: document.title, ua: navigator.userAgent, cookie: document.cookie, cands: list.slice(0, 30), frames: frames.slice(0, 8), drm: drm };
var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
var href = GW + '/#p=' + b64;
var old = document.getElementById('anycast-sheet');
if (old) { old.parentNode.removeChild(old); }
var box = document.createElement('div');
box.id = 'anycast-sheet';
box.setAttribute('style', 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#fff;color:#15201d;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.35);padding:16px;font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:520px;margin:0 auto;');
var h = document.createElement('div');
h.setAttribute('style', 'font-weight:700;font-size:16px;margin-bottom:4px;');
h.textContent = list.length ? ('AnyCast：找到 ' + list.length + ' 个视频地址') : 'AnyCast：未直接找到视频地址';
var p = document.createElement('div');
p.setAttribute('style', 'color:#5d6b67;font-size:13px;margin-bottom:12px;');
p.textContent = drm ? '注意：此页面使用 DRM 加密，可能无法投屏。' : (list.length ? '点下方按钮，在 AnyCast 里选择电视即可投屏。' : '可以交给网关深度解析；也可以先点播放再试一次。');
var a = document.createElement('a');
a.href = href;
a.target = '_blank';
a.rel = 'noopener';
a.textContent = '打开 AnyCast 投屏';
a.setAttribute('style', 'display:block;text-align:center;background:#0f766e;color:#fff;text-decoration:none;font-weight:600;border-radius:12px;padding:12px;');
var c = document.createElement('button');
c.textContent = '关闭';
c.setAttribute('style', 'display:block;width:100%;margin-top:8px;background:none;border:0;color:#5d6b67;font-size:14px;padding:6px;');
c.onclick = function () { box.parentNode.removeChild(box); };
var zoom = window.innerWidth / (screen.width || window.innerWidth);
if (zoom > 1.3) { box.style.zoom = String(Math.min(zoom, 4)); }
box.appendChild(h);
box.appendChild(p);
box.appendChild(a);
box.appendChild(c);
document.body.appendChild(box);
})();
