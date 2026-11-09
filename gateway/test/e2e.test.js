'use strict';
// End-to-end: fake website (anti-hotlinking) + AnyCast gateway + simulated TVs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startOrigin } = require('./fixtures/origin');
const { startFakeChromecast } = require('./fixtures/fake-chromecast');
const { startFakeTv } = require('../tools/fake-dlna-tv');
const { startGateway } = require('./helpers');
const { ffmpegAvailable } = require('../src/transcode');

const HAS_FFMPEG = ffmpegAvailable();
let realDir = null;

function makeRealMedia() {
  realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycast-real-'));
  const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: realDir });
  const src = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=3'];
  ff([...src, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', 'index.m3u8']);
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', 'video.mp4']);
  ff(['-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'aac', 'audio.m4a']);
}

let origin;
let g;
let tv;
test.before(async () => {
  if (HAS_FFMPEG) makeRealMedia();
  origin = await startOrigin({ realDir });
  g = await startGateway();
  tv = await startFakeTv({ name: '客厅电视（模拟）' });
});
test.after(async () => {
  await g.gw.close();
  await tv.close();
  await origin.close();
  if (realDir) fs.rmSync(realDir, { recursive: true, force: true });
});

let tvId;
test('manually add a DLNA TV by its description URL', async () => {
  const r = await g.api('POST', '/api/devices', { location: tv.location });
  assert.equal(r.status, 200);
  tvId = r.body.device.id;
  const list = await g.api('GET', '/api/devices');
  const d = list.body.devices.find((x) => x.id === tvId);
  assert.equal(d.name, '客厅电视（模拟）');
  assert.equal(d.type, 'dlna');
});

async function castAndWait(media, mode = 'auto') {
  const playback = tv.waitForPlayback();
  const r = await g.api('POST', '/api/cast', { deviceId: tvId, media, mode });
  if (r.status !== 200) return { r };
  return { r, playback: await playback };
}

test('the problem: handing the raw URL to the TV fails (403 hotlink protection)', async () => {
  const { r, playback } = await castAndWait(
    { url: `${origin.base}/hls/master.m3u8`, headers: origin.browserHeaders() },
    'direct',
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.session.mode, 'direct');
  assert.equal(playback.ok, false);
  assert.match(playback.error, /403/);
});

test('AnyCast auto mode: protected HLS is relayed and the TV plays it', async () => {
  const { r, playback } = await castAndWait({
    url: `${origin.base}/hls/master.m3u8`,
    headers: origin.browserHeaders(),
    title: '测试剧集 第1集',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.session.mode, 'proxy');
  assert.equal(r.body.session.kind, 'hls');
  assert.ok(playback.ok, playback.error);
  assert.equal(playback.segments, 3);
  assert.match(tv.state.meta, /测试剧集 第1集/, 'DIDL title sent to the TV');
  assert.ok(tv.state.fetched.every((f) => f.url.startsWith(g.base)), 'TV only talked to the gateway');
  const st = await g.api('GET', `/api/sessions/${r.body.session.id}`);
  assert.equal(st.body.status.state, 'playing');
});

test('pageUrl + cookie is enough context (Referer derived from the page)', async () => {
  const { r, playback } = await castAndWait({
    url: `${origin.base}/media/video.mp4`,
    pageUrl: `${origin.base}/watch.html`,
    cookie: origin.cookie,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.session.mode, 'proxy');
  assert.equal(playback.ok, true, playback.error);
  assert.equal(playback.kind, 'mp4');
});

test('open CDN: auto mode casts directly, gateway stays out of the data path', async () => {
  const before = origin.hits.length;
  const { r, playback } = await castAndWait({ url: `${origin.base}/open/index.m3u8` });
  assert.equal(r.body.session.mode, 'direct');
  assert.ok(playback.ok);
  assert.ok(tv.state.fetched.every((f) => f.url.startsWith(origin.base)));
  assert.ok(origin.hits.length > before);
});

test('segments disguised as PNG force proxy mode (relay strips the fake header)', async () => {
  const { r, playback } = await castAndWait({ url: `${origin.base}/open/disguised.m3u8` });
  assert.equal(r.body.session.mode, 'proxy');
  assert.ok(playback.ok, playback.error);
});

test('DRM-protected streams are refused with a clear message', async () => {
  const r = await g.api('POST', '/api/cast', { deviceId: tvId, media: { url: `${origin.base}/drm/master.m3u8` } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'DRM');
  assert.match(r.body.error, /FairPlay/);
});

test('expired / unreachable links give an actionable error', async () => {
  const r = await g.api('POST', '/api/cast', { deviceId: tvId, media: { url: `${origin.base}/hls/master.m3u8` } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'UNREACHABLE');
  assert.match(r.body.error, /HTTP 403/);
});

test('remote control: pause / seek / volume / stop', async () => {
  const { r } = await castAndWait({ url: `${origin.base}/open/index.m3u8` });
  const id = r.body.session.id;
  const ctl = (action, value) => g.api('POST', `/api/sessions/${id}/control`, { action, value });
  assert.equal((await ctl('pause')).status, 200);
  assert.equal(tv.state.transport, 'PAUSED_PLAYBACK');
  await ctl('seek', 125);
  assert.equal(tv.state.position, 125);
  await ctl('volume', 42);
  assert.equal(tv.state.volume, 42);
  const st = await g.api('GET', `/api/sessions/${id}`);
  assert.equal(st.body.status.volume, 42);
  assert.equal(st.body.status.position, 125);
  assert.equal(st.body.status.state, 'paused');
  const stop = await ctl('stop');
  assert.equal(stop.body.ended, true);
  assert.equal((await g.api('GET', `/api/sessions/${id}`)).status, 400);
});

test('extract: finds the stream hidden in a page script', async () => {
  const r = await g.api('POST', '/api/extract', { url: `${origin.base}/watch.html`, cookie: origin.cookie, deep: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, '测试剧集 第1集');
  const top = r.body.candidates[0];
  assert.equal(top.url, `${origin.base}/hls/master.m3u8`);
  assert.equal(top.kind, 'hls');
  assert.equal(top.isMaster, true);
  assert.equal(top.headers.referer, `${origin.base}/watch.html`);
});

test('extract: follows an iframe embed to the real player', async () => {
  const r = await g.api('POST', '/api/extract', { url: `${origin.base}/embed.html`, cookie: origin.cookie, deep: false });
  const top = r.body.candidates[0];
  assert.ok(top, JSON.stringify(r.body));
  assert.equal(top.url, `${origin.base}/media/video.mp4`);
  assert.equal(top.kind, 'progressive');
});

test('extract: validates client-side candidates (bookmarklet hand-off) and drops dead ones', async () => {
  const r = await g.api('POST', '/api/extract', {
    url: `${origin.base}/mse.html`,
    cookie: origin.cookie,
    candidates: [
      { url: `${origin.base}/nope.m3u8` },
      { url: `${origin.base}/hls/720/index.m3u8` },
      { url: `${origin.base}/hls/master.m3u8` },
    ],
  });
  assert.deepEqual(
    r.body.candidates.map((c) => c.url),
    [`${origin.base}/hls/master.m3u8`, `${origin.base}/hls/720/index.m3u8`],
    'master ranked above variant; 404 removed',
  );
});

test('Chromecast: HLS without CORS is relayed (relay adds CORS) and controls work', async () => {
  const cc = await startFakeChromecast();
  try {
    const add = await g.api('POST', '/api/devices', { type: 'chromecast', host: '127.0.0.1', port: cc.port, name: '卧室 Chromecast' });
    const id = add.body.device.id;
    const r = await g.api('POST', '/api/cast', { deviceId: id, media: { url: `${origin.base}/open/index.m3u8`, title: '开放流' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session.mode, 'proxy', 'origin sends no CORS header, so relay is required');
    assert.equal(cc.state.loaded.contentType, 'application/vnd.apple.mpegurl');
    assert.equal(cc.state.fetch.cors, '*');
    assert.equal(cc.state.playerState, 'PLAYING');
    const sid = r.body.session.id;
    await g.api('POST', `/api/sessions/${sid}/control`, { action: 'pause' });
    assert.equal(cc.state.playerState, 'PAUSED');
    await g.api('POST', `/api/sessions/${sid}/control`, { action: 'volume', value: 80 });
    assert.equal(cc.state.volume, 0.8);
    const st = await g.api('GET', `/api/sessions/${sid}`);
    assert.equal(st.body.status.state, 'paused');
    assert.equal(st.body.status.duration, 600);
    assert.ok(cc.state.messages.includes('receiver:LAUNCH'));
  } finally {
    g.gw.devices.get(`cast:127.0.0.1`)?.renderer.close();
    await cc.close();
  }
});

test('web receiver (TV browser): SSE registration, load command, status reports', async () => {
  const ac = new AbortController();
  const res = await fetch(`${g.base}/api/receivers/events?id=tvbrowser1&name=${encodeURIComponent('电视浏览器')}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const events = [];
  let buffer = '';
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buffer += Buffer.from(value).toString();
      let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
        if (data) events.push(JSON.parse(data));
      }
    }
  })();
  const waitFor = async (pred) => {
    for (let k = 0; k < 100; k++) {
      const e = events.find(pred);
      if (e) return e;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('event not received');
  };
  await waitFor((e) => e.id === 'tvbrowser1');
  const devs = (await g.api('GET', '/api/devices')).body.devices;
  assert.ok(devs.some((d) => d.id === 'web:tvbrowser1' && d.type === 'web'));

  const r = await g.api('POST', '/api/cast', {
    deviceId: 'web:tvbrowser1',
    media: { url: `${origin.base}/hls/master.m3u8`, headers: origin.browserHeaders() },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const load = await waitFor((e) => e.type === 'load');
  assert.ok(load.url.startsWith(`${g.base}/r/`));
  assert.equal(load.mime, 'application/vnd.apple.mpegurl');

  await fetch(`${g.base}/api/receivers/tvbrowser1/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'playing', position: 3, duration: 12, volume: 70 }),
  });
  const st = await g.api('GET', `/api/sessions/${r.body.session.id}`);
  assert.deepEqual(st.body.status, { state: 'playing', position: 3, duration: 12, volume: 70 });
  await g.api('POST', `/api/sessions/${r.body.session.id}/control`, { action: 'pause' });
  await waitFor((e) => e.type === 'pause');
  ac.abort();
  await pump;
});

test('transcode: real HLS remuxed to a single MPEG-TS stream', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async () => {
  const { r, playback } = await castAndWait(
    { url: `${origin.base}/real/index.m3u8`, headers: origin.browserHeaders() },
    'transcode',
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.session.mode, 'transcode');
  assert.match(r.body.session.playUrl, /\/t\/\w+\/stream\.ts$/);
  assert.ok(playback.ok, playback.error);
  assert.equal(playback.kind, 'ts');
});

test('transcode: separate video + audio tracks (DASH-style sites) are muxed automatically', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async () => {
  const { r, playback } = await castAndWait({
    url: `${origin.base}/real/video.mp4`,
    audioUrl: `${origin.base}/real/audio.m4a`,
    headers: origin.browserHeaders(),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.session.mode, 'transcode');
  assert.ok(playback.ok, playback.error);
  // Grab the whole stream and check ffmpeg produced both a video and an audio track.
  const ts = Buffer.from(await (await fetch(r.body.session.playUrl)).arrayBuffer());
  const file = path.join(realDir, 'out.ts');
  fs.writeFileSync(file, ts);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]).toString();
  assert.match(probe, /video/);
  assert.match(probe, /audio/);
});
