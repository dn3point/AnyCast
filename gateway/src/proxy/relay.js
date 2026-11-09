'use strict';
// The relay is what makes "any" website castable. A TV fetches media like a
// dumb HTTP client: no cookies, no Referer, no custom headers, and Chromecast's
// receiver additionally needs CORS. The relay replays the browser's request
// context against the origin and rewrites manifests so every follow-up request
// (variants, segments, keys, init segments) also flows through the relay.
//
// URL layout (short on purpose; some TVs choke on long URLs):
//   /r/<sourceId>/<n>/<name>      -> one concrete upstream URL (entry n)
//   /r/<sourceId>/d<n>/<rel path> -> any path below upstream directory n (DASH templates)

const crypto = require('node:crypto');
const log = require('../util/log');
const { request, readBody, peek, pipeRest, DEFAULT_UA } = require('../util/http-client');
const { EXT_MIME, SEGMENT_EXTS, extOf, sniffKind, isImageSignature, findTsSync } = require('../media');
const { rewriteHlsPlaylist, isHlsPlaylist } = require('./hls');
const { rewriteMpd, isMpd } = require('./dash');

const SOURCE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 20000;
const MAX_MANIFEST = 8 * 1024 * 1024;

// Request headers captured from the browser that are worth replaying.
const FORWARD_HEADERS = new Set([
  'referer', 'origin', 'cookie', 'user-agent', 'authorization', 'accept-language',
]);
const DLNA_FLAGS = '01700000000000000000000000000000';

const GENERIC_TYPES = /^(?:$|text\/plain|application\/octet-stream|binary\/octet-stream|application\/x-download|application\/force-download|image\/)/;

function newId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeName(url, kind, ctx = {}) {
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    /* ignore */
  }
  name = name.replace(/[^\w.-]+/g, '_').slice(-60);
  const ext = extOf('x://h/' + name);
  if (kind === 'playlist' || kind === 'manifest-hls') {
    if (ext !== 'm3u8') name = (name || 'index') + '.m3u8';
  } else if (kind === 'manifest-dash') {
    if (ext !== 'mpd') name = (name || 'manifest') + '.mpd';
  } else if (kind === 'segment') {
    if (!SEGMENT_EXTS.has(ext)) name = (name || 'seg') + (ctx.fmp4 ? '.m4s' : '.ts');
  } else if (kind === 'key') {
    name = name || 'key.bin';
  }
  return name || 'media';
}

class Relay {
  constructor() {
    this.sources = new Map();
    this.gcTimer = setInterval(() => this.gc(), 10 * 60 * 1000);
    this.gcTimer.unref();
  }

  /**
   * Register a media source together with the request context the browser used.
   * @param {{url:string, headers?:object, kind?:string}} media
   */
  createSource({ url, headers = {}, kind }) {
    const id = newId();
    const src = {
      id,
      headers: pickForwardHeaders(headers),
      entries: [],
      entryIndex: new Map(),
      dirs: [],
      dirIndex: new Map(),
      created: Date.now(),
      lastAccess: Date.now(),
      bytes: 0,
    };
    this.sources.set(id, src);
    const mainKind = kind === 'hls' ? 'manifest-hls' : kind === 'dash' ? 'manifest-dash' : 'media';
    this.addEntry(src, url, mainKind);
    return src;
  }

  addEntry(src, url, kind) {
    const known = src.entryIndex.get(url);
    if (known !== undefined) return known;
    if (src.entries.length >= MAX_ENTRIES) {
      // Live streams keep adding segments; recycle the oldest half.
      const keep = src.entries.slice(MAX_ENTRIES / 2);
      const offset = src.entries.length - keep.length;
      src.entries = new Array(offset).fill(null).concat(keep);
      src.entryIndex = new Map();
      src.entries.forEach((e, i) => e && src.entryIndex.set(e.url, i));
    }
    const n = src.entries.length;
    src.entries.push({ url, kind });
    src.entryIndex.set(url, n);
    return n;
  }

  addDir(src, dirUrl) {
    const known = src.dirIndex.get(dirUrl);
    if (known !== undefined) return known;
    const n = src.dirs.length;
    src.dirs.push(dirUrl);
    src.dirIndex.set(dirUrl, n);
    return n;
  }

  /** Public URL for entry `n` of `src` as seen from `base` (e.g. http://192.168.1.5:8090). */
  entryUrl(base, src, n, ctx) {
    const e = src.entries[n];
    return `${base}/r/${src.id}/${n}/${safeName(e.url, e.kind, ctx)}`;
  }

  mainUrl(base, src) {
    return this.entryUrl(base, src, 0);
  }

  get(id) {
    return this.sources.get(id);
  }

  remove(id) {
    this.sources.delete(id);
  }

  gc() {
    const now = Date.now();
    for (const [id, src] of this.sources) {
      if (now - src.lastAccess > SOURCE_TTL_MS) this.sources.delete(id);
    }
  }

  close() {
    clearInterval(this.gcTimer);
  }

  /**
   * Handle /r/<sid>/<key>/<rest...>. `parts` excludes the leading 'r'.
   */
  async handle(req, res, parts, query) {
    const [sid, key, ...rest] = parts;
    const src = this.sources.get(sid);
    if (!src) return sendError(res, 404, 'Unknown or expired relay source');
    src.lastAccess = Date.now();

    let target;
    let kind;
    if (key && key[0] === 'd') {
      const dir = src.dirs[Number(key.slice(1))];
      if (!dir) return sendError(res, 404, 'Unknown relay directory');
      // `rest` holds raw (still percent-encoded) path segments.
      const rel = rest.join('/') + (query ? `?${query}` : '');
      const resolved = new URL(rel, dir);
      if (!resolved.toString().startsWith(dir.split('?')[0])) {
        return sendError(res, 403, 'Path escapes relay directory');
      }
      target = resolved.toString();
      kind = /\.mpd$/i.test(resolved.pathname) ? 'manifest-dash' : 'segment';
    } else {
      const entry = src.entries[Number(key)];
      if (!entry) return sendError(res, 404, 'Unknown relay entry');
      target = entry.url;
      kind = entry.kind;
    }

    const base = publicBase(req);
    const headers = {
      ...src.headers,
      'accept-encoding': 'identity',
      accept: '*/*',
    };
    if (!headers['user-agent']) headers['user-agent'] = DEFAULT_UA;
    // "Range: bytes=0-" (ffmpeg, many TVs) means "everything". For manifests
    // and segments we may need to rewrite the body, so ask for a plain 200.
    const range = req.headers.range;
    const fullRange = /^bytes=0-\s*$/.test(range || '');
    const rewritable = kind !== 'media' && kind !== 'other';
    if (range && !(fullRange && rewritable)) headers.range = range;
    if (headers.range && req.headers['if-range']) headers['if-range'] = req.headers['if-range'];

    let up;
    try {
      up = await request(target, { headers });
    } catch (err) {
      log.warn('relay', `upstream error ${short(target)}: ${err.message}`);
      return sendError(res, 502, `Upstream error: ${err.message}`);
    }
    res.on('close', () => up.abort());

    const ok = up.status >= 200 && up.status < 300;
    if (!ok) log.warn('relay', `upstream ${up.status} for ${short(target)}`);
    else log.debug('relay', `${up.status} ${short(target)}`);

    const isRange = Boolean(headers.range) && !fullRange;
    const ct = String(up.headers['content-type'] || '').toLowerCase();
    const length = Number(up.headers['content-length'] || 0);
    const maybeManifest =
      ok &&
      !isRange &&
      (kind === 'manifest-hls' || kind === 'manifest-dash' || kind === 'playlist' ||
        /mpegurl|dash\+xml/.test(ct) ||
        ((kind === 'media' || kind === 'other') && GENERIC_TYPES.test(ct) && (!length || length < MAX_MANIFEST)));

    if (maybeManifest) {
      const { head, ended } = await peek(up.stream, 512).catch(() => ({ head: Buffer.alloc(0), ended: true }));
      const sniffed = sniffKind(head);
      if (sniffed === 'hls' || sniffed === 'dash') {
        const restBuf = ended ? Buffer.alloc(0) : await readBody(up.stream, MAX_MANIFEST).catch(() => null);
        if (!restBuf) return sendError(res, 502, 'Manifest too large or truncated');
        const body = Buffer.concat([head, restBuf]).toString('utf8');
        const rewritten = sniffed === 'hls'
          ? this.rewriteHls(src, body, up.url, base)
          : this.rewriteDash(src, body, up.url, base);
        const buf = Buffer.from(rewritten, 'utf8');
        res.writeHead(200, {
          ...corsHeaders(),
          'Content-Type': sniffed === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
        });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      }
      return this.pipeMedia(req, res, up, target, kind, head, ended);
    }

    if (ok && !isRange && kind === 'segment') {
      // Possibly a TS segment disguised as an image: strip the fake header.
      const { head, ended } = await peek(up.stream, 16384).catch(() => ({ head: Buffer.alloc(0), ended: true }));
      if (isImageSignature(head)) {
        const sync = findTsSync(head);
        if (sync > 0) {
          log.debug('relay', `stripped ${sync}-byte fake image header from ${short(target)}`);
          return this.pipeMedia(req, res, up, target, kind, head.subarray(sync), ended, {
            contentType: 'video/mp2t',
            lengthDelta: -sync,
          });
        }
      }
      return this.pipeMedia(req, res, up, target, kind, head, ended);
    }

    return this.pipeMedia(req, res, up, target, kind, null, false);
  }

  pipeMedia(req, res, up, target, kind, head, ended, fix = {}) {
    const out = { ...corsHeaders(), 'transferMode.dlna.org': 'Streaming' };
    let ct = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (fix.contentType) ct = fix.contentType;
    else if (GENERIC_TYPES.test(ct)) ct = EXT_MIME[extOf(target)] || (kind === 'segment' ? 'video/mp2t' : ct || 'application/octet-stream');
    out['Content-Type'] = ct;
    const encoded = up.headers['content-encoding'] && up.headers['content-encoding'] !== 'identity';
    if (up.headers['content-length'] && !encoded) {
      out['Content-Length'] = Math.max(0, Number(up.headers['content-length']) + (fix.lengthDelta || 0));
    }
    if (encoded) out['Content-Encoding'] = up.headers['content-encoding'];
    for (const h of ['content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control', 'expires']) {
      if (up.headers[h] && !(fix.lengthDelta && h === 'content-range')) out[h] = up.headers[h];
    }
    if (!out['accept-ranges'] && !fix.lengthDelta && /^(video|audio)\//.test(ct)) out['accept-ranges'] = 'bytes';
    if (req.headers['getcontentfeatures.dlna.org']) {
      out['contentFeatures.dlna.org'] = `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`;
    }
    res.writeHead(up.status, out);
    if (req.method === 'HEAD') {
      up.abort();
      return res.end();
    }
    if (head && head.length) res.write(head);
    if (ended) return res.end();
    pipeRest(up.stream, res);
    up.stream.on('error', () => res.destroy());
    return undefined;
  }

  rewriteHls(src, body, playlistUrl, base) {
    if (!isHlsPlaylist(body)) return body;
    return rewriteHlsPlaylist(body, playlistUrl, (abs, kind, ctx) => {
      const n = this.addEntry(src, abs, kind);
      return this.entryUrl(base, src, n, ctx);
    });
  }

  rewriteDash(src, body, mpdUrl, base) {
    if (!isMpd(body)) return body;
    return rewriteMpd(body, mpdUrl, (dir) => `${base}/r/${src.id}/d${this.addDir(src, dir)}/`);
  }
}

function pickForwardHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (v == null || v === '') continue;
    if (FORWARD_HEADERS.has(key) || key.startsWith('x-')) out[key] = String(v);
  }
  return out;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  };
}

function publicBase(req) {
  const host = req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`;
  return `http://${host}`;
}

function sendError(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { ...corsHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end(message);
}

function short(url) {
  return url.length > 120 ? `${url.slice(0, 117)}...` : url;
}

module.exports = { Relay, pickForwardHeaders, corsHeaders, publicBase, safeName };
