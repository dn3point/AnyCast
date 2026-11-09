/* Shared helpers for extension pages (popup / options). */
var ext = globalThis.browser || globalThis.chrome;

var DEFAULTS = { gateway: '', token: '', floatingButton: true };

function getSettings() {
  return ext.storage.local.get(DEFAULTS).then(function (s) {
    return Object.assign({}, DEFAULTS, s);
  });
}

function gatewayFetch(settings, method, path, body) {
  var base = String(settings.gateway || '').replace(/\/+$/, '');
  if (!base) return Promise.reject(new Error('请先在设置中填写网关地址'));
  var headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (settings.token) headers.Authorization = 'Bearer ' + settings.token;
  return fetch(base + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var e = new Error(json.error || ('HTTP ' + res.status));
          e.code = json.code;
          throw e;
        }
        return json;
      });
    }, function () {
      throw new Error('连不上网关 ' + base + '，请确认手机和网关在同一 Wi-Fi');
    });
}
