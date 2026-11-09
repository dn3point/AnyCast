'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CastManager, localAddressFor } = require('../src/cast');
const { startFakeTv } = require('../tools/fake-dlna-tv');
const { startGateway } = require('./helpers');
const { ffmpegAvailable } = require('../src/transcode');

const fakeDevice = (type, supports) => ({ type, renderer: { supports: async () => supports } });
const cm = new CastManager({ devices: null, relay: null, port: 1, defaultHost: '127.0.0.1' });

test('DRM is refused before anything is sent to the TV', async () => {
  await assert.rejects(cm.plan({ drm: 'Widevine', kind: 'dash', mime: 'application/dash+xml', headers: {} }, fakeDevice('dlna', 'yes')), { code: 'DRM' });
});

test('DASH on a DLNA TV without DASH support is remuxed', { skip: !ffmpegAvailable() }, async () => {
  const mode = await cm.plan({ url: 'http://127.0.0.1:9/x.mpd', kind: 'dash', mime: 'application/dash+xml', headers: {} }, fakeDevice('dlna', 'unknown'));
  assert.equal(mode, 'transcode');
});

test('format the TV says it cannot play (sink protocols) is remuxed', { skip: !ffmpegAvailable() }, async () => {
  const mode = await cm.plan({ url: 'http://127.0.0.1:9/x.m3u8', kind: 'hls', mime: 'application/vnd.apple.mpegurl', headers: {} }, fakeDevice('dlna', 'no'));
  assert.equal(mode, 'transcode');
});

test('explicit modes are honoured; split tracks cannot be proxied', async () => {
  assert.equal(await cm.plan({ kind: 'hls', headers: {} }, fakeDevice('dlna', 'yes'), 'proxy'), 'proxy');
  await assert.rejects(cm.plan({ kind: 'progressive', audioUrl: 'x', headers: {} }, fakeDevice('dlna', 'yes'), 'proxy'), { code: 'NEEDS_FFMPEG' });
});

test('unreachable direct URL falls back to proxy', async () => {
  const mode = await cm.plan({ url: 'http://127.0.0.1:9/x.mp4', kind: 'progressive', mime: 'video/mp4', headers: {} }, fakeDevice('dlna', 'yes'));
  assert.equal(mode, 'proxy');
});

test('localAddressFor picks loopback for local devices', () => {
  assert.equal(localAddressFor('127.0.0.1', '10.0.0.2'), '127.0.0.1');
  assert.equal(localAddressFor('not-an-ip', '10.0.0.2'), '10.0.0.2');
});

test('SSDP discovery finds a TV (unicast M-SEARCH, works without multicast)', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tv = await startFakeTv({ name: '自动发现的电视', ssdp: true, ssdpPort: port });
  const g = await startGateway({ discovery: true, ssdpTargets: [`127.0.0.1:${port}`] });
  try {
    let found = null;
    for (let i = 0; i < 40 && !found; i++) {
      await new Promise((r) => setTimeout(r, 100));
      found = (await g.api('GET', '/api/devices')).body.devices.find((d) => d.name === '自动发现的电视');
      if (!found) g.gw.devices.refresh();
    }
    assert.ok(found, 'TV discovered via SSDP');
    assert.equal(found.type, 'dlna');
  } finally {
    await g.gw.close();
    await tv.close();
  }
});
