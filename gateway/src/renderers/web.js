'use strict';
// "Web receiver": any TV with a browser (or an Android TV box with a browser
// app) opens http://<gateway>:<port>/tv once and becomes a cast target. Commands
// are pushed over Server-Sent Events; the page plays HLS/DASH with hls.js /
// dash.js, so it also covers TVs whose native DLNA player cannot handle HLS.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

class WebReceiverHub extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map(); // id -> { res, name, host, status, lastSeen }
  }

  connect(req, res, { id, name }) {
    const rid = (id && /^[\w-]{4,40}$/.test(id) ? id : null) || crypto.randomBytes(6).toString('hex');
    const host = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ id: rid })}\n\n`);
    const prev = this.clients.get(rid);
    if (prev && prev.res !== res) prev.res.end();
    const client = {
      id: rid,
      res,
      name: (name || '').slice(0, 60) || `电视浏览器 ${host}`,
      host,
      status: prev?.status || { state: 'idle' },
      lastSeen: Date.now(),
    };
    this.clients.set(rid, client);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      if (this.clients.get(rid) === client) {
        this.clients.delete(rid);
        this.emit('offline', rid);
      }
    });
    this.emit('online', client);
    return client;
  }

  send(id, message) {
    const c = this.clients.get(id);
    if (!c) throw new Error('电视浏览器接收端已离线');
    c.res.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  updateStatus(id, status) {
    const c = this.clients.get(id);
    if (!c) return false;
    c.status = { ...c.status, ...status };
    c.lastSeen = Date.now();
    return true;
  }

  status(id) {
    return this.clients.get(id)?.status || { state: 'offline' };
  }
}

class WebRenderer {
  constructor(hub, id) {
    this.type = 'web';
    this.hub = hub;
    this.id = id;
  }

  async supports() {
    return 'yes';
  }

  async load({ url, mime, title, live, poster }) {
    this.hub.send(this.id, { type: 'load', url, mime, title, live, poster });
  }

  async play() {
    this.hub.send(this.id, { type: 'play' });
  }

  async pause() {
    this.hub.send(this.id, { type: 'pause' });
  }

  async stop() {
    this.hub.send(this.id, { type: 'stop' });
  }

  async seek(seconds) {
    this.hub.send(this.id, { type: 'seek', value: seconds });
  }

  async setVolume(volume) {
    this.hub.send(this.id, { type: 'volume', value: volume });
  }

  async getStatus() {
    return this.hub.status(this.id);
  }

  close() {}
}

module.exports = { WebReceiverHub, WebRenderer };
