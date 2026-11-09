'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteMpd, dirOf } = require('../src/proxy/dash');

const dirs = [];
const mapDir = (d) => {
  if (!dirs.includes(d)) dirs.push(d);
  return `http://gw/r/s/d${dirs.indexOf(d)}/`;
};

test('manifest without BaseURL gets an MPD-level relay BaseURL', () => {
  const mpd = '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><SegmentTemplate media="v/$Number$.m4s" initialization="v/init.mp4"/></AdaptationSet></Period></MPD>';
  const out = rewriteMpd(mpd, 'https://cdn.example.com/show/ep1/manifest.mpd?t=1', mapDir);
  assert.match(out, /<MPD[^>]*>\s*<BaseURL>http:\/\/gw\/r\/s\/d\d+\/<\/BaseURL>/);
  assert.ok(dirs.includes('https://cdn.example.com/show/ep1/'));
  assert.match(out, /media="v\/\$Number\$\.m4s"/, 'templates stay relative');
});

test('absolute BaseURL and absolute template attributes are mapped', () => {
  const mpd = '<MPD><BaseURL>https://a.example.com/x/</BaseURL><Period><AdaptationSet><BaseURL>video/</BaseURL>' +
    '<SegmentTemplate media="https://b.example.com/seg/$Number$.m4s?sig=1&amp;x=2"/></AdaptationSet></Period></MPD>';
  const out = rewriteMpd(mpd, 'https://cdn/m.mpd', mapDir);
  const a = dirs.indexOf('https://a.example.com/x/');
  const b = dirs.indexOf('https://b.example.com/seg/');
  assert.ok(a >= 0 && b >= 0);
  assert.match(out, new RegExp(`<BaseURL>http://gw/r/s/d${a}/</BaseURL>`));
  assert.match(out, /<BaseURL>video\/<\/BaseURL>/, 'nested relative BaseURL untouched');
  assert.match(out, new RegExp(`media="http://gw/r/s/d${b}/\\$Number\\$\\.m4s\\?sig=1&amp;x=2"`));
  assert.equal((out.match(/<BaseURL>/g) || []).length, 2, 'no extra BaseURL inserted');
});

test('dirOf strips file and query', () => {
  assert.equal(dirOf('https://h/a/b/c.mpd?x=1#f'), 'https://h/a/b/');
});
