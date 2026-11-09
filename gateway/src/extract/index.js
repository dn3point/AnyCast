'use strict';
// Extraction pipeline: turn "a page URL, maybe with sniffed candidates" into a
// ranked list of playable media URLs, each verified with the browser context
// (Referer / Cookie / UA) that the relay will replay later.

const { request, peek, readBody, lowerKeys, DEFAULT_UA, fetchText } = require('../util/http-client');
const { detectKind, sniffKind, mimeFor, detectDrm } = require('../media');
const { inspectHls } = require('../proxy/hls');
const { extractFromHtml } = require('./html');
const tools = require('./tools');
const log = require('../util/log');

const MAX_CANDIDATES = 12;

function contextHeaders({ headers = {}, pageUrl, cookie, userAgent } = {}) {
  const h = lowerKeys(headers);
  if (cookie && !h.cookie) h.cookie = cookie;
  if (userAgent && !h['user-agent']) h['user-agent'] = userAgent;
  if (pageUrl && !h.referer) h.referer = pageUrl;
  if (!h['user-agent']) h['user-agent'] = DEFAULT_UA;
  return h;
}

/**
 * Fetch the beginning of a URL to learn what it is.
 * @returns {Promise<{ok:boolean,status?:number,kind?:string,mime?:string,drm?:string|null,live?:boolean,isMaster?:boolean,finalUrl?:string,error?:string,headers?:object,text?:string}>}
 */
async function probe(url, headers = {}, { timeout = 8000, wantBody = true } = {}) {
  let res;
  try {
    res = await request(url, { headers: { ...headers, 'accept-encoding': 'identity' }, timeout });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const result = { ok: res.status >= 200 && res.status < 300, status: res.status, finalUrl: res.url, headers: res.headers };
  if (!result.ok) {
    res.abort();
    return result;
  }
  const ct = res.headers['content-type'] || '';
  let head = Buffer.alloc(0);
  let ended = false;
  try {
    ({ head, ended } = await peek(res.stream, 1024));
  } catch {
    /* ignore */
  }
  let kind = sniffKind(head) || detectKind(url, ct);
  if (/^text\/html/i.test(ct) && kind !== 'hls' && kind !== 'dash') kind = null;
  result.kind = kind;
  result.mime = kind ? mimeFor(kind, url, ct) : null;
  if ((kind === 'hls' || kind === 'dash') && wantBody) {
    const rest = ended ? Buffer.alloc(0) : await readBody(res.stream, 4 * 1024 * 1024).catch(() => Buffer.alloc(0));
    const text = Buffer.concat([head, rest]).toString('utf8');
    result.text = text;
    result.drm = detectDrm(text);
    if (kind === 'hls') {
      const info = inspectHls(text, res.url);
      result.isMaster = info.isMaster;
      result.live = info.live;
      result.hls = info;
    } else {
      result.live = /type="dynamic"/.test(text);
    }
  } else {
    res.abort();
  }
  if (res.headers['content-length']) result.length = Number(res.headers['content-length']);
  return result;
}

function score(c) {
  let s = 0;
  if (c.kind === 'hls') s += c.isMaster ? 50 : 40;
  else if (c.kind === 'dash') s += 30;
  else if (/mp4|m4v/.test(c.mime || '')) s += 25;
  else s += 10;
  if (c.length && c.length < 2 * 1024 * 1024 && c.kind === 'progressive') s -= 20; // likely ad / preview
  if (c.audioUrl) s += 5;
  if (/\b(ad|ads|advert|preroll)\b/i.test(c.url)) s -= 30;
  if (c.drm) s -= 100;
  if (c.how === 'network' || c.how === 'extension') s += 5;
  return s;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function verify(candidates, ctx) {
  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c || !c.url || seen.has(c.url) || !/^https?:/i.test(c.url)) continue;
    seen.add(c.url);
    unique.push(c);
  }
  const probed = await mapLimit(unique.slice(0, MAX_CANDIDATES * 2), 6, async (c) => {
    const headers = { ...ctx, ...lowerKeys(c.headers || {}) };
    const p = await probe(c.url, headers);
    if (!p.ok || !p.kind) return null;
    return {
      url: c.url,
      audioUrl: c.audioUrl,
      kind: p.kind,
      mime: p.mime,
      headers,
      title: c.title,
      label: c.label,
      how: c.how,
      drm: p.drm || c.drm || null,
      live: Boolean(p.live),
      isMaster: Boolean(p.isMaster),
      length: p.length,
      variants: p.hls?.variants?.length || undefined,
    };
  });
  return probed.filter(Boolean).sort((a, b) => score(b) - score(a)).slice(0, MAX_CANDIDATES);
}

/**
 * @param {object} input
 * @param {string} input.url               page URL or direct media URL
 * @param {object} [input.headers]         request context (referer, cookie, user-agent ...)
 * @param {Array}  [input.candidates]      URLs sniffed client-side (bookmarklet / extension)
 * @param {Array}  [input.frames]          iframe URLs seen client-side
 * @param {boolean}[input.deep]            allow yt-dlp / headless
 */
async function extract(input) {
  const pageUrl = input.url || input.pageUrl;
  const ctx = contextHeaders({ headers: input.headers, pageUrl, cookie: input.cookie, userAgent: input.userAgent });
  const steps = [];
  let title = input.title || null;
  let drmHint = input.drm || null;

  // 1. Client-side candidates are the most reliable: they come from the real page.
  if (Array.isArray(input.candidates) && input.candidates.length) {
    const list = await verify(input.candidates.map((c) => (typeof c === 'string' ? { url: c } : c)), ctx);
    steps.push({ step: 'client', found: list.length });
    if (list.length) return finish(list);
  }

  if (!pageUrl) return finish([]);

  // 2. Is the URL itself a media file / manifest?
  const direct = await probe(pageUrl, ctx);
  if (direct.ok && direct.kind) {
    steps.push({ step: 'direct', found: 1 });
    const list = await verify([{ url: pageUrl, how: 'direct' }], ctx);
    return finish(list);
  }

  // 3. Static HTML (+ one level of iframes).
  try {
    const { status, text, url: finalUrl } = await fetchText(pageUrl, { headers: { ...ctx, referer: ctx.referer }, limit: 5 * 1024 * 1024 });
    if (status >= 200 && status < 400) {
      const page = extractFromHtml(text, finalUrl);
      title = title || page.title;
      let list = await verify(page.candidates, ctx);
      const frames = [...new Set([...(input.frames || []), ...page.embeds])].slice(0, 4);
      if (!list.length) {
        for (const frame of frames) {
          const sub = await fetchText(frame, { headers: { ...ctx, referer: pageUrl }, limit: 3 * 1024 * 1024 }).catch(() => null);
          if (!sub || sub.status >= 400) continue;
          const inner = extractFromHtml(sub.text, sub.url);
          list = await verify(inner.candidates, { ...ctx, referer: frame });
          if (list.length) break;
        }
      }
      steps.push({ step: 'html', found: list.length });
      if (list.length) return finish(list);
    } else {
      steps.push({ step: 'html', status });
    }
  } catch (err) {
    steps.push({ step: 'html', error: err.message });
  }

  if (input.deep === false) return finish([]);

  // 4. yt-dlp (site-specific extractors).
  if (tools.ytdlpAvailable()) {
    const found = await tools.extractWithYtdlp(pageUrl);
    const list = await verify(found, ctx);
    steps.push({ step: 'yt-dlp', found: list.length });
    if (list.length) return finish(list);
  }

  // 5. Headless browser sniffing.
  if (tools.headlessAvailable()) {
    const found = await tools.extractWithHeadless(pageUrl, { headers: ctx });
    title = title || found[0]?.title;
    const list = await verify(found, ctx);
    steps.push({ step: 'headless', found: list.length });
    if (list.length) return finish(list);
  }

  return finish([]);

  function finish(list) {
    const withTitle = list.map((c) => ({ ...c, title: c.title || title || undefined }));
    if (!withTitle.length) log.info('extract', `no media found for ${pageUrl}`);
    return { title, candidates: withTitle, steps, drm: drmHint || withTitle.find((c) => c.drm)?.drm || null };
  }
}

module.exports = { extract, probe, contextHeaders, score };
