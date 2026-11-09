'use strict';
// A fake video website with the anti-hotlinking tricks that make real sites
// "uncastable": Referer + Cookie checks, relative playlist URIs, AES-128 keys,
// TS segments disguised as PNG files, DASH templates, a DRM-protected stream,
// and pages that only reveal the stream URL inside scripts / iframes.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'sid=secret-session';
const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

function tsSegment(n, packets = 40) {
  const buf = Buffer.alloc(188 * packets, 0xff);
  for (let i = 0; i < packets; i++) {
    buf[i * 188] = 0x47;
    buf[i * 188 + 1] = 0x40;
    buf[i * 188 + 3] = 0x10 | (i & 0x0f);
    buf[i * 188 + 4] = n;
  }
  return buf;
}

function fakeMp4(size = 64 * 1024) {
  const buf = Buffer.alloc(size, 0);
  buf.writeUInt32BE(24, 0);
  buf.write('ftypisom', 4, 'latin1');
  buf.writeUInt32BE(0x200, 12);
  buf.write('isomiso2', 16, 'latin1');
  for (let i = 24; i < size; i++) buf[i] = i % 251;
  return buf;
}

const PNG_HEADER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(112, 0x11), // pretend IHDR/IDAT/IEND chunks
]);

const MP4 = fakeMp4();

function startOrigin({ realDir = null } = {}) {
  const hits = [];
  let base = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://origin');
    const p = url.pathname;
    hits.push({ path: p, referer: req.headers.referer || null, cookie: req.headers.cookie || null, range: req.headers.range || null });

    const protectedOk = () =>
      String(req.headers.referer || '').startsWith(`${base}/`) && String(req.headers.cookie || '').includes(COOKIE);
    const deny = () => {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('hotlinking denied');
    };
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const sendRange = (buf, type) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (!m) return send(200, type, buf, { 'Accept-Ranges': 'bytes' });
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      if (start >= buf.length) return send(416, 'text/plain', Buffer.from(''), { 'Content-Range': `bytes */${buf.length}` });
      return send(206, type, buf.subarray(start, end + 1), {
        'Content-Range': `bytes ${start}-${end}/${buf.length}`,
        'Accept-Ranges': 'bytes',
      });
    };

    // ---- pages ----
    if (p === '/watch.html') {
      return send(200, 'text/html; charset=utf-8', Buffer.from(`<!doctype html><html><head><title>测试剧集 第1集</title></head>
<body><div id="player"></div><script>
  var playerConfig = {"title":"测试剧集","hlsUrl":"${base.replace(/\//g, '\\/')}\\/hls\\/master.m3u8"};
</script></body></html>`));
    }
    if (p === '/embed.html') {
      return send(200, 'text/html; charset=utf-8', Buffer.from(`<!doctype html><html><head><title>嵌入页</title></head>
<body><iframe src="/player.html?id=7" allowfullscreen></iframe></body></html>`));
    }
    if (p === '/player.html') {
      return send(200, 'text/html; charset=utf-8', Buffer.from(`<!doctype html><html><body>
<video controls><source src="/media/video.mp4" type="video/mp4"></video></body></html>`));
    }
    if (p === '/mse.html') {
      // Plays HLS through MediaSource (blob: URL) like hls.js would.
      return send(200, 'text/html; charset=utf-8', Buffer.from(`<!doctype html><html><head><title>MSE 播放页</title></head>
<body><video id="v" muted playsinline></video><script>
  fetch('/hls/master.m3u8', { credentials: 'include' }).then(function (r) { return r.text(); }).then(function () {
    var ms = new MediaSource();
    document.getElementById('v').src = URL.createObjectURL(ms);
    document.title = 'MSE 播放页 ready';
  });
</script></body></html>`), { 'Set-Cookie': `${COOKIE}; Path=/` });
    }
    if (p === '/drm.html') {
      return send(200, 'text/html; charset=utf-8', Buffer.from(`<!doctype html><html><head><title>DRM 页面</title></head>
<body><video id="v"></video><script>
  navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }])
    .catch(function () {}).finally(function () { document.title = 'DRM ready'; });
</script></body></html>`));
    }
    if (p === '/set-cookie') {
      return send(200, 'text/plain', Buffer.from('ok'), { 'Set-Cookie': `${COOKIE}; Path=/` });
    }

    // ---- HLS (protected) ----
    if (p === '/hls/master.m3u8') {
      if (!protectedOk()) return deny();
      return send(200, 'application/vnd.apple.mpegurl', Buffer.from(
        '#EXTM3U\n#EXT-X-VERSION:3\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720/index.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360/index.m3u8\n',
      ));
    }
    if (/^\/hls\/(720|360)\/index\.m3u8$/.test(p)) {
      if (!protectedOk()) return deny();
      return send(200, 'application/vnd.apple.mpegurl', Buffer.from(
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' +
        '#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.png\n#EXTINF:4.0,\n/hls/720/seg2.ts?token=abc\n#EXT-X-ENDLIST\n',
      ));
    }
    if (p === '/hls/enc/index.m3u8') {
      if (!protectedOk()) return deny();
      return send(200, 'application/vnd.apple.mpegurl', Buffer.from(
        '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x0\n' +
        '#EXTINF:4.0,\n../720/seg0.ts\n#EXT-X-ENDLIST\n',
      ));
    }
    if (p === '/hls/key.bin') {
      if (!protectedOk()) return deny();
      return send(200, 'application/octet-stream', KEY);
    }
    let m = /^\/hls\/\d+\/seg(\d)\.(ts|png)$/.exec(p);
    if (m) {
      if (!protectedOk()) return deny();
      const seg = tsSegment(Number(m[1]));
      if (m[2] === 'png') return send(200, 'image/png', Buffer.concat([PNG_HEADER, seg]));
      return send(200, 'video/mp2t', seg);
    }

    // ---- HLS (open CDN, no protection) ----
    if (p === '/open/index.m3u8') {
      return send(200, 'application/vnd.apple.mpegurl', Buffer.from(
        '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n',
      ));
    }
    m = /^\/open\/seg(\d)\.ts$/.exec(p);
    if (m) return send(200, 'video/mp2t', tsSegment(Number(m[1])));
    if (p === '/open/disguised.m3u8') {
      return send(200, 'application/vnd.apple.mpegurl', Buffer.from(
        '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nimg0.png\n#EXTINF:4.0,\nimg1.png\n#EXT-X-ENDLIST\n',
      ));
    }
    m = /^\/open\/img(\d)\.png$/.exec(p);
    if (m) return send(200, 'image/png', Buffer.concat([PNG_HEADER, tsSegment(Number(m[1]))]));

    // ---- DRM ----
    if (p === '/drm/master.m3u8') {
      return send(200, 'application/vnd.apple.mpegurl', Buffer.from(
        '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' +
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id-123",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n' +
        '#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n',
      ));
    }

    // ---- progressive ----
    if (p === '/media/video.mp4') {
      if (!protectedOk()) return deny();
      return sendRange(MP4, 'video/mp4');
    }
    if (p === '/media/open.mp4') return sendRange(MP4, 'video/mp4');
    if (p === '/media/disguised') return sendRange(MP4, 'application/octet-stream');

    // ---- DASH (protected; template based) ----
    if (p === '/dash/manifest.mpd') {
      if (!protectedOk()) return deny();
      return send(200, 'application/dash+xml', Buffer.from(`<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period id="1">
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate initialization="v/init.mp4" media="v/seg-$Number$.m4s" startNumber="1" duration="4" timescale="1"/>
      <Representation id="v1" bandwidth="800000" codecs="avc1.42E01E" width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>`));
    }
    m = /^\/dash\/v\/(init\.mp4|seg-\d+\.m4s)$/.exec(p);
    if (m) {
      if (!protectedOk()) return deny();
      return send(200, 'video/mp4', fakeMp4(4096));
    }

    // ---- real media generated by ffmpeg (for transcode tests) ----
    if (realDir && p.startsWith('/real/')) {
      if (!protectedOk()) return deny();
      const file = path.join(realDir, path.basename(p));
      if (!fs.existsSync(file)) return send(404, 'text/plain', Buffer.from('nope'));
      const buf = fs.readFileSync(file);
      const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
        : file.endsWith('.ts') ? 'video/mp2t'
        : file.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4';
      return sendRange(buf, type);
    }

    return send(404, 'text/plain', Buffer.from('not found'));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        hits,
        cookie: COOKIE,
        key: KEY,
        // Headers a browser on watch.html would have sent.
        browserHeaders: (page = '/watch.html') => ({ referer: `${base}${page}`, cookie: COOKIE }),
        close: () => {
          server.closeAllConnections?.();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

module.exports = { startOrigin, tsSegment, PNG_HEADER, COOKIE };
