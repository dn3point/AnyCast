'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startOrigin, PNG_HEADER } = require('./fixtures/origin');
const { startGateway } = require('./helpers');

let origin;
let g;
test.before(async () => {
  origin = await startOrigin();
  g = await startGateway();
});
test.after(async () => {
  await g.gw.close();
  await origin.close();
});

function relayFor(url, headers, kind) {
  const src = g.gw.relay.createSource({ url, headers, kind });
  return g.gw.relay.mainUrl(g.base, src);
}

test('origin really blocks a TV-style request (sanity check)', async () => {
  const res = await fetch(`${origin.base}/hls/master.m3u8`);
  assert.equal(res.status, 403);
});

test('HLS through the relay: master -> variant -> segments, all with browser context', async () => {
  const master = relayFor(`${origin.base}/hls/master.m3u8`, origin.browserHeaders(), 'hls');
  const m = await fetch(master);
  assert.equal(m.status, 200);
  assert.equal(m.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.equal(m.headers.get('access-control-allow-origin'), '*');
  const masterText = await m.text();
  const variant = masterText.split('\n').find((l) => l.startsWith('http'));
  assert.ok(variant.startsWith(`${g.base}/r/`), variant);
  assert.ok(variant.endsWith('/index.m3u8'), 'keeps a .m3u8 file name for picky TVs');

  const v = await (await fetch(variant)).text();
  const segs = v.split('\n').filter((l) => l.startsWith('http'));
  assert.equal(segs.length, 3);
  assert.ok(segs[1].endsWith('.ts'), `disguised .png segment gets a .ts name: ${segs[1]}`);

  for (const s of segs) {
    const r = await fetch(s);
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf[0], 0x47, 'MPEG-TS sync byte at offset 0');
    assert.equal(buf[188], 0x47);
    assert.equal(r.headers.get('content-type'), 'video/mp2t');
  }
  const segHits = origin.hits.filter((h) => /seg\d/.test(h.path));
  assert.ok(segHits.every((h) => h.cookie === origin.cookie && h.referer.startsWith(origin.base)));
  assert.ok(segHits.some((h) => h.path.endsWith('seg2.ts')), 'query-string segment resolved');
});

test('disguised segment: fake PNG header stripped, content-length adjusted', async () => {
  const src = g.gw.relay.createSource({ url: `${origin.base}/open/disguised.m3u8`, kind: 'hls' });
  const pl = await (await fetch(g.gw.relay.mainUrl(g.base, src))).text();
  const seg = pl.split('\n').find((l) => l.startsWith('http'));
  const r = await fetch(seg);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf[0], 0x47);
  assert.equal(Number(r.headers.get('content-length')), buf.length);
  assert.equal(buf.length, 188 * 40);
  assert.ok(PNG_HEADER.length > 0);
});

test('AES-128 key URI is relayed', async () => {
  const src = g.gw.relay.createSource({ url: `${origin.base}/hls/enc/index.m3u8`, headers: origin.browserHeaders(), kind: 'hls' });
  const pl = await (await fetch(g.gw.relay.mainUrl(g.base, src))).text();
  const keyUrl = /URI="([^"]+)"/.exec(pl)[1];
  assert.ok(keyUrl.startsWith(g.base));
  const key = Buffer.from(await (await fetch(keyUrl)).arrayBuffer());
  assert.deepEqual(key, origin.key);
});

test('progressive MP4: Range requests pass through, DLNA headers present', async () => {
  const url = relayFor(`${origin.base}/media/video.mp4`, origin.browserHeaders());
  const r = await fetch(url, { headers: { range: 'bytes=100-199', 'getcontentFeatures.dlna.org': '1' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/65536');
  assert.match(r.headers.get('contentfeatures.dlna.org'), /DLNA\.ORG_OP=01/);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '65536');
});

test('generic content-type gets a media type from the extension / sniffing', async () => {
  const url = relayFor(`${origin.base}/media/disguised`, {});
  const r = await fetch(url);
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.toString('latin1', 4, 8), 'ftyp');
});

test('DASH: template segments resolve through a mapped directory', async () => {
  const url = relayFor(`${origin.base}/dash/manifest.mpd`, origin.browserHeaders('/dash.html'), 'dash');
  const r = await fetch(url);
  assert.equal(r.headers.get('content-type'), 'application/dash+xml');
  const mpd = await r.text();
  const base = /<BaseURL>([^<]+)<\/BaseURL>/.exec(mpd)[1];
  assert.match(base, /\/r\/[\w-]+\/d0\/$/);
  const seg = await fetch(`${base}v/seg-2.m4s`);
  assert.equal(seg.status, 200);
  const init = await fetch(`${base}v/init.mp4`);
  assert.equal(init.status, 200);
  const escape = await fetch(`${base}..%2f..%2fwatch.html`);
  assert.notEqual(escape.status, 200);
});

test('upstream errors are passed through; unknown sources are 404', async () => {
  const url = relayFor(`${origin.base}/hls/master.m3u8`, {}, 'hls'); // no cookie -> 403
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(`${g.base}/r/nope/0/x.m3u8`)).status, 404);
});
