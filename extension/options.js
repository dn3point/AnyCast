(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function show(text, err) {
    $('msg').hidden = false;
    $('msg').className = 'msg' + (err ? ' err' : '');
    $('msg').textContent = text;
  }
  getSettings().then(function (s) {
    $('gateway').value = s.gateway;
    $('token').value = s.token;
    $('floating').checked = s.floatingButton;
  });
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var gw = $('gateway').value.trim().replace(/\/+$/, '');
    if (gw && !/^https?:\/\//.test(gw)) gw = 'http://' + gw;
    var s = { gateway: gw, token: $('token').value.trim(), floatingButton: $('floating').checked };
    ext.storage.local.set(s).then(function () {
      return gatewayFetch(s, 'GET', '/api/info');
    }).then(function (info) {
      var f = info.features || {};
      show('已保存。网关 v' + info.version + '，转封装 ' + (f.ffmpeg ? '✓' : '✗') + '，深度解析 ' + (f.headless || f.ytdlp ? '✓' : '✗'));
    }).catch(function (err) { show('已保存，但测试失败：' + err.message, true); });
  });
})();
