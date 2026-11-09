'use strict';
// HLS playlist rewriting: every URI in a master or media playlist is resolved
// against the playlist's (post-redirect) URL and handed to `mapUrl`, which turns
// it into a relay URL the TV can fetch without cookies / Referer / CORS.

// Tags whose URI="..." attribute points at another playlist.
const PLAYLIST_TAGS = new Set(['EXT-X-MEDIA', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-RENDITION-REPORT']);
const KEY_TAGS = new Set(['EXT-X-KEY', 'EXT-X-SESSION-KEY']);

function isHlsPlaylist(text) {
  return String(text).replace(/^﻿/, '').trimStart().startsWith('#EXTM3U');
}

function kindForTag(tag, line) {
  if (PLAYLIST_TAGS.has(tag)) return 'playlist';
  if (KEY_TAGS.has(tag)) return 'key';
  if (tag === 'EXT-X-MAP') return 'map';
  if (tag === 'EXT-X-PART') return 'segment';
  if (tag === 'EXT-X-PRELOAD-HINT') return /TYPE=MAP/.test(line) ? 'map' : 'segment';
  return 'other';
}

function isRewritable(uri) {
  return !/^(?:skd|data|blob):/i.test(uri);
}

/**
 * @param {string} text      playlist body
 * @param {string} baseUrl   absolute URL the playlist was fetched from (after redirects)
 * @param {(absUrl:string, kind:string, ctx:object)=>string} mapUrl
 * @returns {string}
 */
function rewriteHlsPlaylist(text, baseUrl, mapUrl) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const fmp4 = lines.some((l) => l.startsWith('#EXT-X-MAP'));
  const ctx = { isMaster, fmp4 };
  let nextIsPlaylist = false;

  const resolve = (uri) => {
    try {
      return new URL(uri, baseUrl).toString();
    } catch {
      return null;
    }
  };

  const out = lines.map((raw) => {
    const line = raw.trim();
    if (!line) return raw;
    if (line.startsWith('#')) {
      const tag = (/^#([A-Z0-9-]+)/.exec(line) || [])[1] || '';
      if (tag === 'EXT-X-STREAM-INF') nextIsPlaylist = true;
      if (!/URI="/.test(line)) return raw;
      const kind = kindForTag(tag, line);
      return line.replace(/URI="([^"]*)"/g, (m, uri) => {
        if (!isRewritable(uri)) return m;
        const abs = resolve(uri);
        return abs ? `URI="${mapUrl(abs, kind, ctx)}"` : m;
      });
    }
    // A URI line.
    const kind = nextIsPlaylist || isMaster ? 'playlist' : 'segment';
    nextIsPlaylist = false;
    if (!isRewritable(line)) return raw;
    const abs = resolve(line);
    return abs ? mapUrl(abs, kind, ctx) : raw;
  });
  return out.join('\n');
}

/** Lightweight inspection used by the cast planner. */
function inspectHls(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const segments = [];
  const keys = [];
  let pendingStreamInf = null;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bw = /BANDWIDTH=(\d+)/.exec(line);
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
      pendingStreamInf = { bandwidth: bw ? +bw[1] : 0, height: res ? +res[2] : 0 };
      continue;
    }
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
      const m = /URI="([^"]*)"/.exec(line);
      if (m && isRewritable(m[1])) keys.push(safeResolve(m[1], baseUrl));
      continue;
    }
    if (line.startsWith('#')) continue;
    const abs = safeResolve(line, baseUrl);
    if (pendingStreamInf) {
      variants.push({ url: abs, ...pendingStreamInf });
      pendingStreamInf = null;
    } else {
      segments.push(abs);
    }
  }
  return {
    isMaster: variants.length > 0,
    variants: variants.sort((a, b) => b.bandwidth - a.bandwidth),
    segments,
    keys: keys.filter(Boolean),
    live: variants.length === 0 && !lines.includes('#EXT-X-ENDLIST'),
  };
}

function safeResolve(uri, base) {
  try {
    return new URL(uri, base).toString();
  } catch {
    return null;
  }
}

module.exports = { isHlsPlaylist, rewriteHlsPlaylist, inspectHls };
