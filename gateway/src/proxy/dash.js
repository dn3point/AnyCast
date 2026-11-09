'use strict';
// MPEG-DASH manifest rewriting. Segment URLs in DASH are usually *generated*
// by the player from SegmentTemplate + BaseURL, so instead of rewriting each
// URL we map whole directories: `mapDir(absDir)` returns a relay prefix under
// which any relative path is fetched from the original directory.

const { escapeXml, unescapeXml } = require('../util/xml');

function isMpd(text) {
  return /<MPD[\s>]/.test(String(text).slice(0, 4096));
}

function dirOf(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/[^/]*$/, '');
  return u.toString();
}

/** Map an absolute URL to <relay dir prefix> + <file part>. */
function mapAbsolute(abs, mapDir) {
  const u = new URL(abs);
  const file = u.pathname.replace(/^.*\//, '') + u.search;
  return mapDir(dirOf(abs)) + file;
}

/**
 * @param {string} xml
 * @param {string} mpdUrl absolute URL of the manifest (after redirects)
 * @param {(absDir:string)=>string} mapDir returns an absolute relay URL ending with '/'
 */
function rewriteMpd(xml, mpdUrl, mapDir) {
  let text = String(xml);
  const firstPeriod = text.search(/<Period[\s>]/);

  // 1. BaseURL elements.
  let hasMpdLevelBase = false;
  text = text.replace(/<BaseURL([^>]*)>([\s\S]*?)<\/BaseURL>/g, (m, attrs, inner, offset) => {
    const value = unescapeXml(inner.trim());
    const mpdLevel = firstPeriod === -1 || offset < firstPeriod;
    if (/^https?:\/\//i.test(value)) {
      if (mpdLevel) hasMpdLevelBase = true;
      const mapped = value.endsWith('/') ? mapDir(value) : mapAbsolute(value, mapDir);
      return `<BaseURL${attrs}>${escapeXml(mapped)}</BaseURL>`;
    }
    if (mpdLevel) {
      // Relative MPD-level base: resolve against the manifest URL now.
      hasMpdLevelBase = true;
      const abs = new URL(value, mpdUrl).toString();
      const mapped = abs.endsWith('/') ? mapDir(abs) : mapAbsolute(abs, mapDir);
      return `<BaseURL${attrs}>${escapeXml(mapped)}</BaseURL>`;
    }
    return m; // Nested relative bases resolve against the (already mapped) parent.
  });

  // 2. Absolute URLs in template / segment attributes.
  text = text.replace(
    /\b(media|initialization|sourceURL|xlink:href)="(https?:\/\/[^"]+)"/g,
    (m, attr, value) => `${attr}="${escapeXml(mapAbsolute(unescapeXml(value), mapDir))}"`,
  );

  // 3. No MPD-level base: everything is relative to the manifest directory.
  if (!hasMpdLevelBase) {
    const base = `<BaseURL>${escapeXml(mapDir(dirOf(mpdUrl)))}</BaseURL>`;
    text = text.replace(/(<MPD[^>]*>)/, `$1\n  ${base}`);
  }
  return text;
}

module.exports = { isMpd, rewriteMpd, dirOf };
