'use strict';
// Static HTML extraction: <video>/<source>, og:video, JSON-LD contentUrl and
// raw .m3u8/.mpd/.mp4 URLs embedded in inline scripts. Also returns <iframe>
// embeds, because many sites host the actual player in a nested page.

const { detectKind } = require('../media');

const MEDIA_URL_RE =
  /(?:https?:)?\/\/[^\s"'<>\\()]+?\.(?:m3u8|mpd|mp4|m4v|webm|mov|flv|mkv)(?:\?[^\s"'<>\\()]*)?(?=["'\s<>\\)]|$)/gi;

function unescapeJs(s) {
  return s
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? m[1] ?? m[2] ?? m[3] : null;
}

function extractFromHtml(html, pageUrl) {
  const found = new Map();
  const embeds = new Set();
  const add = (raw, how) => {
    if (!raw) return;
    let url;
    try {
      url = new URL(unescapeJs(raw.trim()), pageUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:/.test(url)) return;
    const kind = detectKind(url);
    if (!kind && how !== 'video-tag' && how !== 'og:video') return;
    if (!found.has(url)) found.set(url, { url, kind: kind || 'progressive', how });
  };

  const text = String(html);
  let title = null;
  const t = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(text);
  if (t) title = t[1].trim();

  for (const m of text.matchAll(/<(video|source)\b[^>]*>/gi)) {
    add(attr(m[0], 'src') || attr(m[0], 'data-src'), 'video-tag');
  }
  for (const m of text.matchAll(/<meta\b[^>]*>/gi)) {
    const prop = (attr(m[0], 'property') || attr(m[0], 'name') || '').toLowerCase();
    if (/^(og:video(:secure_url|:url)?|twitter:player:stream)$/.test(prop)) add(attr(m[0], 'content'), 'og:video');
    if (prop === 'og:title' && !title) title = attr(m[0], 'content');
  }
  for (const m of text.matchAll(/"(?:contentUrl|embedUrl|videoUrl|playUrl|hlsUrl|m3u8|url)"\s*:\s*"([^"]+)"/gi)) {
    add(m[1], 'json');
  }
  const unescaped = unescapeJs(text);
  for (const m of unescaped.matchAll(MEDIA_URL_RE)) add(m[0], 'regex');

  for (const m of text.matchAll(/<iframe\b[^>]*>/gi)) {
    const src = attr(m[0], 'src') || attr(m[0], 'data-src');
    if (!src || /^(about|javascript|data):/i.test(src)) continue;
    try {
      embeds.add(new URL(unescapeJs(src), pageUrl).toString());
    } catch {
      /* ignore */
    }
  }
  return { title, candidates: [...found.values()], embeds: [...embeds] };
}

module.exports = { extractFromHtml, unescapeJs };
