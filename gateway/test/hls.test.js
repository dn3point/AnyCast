'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteHlsPlaylist, inspectHls, isHlsPlaylist } = require('../src/proxy/hls');
const { detectDrm } = require('../src/media');

const map = (abs, kind) => `http://gw/${kind}/${encodeURIComponent(abs)}`;

test('master playlist: variants and EXT-X-MEDIA become relay playlists', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="zh",URI="audio/zh.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,AUDIO="aud"',
    '720p/index.m3u8?sign=xyz',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="iframe.m3u8"',
  ].join('\n');
  const out = rewriteHlsPlaylist(master, 'https://cdn.example.com/v/master.m3u8', map);
  assert.match(out, /URI="http:\/\/gw\/playlist\/https%3A%2F%2Fcdn\.example\.com%2Fv%2Faudio%2Fzh\.m3u8"/);
  assert.match(out, /^http:\/\/gw\/playlist\/https%3A%2F%2Fcdn\.example\.com%2Fv%2F720p%2Findex\.m3u8%3Fsign%3Dxyz$/m);
  assert.match(out, /URI="http:\/\/gw\/playlist\/https%3A%2F%2Fcdn\.example\.com%2Fv%2Fiframe\.m3u8"/);
  assert.ok(out.startsWith('#EXTM3U'));
});

test('media playlist: segments, keys, init maps; absolute and root-relative URIs', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1.key",IV=0x1',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:6.0,',
    'seg-1.m4s',
    '#EXTINF:6.0,',
    'https://other.example.net/seg-2.m4s',
    '#EXT-X-ENDLIST',
  ].join('\r\n');
  const out = rewriteHlsPlaylist(media, 'https://cdn.example.com/a/b/index.m3u8', map);
  assert.match(out, /URI="http:\/\/gw\/key\/https%3A%2F%2Fcdn\.example\.com%2Fkeys%2Fk1\.key"/);
  assert.match(out, /URI="http:\/\/gw\/map\/https%3A%2F%2Fcdn\.example\.com%2Fa%2Fb%2Finit\.mp4"/);
  assert.match(out, /^http:\/\/gw\/segment\/https%3A%2F%2Fcdn\.example\.com%2Fa%2Fb%2Fseg-1\.m4s$/m);
  assert.match(out, /^http:\/\/gw\/segment\/https%3A%2F%2Fother\.example\.net%2Fseg-2\.m4s$/m);
  assert.match(out, /#EXT-X-ENDLIST/);
});

test('FairPlay skd:// key URIs are left alone and flagged as DRM', () => {
  const pl = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\ns.ts\n';
  const out = rewriteHlsPlaylist(pl, 'https://x/y.m3u8', map);
  assert.match(out, /URI="skd:\/\/abc"/);
  assert.equal(detectDrm(pl), 'FairPlay');
  assert.equal(detectDrm('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n'), null, 'AES-128 is not DRM');
  assert.equal(detectDrm('<MPD><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></MPD>'), 'Widevine');
});

test('inspectHls: master vs media, live detection, keys', () => {
  const master = inspectHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1920x1080\nhi.m3u8\n', 'http://h/p/m.m3u8');
  assert.equal(master.isMaster, true);
  assert.equal(master.variants[0].url, 'http://h/p/hi.m3u8');
  assert.equal(master.variants[0].height, 1080);
  const live = inspectHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:2,\na.ts\n', 'http://h/p/m.m3u8');
  assert.equal(live.live, true);
  assert.deepEqual(live.keys, ['http://h/p/k']);
  assert.deepEqual(live.segments, ['http://h/p/a.ts']);
  assert.equal(isHlsPlaylist('﻿  #EXTM3U\n'), true);
});
