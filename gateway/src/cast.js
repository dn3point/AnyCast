'use strict';
// Cast planner + session manager.
//
// For every cast we pick the cheapest delivery that will actually work:
//   direct    – the TV fetches the original URL itself (zero load on the gateway)
//   proxy     – the TV fetches through the relay (adds Referer/Cookie, CORS,
//               rewrites manifests, strips fake image headers)
//   transcode – ffmpeg remuxes into one MPEG-TS stream (separate audio/video
//               tracks, DASH or formats the TV does not support)

const crypto = require('node:crypto');
const os = require('node:os');
const log = require('./util/log');
const { request, peek, TV_UA } = require('./util/http-client');
const { detectKind, mimeFor, isImageSignature } = require('./media');
const { probe, contextHeaders } = require('./extract');
const { ffmpegAvailable } = require('./transcode');

class CastError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Choose the local IPv4 address on the same subnet as `host` (what the TV can reach). */
function localAddressFor(host, fallback) {
  if (!host) return fallback;
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return '127.0.0.1';
  const toInt = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return fallback;
  const target = toInt(host);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const mask = toInt(a.netmask);
      if ((toInt(a.address) & mask) === (target & mask)) return a.address;
    }
  }
  return fallback;
}

/** Can a "dumb" client (no cookies / Referer) fetch this media? */
async function probeDirect(media, { needCors = false, timeout = 6000 } = {}) {
  const headers = { 'user-agent': TV_UA };
  if (needCors) headers.origin = 'http://anycast-receiver.local';
  const okResp = (p) => p.ok && (!needCors || p.headers?.['access-control-allow-origin']);
  try {
    const top = await probe(media.url, headers, { timeout });
    if (!okResp(top)) return false;
    if (media.kind !== 'hls' || !top.hls) return true;
    let info = top.hls;
    if (info.isMaster && info.variants[0]) {
      const v = await probe(info.variants[0].url, headers, { timeout });
      if (!okResp(v) || !v.hls) return false;
      info = v.hls;
    }
    for (const key of info.keys.slice(0, 1)) {
      const k = await probeBytes(key, headers, timeout);
      if (!k) return false;
    }
    if (info.segments[0]) {
      const ok = await probeBytes(info.segments[0], headers, timeout, { rejectImages: true });
      if (!ok) return false;
    }
    return true;
  } catch (err) {
    log.debug('cast', `direct probe failed: ${err.message}`);
    return false;
  }
}

async function probeBytes(url, headers, timeout, { rejectImages = false } = {}) {
  try {
    const res = await request(url, { headers: { ...headers, range: 'bytes=0-187' }, timeout });
    if (res.status < 200 || res.status >= 300) {
      res.abort();
      return false;
    }
    if (!rejectImages) {
      res.abort();
      return true;
    }
    // Segments disguised as PNG/JPEG play in hls.js-based web players but not
    // on TVs; the relay strips the fake header, so they must be proxied.
    const { head } = await peek(res.stream, 8);
    res.abort();
    return !isImageSignature(head);
  } catch {
    return false;
  }
}

class CastManager {
  constructor({ devices, relay, port, defaultHost }) {
    this.devices = devices;
    this.relay = relay;
    this.port = port;
    this.defaultHost = defaultHost;
    this.sessions = new Map();
  }

  baseUrlFor(device) {
    const host = localAddressFor(device.host, this.defaultHost);
    return `http://${host}:${this.port}`;
  }

  /** Normalise a media description coming from the extension / UI / API. */
  async normalize(input) {
    if (!input || !input.url) throw new CastError('BAD_MEDIA', '缺少视频地址');
    const headers = contextHeaders({
      headers: input.headers,
      pageUrl: input.pageUrl,
      cookie: input.cookie,
      userAgent: input.userAgent,
    });
    const media = {
      url: input.url,
      audioUrl: input.audioUrl || null,
      kind: input.kind || detectKind(input.url, input.mime),
      mime: input.mime || null,
      headers,
      title: input.title || null,
      poster: input.poster || null,
      drm: input.drm || null,
      live: input.live ?? null,
    };
    // Look at the media once with the full browser context: confirms the kind,
    // catches DRM, live-ness and expired links before we bother the TV.
    const p = await probe(media.url, headers);
    if (!p.ok) {
      throw new CastError(
        'UNREACHABLE',
        `网关无法获取该视频（${p.status ? `HTTP ${p.status}` : p.error}）。链接可能已过期，请回到网页重新播放后再投屏。`,
      );
    }
    media.kind = p.kind || media.kind || 'progressive';
    media.mime = mimeFor(media.kind, media.url, p.headers?.['content-type'] || media.mime);
    media.drm = media.drm || p.drm || null;
    if (media.live === null) media.live = Boolean(p.live);
    return media;
  }

  async plan(media, device, requested = 'auto') {
    if (media.drm) {
      throw new CastError(
        'DRM',
        `该视频受 ${media.drm === true ? '' : media.drm} DRM 版权保护，第三方无法投屏。请使用该网站官方 App 的投屏功能。`,
      );
    }
    const renderer = device.renderer;
    const ffmpeg = ffmpegAvailable();
    const needsMux = Boolean(media.audioUrl);
    if (requested === 'direct' || requested === 'proxy') {
      if (needsMux) throw new CastError('NEEDS_FFMPEG', '音视频分离的视频只能用“转封装”模式');
      return requested;
    }
    if (requested === 'transcode') {
      if (!ffmpeg) throw new CastError('NEEDS_FFMPEG', '网关未安装 ffmpeg，无法转封装');
      return 'transcode';
    }

    // auto
    if (needsMux) {
      if (!ffmpeg) throw new CastError('NEEDS_FFMPEG', '该视频音视频分离，需要在网关安装 ffmpeg 才能投屏');
      return 'transcode';
    }
    const support = renderer.supports ? await renderer.supports(media.mime) : 'unknown';
    const dlnaDash = device.type === 'dlna' && media.kind === 'dash' && support !== 'yes';
    const unsupported = support === 'no' || dlnaDash || /x-flv|x-msvideo/.test(media.mime);
    if (unsupported && ffmpeg && device.type === 'dlna') return 'transcode';

    // Chromecast / browser receivers load HLS & DASH via MSE, which needs CORS.
    const needCors = device.type !== 'dlna' && media.kind !== 'progressive';
    // Even when the page sent cookies the CDN often does not check them, and
    // direct playback keeps the gateway out of the data path. Probing is cheap.
    const directOk = await probeDirect(media, { needCors });
    return directOk ? 'direct' : 'proxy';
  }

  async cast({ deviceId, media: input, mode = 'auto' }) {
    const device = this.devices.get(deviceId);
    if (!device) throw new CastError('NO_DEVICE', '找不到该电视，请刷新设备列表');
    const media = await this.normalize(input);
    const chosen = await this.plan(media, device, mode);
    const base = this.baseUrlFor(device);
    const id = crypto.randomBytes(5).toString('hex');
    const session = {
      id,
      deviceId,
      deviceName: device.name,
      media,
      mode: chosen,
      createdAt: Date.now(),
      offset: 0,
      sources: [],
    };

    let playUrl;
    let mime = media.mime;
    if (chosen === 'direct') {
      playUrl = media.url;
    } else if (chosen === 'proxy') {
      const src = this.relay.createSource({ url: media.url, headers: media.headers, kind: media.kind });
      session.sources.push(src.id);
      playUrl = this.relay.mainUrl(base, src);
    } else {
      const main = this.relay.createSource({ url: media.url, headers: media.headers, kind: media.kind });
      session.sources.push(main.id);
      const local = `http://127.0.0.1:${this.port}`;
      session.transcodeInputs = [this.relay.mainUrl(local, main)];
      if (media.audioUrl) {
        const audio = this.relay.createSource({ url: media.audioUrl, headers: media.headers });
        session.sources.push(audio.id);
        session.transcodeInputs.push(this.relay.mainUrl(local, audio));
      }
      playUrl = `${base}/t/${id}/stream.ts`;
      mime = 'video/mp2t';
    }
    session.playUrl = playUrl;
    session.playMime = mime;

    log.info('cast', `${device.type} "${device.name}" <- [${chosen}] ${media.kind} ${shorten(media.url)}`);
    // One active session per device.
    for (const [sid, s] of this.sessions) if (s.deviceId === deviceId) this.endSession(sid);
    this.sessions.set(id, session);
    try {
      await device.renderer.load({
        url: playUrl,
        mime,
        title: media.title || '网页视频',
        live: media.live || chosen === 'transcode',
        poster: media.poster,
      });
    } catch (err) {
      this.endSession(id);
      throw new CastError('DEVICE_ERROR', `电视拒绝播放：${err.message}`);
    }
    return this.publicSession(session);
  }

  endSession(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const sid of s.sources) this.relay.remove(sid);
    this.sessions.delete(id);
  }

  async control(id, action, value) {
    const s = this.sessions.get(id);
    if (!s) throw new CastError('NO_SESSION', '投屏会话不存在或已结束');
    const device = this.devices.get(s.deviceId);
    if (!device) throw new CastError('NO_DEVICE', '电视已离线');
    const r = device.renderer;
    switch (action) {
      case 'play':
        await r.play();
        break;
      case 'pause':
        await r.pause();
        break;
      case 'stop':
        await r.stop().catch(() => {});
        this.endSession(id);
        return { ok: true, ended: true };
      case 'seek': {
        const t = Math.max(0, Number(value) || 0);
        if (s.mode === 'transcode') {
          // A live remux has no byte ranges; restart ffmpeg at the new offset.
          s.offset = t;
          const url = `${s.playUrl.split('?')[0]}?ss=${Math.floor(t)}`;
          await r.load({ url, mime: s.playMime, title: s.media.title, live: true });
        } else {
          await r.seek(t);
        }
        break;
      }
      case 'volume':
        await r.setVolume(Number(value));
        break;
      default:
        throw new CastError('BAD_ACTION', `未知操作 ${action}`);
    }
    return { ok: true };
  }

  async status(id) {
    const s = this.sessions.get(id);
    if (!s) throw new CastError('NO_SESSION', '投屏会话不存在或已结束');
    const device = this.devices.get(s.deviceId);
    const st = device ? await device.renderer.getStatus().catch((e) => ({ state: 'unknown', error: e.message })) : { state: 'offline' };
    if (s.mode === 'transcode' && st.position != null) st.position += s.offset;
    return { ...this.publicSession(s), status: st };
  }

  publicSession(s) {
    return {
      id: s.id,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      mode: s.mode,
      kind: s.media.kind,
      title: s.media.title,
      live: s.media.live,
      playUrl: s.playUrl,
      createdAt: s.createdAt,
    };
  }

  list() {
    return [...this.sessions.values()].map((s) => this.publicSession(s));
  }
}

function shorten(u) {
  return u.length > 90 ? `${u.slice(0, 87)}...` : u;
}

module.exports = { CastManager, CastError, localAddressFor, probeDirect };
