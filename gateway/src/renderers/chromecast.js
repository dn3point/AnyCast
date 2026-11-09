'use strict';
// Google Cast (CASTV2) sender, dependency-free. Launches the Default Media
// Receiver (CC1AD845) and asks it to LOAD our URL. The receiver fetches media
// with CORS, which is why HLS/DASH from most sites fails to cast unless it
// goes through the relay (the relay adds Access-Control-Allow-Origin: *).

const tls = require('node:tls');
const { EventEmitter } = require('node:events');
const log = require('../util/log');

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';
const SENDER = 'sender-anycast';

// ---- protobuf (CastMessage) -------------------------------------------------

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function field(num, wire, value) {
  const tag = varint((num << 3) | wire);
  if (wire === 0) return Buffer.concat([tag, varint(value)]);
  const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([tag, varint(b.length), b]);
}

function encodeCastMessage({ sourceId, destinationId, namespace, payload }) {
  const body = Buffer.concat([
    field(1, 0, 0), // protocol_version CASTV2_1_0
    field(2, 2, sourceId),
    field(3, 2, destinationId),
    field(4, 2, namespace),
    field(5, 0, 0), // payload_type STRING
    field(6, 2, typeof payload === 'string' ? payload : JSON.stringify(payload)),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value: result, pos };
}

function decodeCastMessage(body) {
  const msg = {};
  let pos = 0;
  while (pos < body.length) {
    const t = readVarint(body, pos);
    pos = t.pos;
    const num = t.value >>> 3;
    const wire = t.value & 7;
    if (wire === 0) {
      const v = readVarint(body, pos);
      pos = v.pos;
      if (num === 1) msg.protocolVersion = v.value;
      if (num === 5) msg.payloadType = v.value;
    } else if (wire === 2) {
      const l = readVarint(body, pos);
      const data = body.subarray(l.pos, l.pos + l.value);
      pos = l.pos + l.value;
      if (num === 2) msg.sourceId = data.toString('utf8');
      if (num === 3) msg.destinationId = data.toString('utf8');
      if (num === 4) msg.namespace = data.toString('utf8');
      if (num === 6) msg.payloadUtf8 = data.toString('utf8');
      if (num === 7) msg.payloadBinary = data;
    } else {
      throw new Error(`Unsupported wire type ${wire}`);
    }
  }
  return msg;
}

// ---- connection -------------------------------------------------------------

class CastConnection extends EventEmitter {
  constructor(host, port = 8009) {
    super();
    this.host = host;
    this.port = port;
    this.buffer = Buffer.alloc(0);
    this.socket = null;
  }

  connect(timeout = 6000) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false, timeout });
      // Cast devices use self-signed certs bound to the device; authenticity is
      // not verified here (same as every open-source sender).
      socket.once('secureConnect', () => {
        socket.setTimeout(0);
        resolve();
      });
      socket.once('timeout', () => socket.destroy(new Error('Cast connect timeout')));
      socket.once('error', (err) => {
        reject(err);
        this.emit('close', err);
      });
      socket.on('close', () => this.emit('close'));
      socket.on('data', (chunk) => this.onData(chunk));
      this.socket = socket;
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const body = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      try {
        const msg = decodeCastMessage(body);
        msg.data = msg.payloadUtf8 ? JSON.parse(msg.payloadUtf8) : null;
        this.emit('message', msg);
      } catch (err) {
        log.debug('cast', `bad frame: ${err.message}`);
      }
    }
  }

  send(destinationId, namespace, payload, sourceId = SENDER) {
    if (!this.socket || this.socket.destroyed) throw new Error('Cast connection closed');
    this.socket.write(encodeCastMessage({ sourceId, destinationId, namespace, payload }));
  }

  close() {
    this.socket?.destroy();
  }
}

// ---- renderer ---------------------------------------------------------------

class ChromecastRenderer {
  constructor({ host, port = 8009 }) {
    this.type = 'chromecast';
    this.host = host;
    this.port = port;
    this.conn = null;
    this.requestId = 1;
    this.pending = new Map();
    this.transportId = null;
    this.mediaSessionId = null;
    this.lastMediaStatus = null;
    this.volume = null;
  }

  async ensureConnected() {
    if (this.conn && this.conn.socket && !this.conn.socket.destroyed) return;
    const conn = new CastConnection(this.host, this.port);
    await conn.connect();
    this.conn = conn;
    this.transportId = null;
    conn.on('message', (msg) => this.onMessage(msg));
    conn.on('close', () => {
      clearInterval(this.heartbeat);
      for (const p of this.pending.values()) p.reject(new Error('Cast connection closed'));
      this.pending.clear();
      if (this.conn === conn) this.conn = null;
    });
    conn.send('receiver-0', NS.connection, { type: 'CONNECT' });
    this.heartbeat = setInterval(() => {
      try {
        conn.send('receiver-0', NS.heartbeat, { type: 'PING' });
      } catch {
        /* closed */
      }
    }, 5000);
    this.heartbeat.unref();
  }

  onMessage(msg) {
    const data = msg.data || {};
    if (msg.namespace === NS.heartbeat && data.type === 'PING') {
      try {
        this.conn.send(msg.sourceId, NS.heartbeat, { type: 'PONG' });
      } catch {
        /* ignore */
      }
      return;
    }
    if (data.type === 'RECEIVER_STATUS' && data.status && data.status.volume) {
      this.volume = Math.round((data.status.volume.level ?? 0) * 100);
    }
    if (data.type === 'MEDIA_STATUS' && Array.isArray(data.status) && data.status[0]) {
      this.lastMediaStatus = data.status[0];
      this.mediaSessionId = data.status[0].mediaSessionId;
    }
    if (msg.namespace === NS.connection && data.type === 'CLOSE' && msg.sourceId === this.transportId) {
      this.transportId = null;
    }
    const p = data.requestId && this.pending.get(data.requestId);
    if (p) {
      this.pending.delete(data.requestId);
      p.resolve(data);
    }
  }

  async request(destinationId, namespace, payload, timeout = 10000) {
    await this.ensureConnected();
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Cast ${payload.type} timed out`));
      }, timeout);
      this.pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.conn.send(destinationId, namespace, { ...payload, requestId });
    });
  }

  async ensureApp() {
    if (this.transportId) return this.transportId;
    let status = await this.request('receiver-0', NS.receiver, { type: 'GET_STATUS' });
    let app = (status.status?.applications || []).find((a) => a.appId === DEFAULT_MEDIA_RECEIVER);
    if (!app) {
      status = await this.request('receiver-0', NS.receiver, { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER }, 20000);
      app = (status.status?.applications || []).find((a) => a.appId === DEFAULT_MEDIA_RECEIVER);
    }
    if (!app) throw new Error('Default Media Receiver failed to launch');
    this.transportId = app.transportId;
    this.conn.send(this.transportId, NS.connection, { type: 'CONNECT' });
    return this.transportId;
  }

  async mediaRequest(payload, timeout) {
    const transportId = await this.ensureApp();
    return this.request(transportId, NS.media, payload, timeout);
  }

  async load({ url, mime, title, live = false, poster }) {
    const res = await this.mediaRequest(
      {
        type: 'LOAD',
        autoplay: true,
        currentTime: 0,
        media: {
          contentId: url,
          contentUrl: url,
          contentType: mime,
          streamType: live ? 'LIVE' : 'BUFFERED',
          metadata: { metadataType: 0, title: title || 'AnyCast', images: poster ? [{ url: poster }] : [] },
        },
      },
      30000,
    );
    if (res.type !== 'MEDIA_STATUS') {
      throw new Error(`Chromecast refused media: ${res.type}${res.reason ? ` (${res.reason})` : ''}`);
    }
  }

  async mediaCommand(type, extra = {}) {
    if (!this.mediaSessionId) await this.getStatus();
    if (!this.mediaSessionId) throw new Error('Nothing is playing on this Chromecast');
    return this.mediaRequest({ type, mediaSessionId: this.mediaSessionId, ...extra });
  }

  play() {
    return this.mediaCommand('PLAY');
  }

  pause() {
    return this.mediaCommand('PAUSE');
  }

  stop() {
    return this.mediaCommand('STOP');
  }

  seek(seconds) {
    return this.mediaCommand('SEEK', { currentTime: seconds });
  }

  setVolume(volume) {
    return this.request('receiver-0', NS.receiver, {
      type: 'SET_VOLUME',
      volume: { level: Math.max(0, Math.min(1, volume / 100)) },
    });
  }

  async getStatus() {
    try {
      const res = await this.mediaRequest({ type: 'GET_STATUS' }, 5000);
      const s = (res.status || [])[0] || this.lastMediaStatus;
      if (!s) return { state: 'idle', position: null, duration: null, volume: this.volume };
      const map = { PLAYING: 'playing', PAUSED: 'paused', BUFFERING: 'loading', IDLE: 'stopped' };
      return {
        state: map[s.playerState] || String(s.playerState || 'unknown').toLowerCase(),
        position: s.currentTime ?? null,
        duration: s.media?.duration ?? null,
        volume: this.volume,
        error: s.idleReason === 'ERROR' ? 'Chromecast 播放出错（多为格式或跨域问题）' : undefined,
      };
    } catch (err) {
      return { state: 'unknown', error: err.message };
    }
  }

  close() {
    clearInterval(this.heartbeat);
    this.conn?.close();
  }
}

module.exports = {
  NS,
  DEFAULT_MEDIA_RECEIVER,
  encodeCastMessage,
  decodeCastMessage,
  CastConnection,
  ChromecastRenderer,
};
