/*
 * Isolated-world bridge: forwards sniffer findings to the background worker and
 * shows a floating "投屏" button in the top frame once something castable was
 * found (extension popups are buried in menus on mobile browsers).
 */
(function () {
  'use strict';
  var ext = globalThis.browser || globalThis.chrome;
  if (!ext || !ext.runtime || !ext.runtime.id) return;
  var isTop = window === window.top;
  var gotHello = false;
  var button = null;

  function send(msg) {
    try {
      var p = ext.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(function () {});
      return p;
    } catch (e) {
      return null;
    }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.__anycast !== 1) return;
    var d = e.data;
    if (d.hello) {
      gotHello = true;
      return;
    }
    var p = send({
      type: 'anycast:found',
      items: d.items || [],
      drm: d.drm || null,
      mse: Boolean(d.mse),
      frameUrl: location.href,
      isTop: isTop,
      title: isTop ? document.title : null,
    });
    if (p && p.then) p.then(function (r) { if (r && r.count) showButton(r.count); });
  });

  // Browsers without `world: "MAIN"` support: inject the sniffer as a page script.
  setTimeout(function () {
    if (gotHello || window.__anycastInjected) return;
    window.__anycastInjected = true;
    try {
      var s = document.createElement('script');
      s.src = ext.runtime.getURL('sniffer.js');
      s.onload = function () { s.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* CSP may block it; webRequest sniffing still works */ }
  }, 0);

  function showButton(count) {
    if (!isTop || !document.body) return;
    ext.storage.local.get({ floatingButton: true }).then(function (s) {
      if (!s.floatingButton) return;
      if (button) {
        button.label.textContent = '投屏 (' + count + ')';
        return;
      }
      var host = document.createElement('div');
      host.style.cssText = 'position:fixed;right:14px;bottom:84px;z-index:2147483646;';
      var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
      var btn = document.createElement('button');
      btn.setAttribute('aria-label', 'AnyCast 投屏到电视');
      btn.style.cssText = 'display:flex;align-items:center;gap:6px;border:0;border-radius:999px;padding:10px 14px;' +
        'background:#0f766e;color:#fff;font:600 14px -apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);cursor:pointer;';
      var icon = document.createElement('span');
      icon.textContent = '📺';
      var label = document.createElement('span');
      label.textContent = '投屏 (' + count + ')';
      btn.appendChild(icon);
      btn.appendChild(label);
      btn.addEventListener('click', function () { send({ type: 'anycast:openPanel' }); });
      var close = document.createElement('span');
      close.textContent = '×';
      close.setAttribute('role', 'button');
      close.setAttribute('aria-label', '隐藏');
      close.style.cssText = 'margin-left:4px;opacity:.8;font-size:16px;';
      close.addEventListener('click', function (e) {
        e.stopPropagation();
        host.remove();
      });
      btn.appendChild(close);
      root.appendChild(btn);
      document.body.appendChild(host);
      button = { host: host, label: label };
    });
  }
})();
