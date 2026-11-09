'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractFromHtml } = require('../src/extract/html');
const tools = require('../src/extract/tools');
const { detectKind, sniffKind, findTsSync, isImageSignature } = require('../src/media');
const { tsSegment, PNG_HEADER } = require('./fixtures/origin');

test('HTML extraction: video tags, og:video, escaped JSON, iframes', () => {
  const html = `<html><head><title>第 3 集</title>
    <meta property="og:video:url" content="https://cdn.example.com/og.mp4">
    </head><body>
    <video src="/local/clip.webm"></video>
    <script>window.__DATA__={"play":{"hlsUrl":"https:\\/\\/v.example.com\\/live\\/ch1.m3u8?auth=1\\u0026t=2"}};
    var ad = "https://ads.example.com/banner.jpg";</script>
    <iframe data-src="//player.example.org/embed/77"></iframe>
    </body></html>`;
  const r = extractFromHtml(html, 'https://site.example.com/show/3');
  const urls = r.candidates.map((c) => c.url);
  assert.equal(r.title, '第 3 集');
  assert.ok(urls.includes('https://site.example.com/local/clip.webm'));
  assert.ok(urls.includes('https://cdn.example.com/og.mp4'));
  assert.ok(urls.includes('https://v.example.com/live/ch1.m3u8?auth=1&t=2'), urls.join('\n'));
  assert.ok(!urls.some((u) => u.endsWith('.jpg')));
  assert.deepEqual(r.embeds, ['https://player.example.org/embed/77']);
});

test('kind detection by URL, content-type and bytes', () => {
  assert.equal(detectKind('https://h/a/index.m3u8?x=1'), 'hls');
  assert.equal(detectKind('https://h/a/manifest', 'application/dash+xml'), 'dash');
  assert.equal(detectKind('https://h/a/play?type=m3u8'), 'hls');
  assert.equal(detectKind('https://h/a/v.mp4'), 'progressive');
  assert.equal(detectKind('https://h/a/page.html'), null);
  assert.equal(sniffKind(Buffer.from('﻿#EXTM3U\n')), 'hls');
  assert.equal(sniffKind(Buffer.from('<?xml version="1.0"?><MPD type="static">')), 'dash');
  assert.equal(sniffKind(tsSegment(0)), 'progressive');
});

test('fake image header detection on TS segments', () => {
  const disguised = Buffer.concat([PNG_HEADER, tsSegment(1)]);
  assert.equal(isImageSignature(disguised), true);
  assert.equal(findTsSync(disguised), PNG_HEADER.length);
  assert.equal(findTsSync(Buffer.alloc(1000, 0x47 - 1)), -1);
});

test('yt-dlp JSON is turned into candidates (split audio/video included)', () => {
  const info = {
    title: '演示视频',
    http_headers: { 'User-Agent': 'UA', Referer: 'https://site/' },
    requested_formats: [
      { url: 'https://cdn/v.mp4', vcodec: 'avc1', acodec: 'none', height: 1080, protocol: 'https' },
      { url: 'https://cdn/a.m4a', vcodec: 'none', acodec: 'mp4a', protocol: 'https' },
    ],
    formats: [
      { url: 'https://cdn/muxed-360.mp4', vcodec: 'avc1', acodec: 'mp4a', height: 360, ext: 'mp4', protocol: 'https' },
      { url: 'https://cdn/hls/720.m3u8', manifest_url: 'https://cdn/hls/master.m3u8', vcodec: 'avc1', acodec: 'mp4a', height: 720, ext: 'mp4', protocol: 'm3u8_native' },
    ],
  };
  const c = tools.candidatesFromYtdlp(info);
  assert.equal(c[0].url, 'https://cdn/v.mp4');
  assert.equal(c[0].audioUrl, 'https://cdn/a.m4a');
  assert.equal(c[0].headers.Referer, 'https://site/');
  const hls = c.find((x) => x.kind === 'hls');
  assert.equal(hls.url, 'https://cdn/hls/master.m3u8', 'HLS formats use the master manifest');
});

test('yt-dlp binary is used when present on the gateway', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycast-ytdlp-'));
  const bin = path.join(dir, 'yt-dlp');
  fs.writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
echo '{"title":"stub","url":"https://cdn.example/x.m3u8","protocol":"m3u8_native","http_headers":{"Referer":"https://p/"}}'
`, { mode: 0o755 });
  const prev = process.env.ANYCAST_YTDLP;
  process.env.ANYCAST_YTDLP = bin;
  tools.resetToolCache();
  try {
    assert.equal(tools.ytdlpAvailable(), true);
    const c = await tools.extractWithYtdlp('https://p/watch');
    assert.equal(c[0].url, 'https://cdn.example/x.m3u8');
    assert.equal(c[0].kind, 'hls');
  } finally {
    if (prev === undefined) delete process.env.ANYCAST_YTDLP;
    else process.env.ANYCAST_YTDLP = prev;
    tools.resetToolCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
