'use strict';
// AnyCast gateway HTTP server: REST API for the phone UI / extension, the
// media relay (/r), the ffmpeg remux endpoint (/t) and the TV web receiver (/tv).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const log = require('./util/log');
const { Relay, corsHeaders } = require('./proxy/relay');
const { DeviceManager } = require('./devices');
const { WebReceiverHub } = require('./renderers/web');
const { CastManager, CastError } = require('./cast');
const { extract } = require('./extract');
const { serveTranscode, ffmpegAvailable } = require('./transcode');
const tools = require('./extract/tools');
const { ipv4Interfaces } = require('./discovery/ssdp');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../../package.json').version;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...apiCors(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function apiCors() {
  // The browser extension (moz-extension:// / chrome-extension:// / safari-web-extension://)
  // and the bookmarklet hand-off page call the API cross-origin.
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
  };
}

function readJson(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new CastError('TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new CastError('BAD_JSON', '请求不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(full)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createGateway(options = {}) {
  const port = Number(options.port ?? 8090);
  const token = options.token || null;
  const addresses = ipv4Interfaces();
  const defaultHost = options.advertiseHost || addresses[0]?.address || '127.0.0.1';

  const relay = new Relay();
  const webHub = new WebReceiverHub();
  const devices = new DeviceManager({
    webHub,
    ssdp: options.discovery !== false,
    mdns: options.discovery !== false,
    ssdpTargets: options.ssdpTargets || [],
  });
  const casts = new CastManager({ devices, relay, port, defaultHost });

  const authorized = (req, url) => {
    if (!token) return true;
    const h = req.headers.authorization || '';
    return h === `Bearer ${token}` || url.searchParams.get('token') === token;
  };

  async function api(req, res, url, parts) {
    const route = `${req.method} /${parts.join('/')}`;
    const body = req.method === 'POST' ? await readJson(req) : {};

    if (route === 'GET /api/info') {
      return sendJson(res, 200, {
        name: 'AnyCast',
        version: VERSION,
        addresses: addresses.map((a) => `http://${a.address}:${port}`),
        features: {
          ffmpeg: ffmpegAvailable(),
          ytdlp: tools.ytdlpAvailable(),
          headless: tools.headlessAvailable(),
        },
        auth: Boolean(token),
      });
    }
    if (route === 'GET /api/devices') return sendJson(res, 200, { devices: devices.list() });
    if (route === 'POST /api/devices/refresh') {
      devices.refresh();
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /api/devices') {
      // Manual add: { location } for DLNA or { type:'chromecast', host, port, name }.
      if (body.location) {
        const d = await devices.addDlna(String(body.location), { manual: true });
        return sendJson(res, 200, { device: d && { id: d.id, name: d.name, type: d.type } });
      }
      if (body.type === 'chromecast' && body.host) {
        const d = devices.addChromecast({ host: body.host, port: body.port, name: body.name, manual: true });
        return sendJson(res, 200, { device: { id: d.id, name: d.name, type: d.type } });
      }
      throw new CastError('BAD_DEVICE', '需要 location（DLNA 描述地址）或 {type:"chromecast", host}');
    }
    if (route === 'POST /api/extract') {
      const result = await extract(body);
      return sendJson(res, 200, result);
    }
    if (route === 'POST /api/cast') {
      const session = await casts.cast({ deviceId: body.deviceId, media: body.media, mode: body.mode || 'auto' });
      return sendJson(res, 200, { session });
    }
    if (route === 'GET /api/sessions') return sendJson(res, 200, { sessions: casts.list() });
    if (parts[1] === 'sessions' && parts[2]) {
      if (req.method === 'GET' && parts.length === 3) return sendJson(res, 200, await casts.status(parts[2]));
      if (req.method === 'POST' && parts[3] === 'control') {
        return sendJson(res, 200, await casts.control(parts[2], body.action, body.value));
      }
    }
    if (route === 'GET /api/receivers/events') {
      webHub.connect(req, res, { id: url.searchParams.get('id'), name: url.searchParams.get('name') });
      return undefined;
    }
    if (req.method === 'POST' && parts[1] === 'receivers' && parts[3] === 'status') {
      const ok = webHub.updateStatus(parts[2], body);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    return sendJson(res, 404, { error: 'not found', code: 'NOT_FOUND' });
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://gateway');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // Raw (still percent-encoded) segments – the relay needs them verbatim.
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...apiCors(), ...corsHeaders(), 'Access-Control-Max-Age': '600' });
        res.end();
        return;
      }
      if (parts[0] === 'r') {
        await relay.handle(req, res, parts.slice(1), url.search.slice(1));
        return;
      }
      if (parts[0] === 't' && parts[1]) {
        const s = casts.sessions.get(parts[1]);
        if (!s || !s.transcodeInputs) {
          res.writeHead(404);
          res.end();
          return;
        }
        serveTranscode(req, res, { inputs: s.transcodeInputs }, Number(url.searchParams.get('ss')) || 0);
        return;
      }
      if (parts[0] === 'api') {
        if (!authorized(req, url)) return sendJson(res, 401, { error: '需要访问令牌', code: 'UNAUTHORIZED' });
        await api(req, res, url, parts);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (parts.length === 0) return serveStatic(req, res, 'index.html');
      if (parts[0] === 'tv') return serveStatic(req, res, 'receiver.html');
      if (parts[0] === 'static' && parts.length === 2) return serveStatic(req, res, parts[1]);
      if (parts[0] === 'manifest.webmanifest') return serveStatic(req, res, 'manifest.webmanifest');
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      const status = err instanceof CastError ? 400 : 500;
      if (status === 500) log.error('http', err.stack || err.message);
      else log.info('http', `${req.method} ${url.pathname}: ${err.code} ${err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: err.message, code: err.code || 'INTERNAL' });
      else res.destroy();
    }
  });
  server.keepAliveTimeout = 65000;

  return {
    server,
    relay,
    devices,
    casts,
    webHub,
    get port() {
      return server.address()?.port ?? port;
    },
    listen(host = options.host || '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          if (port === 0) casts.port = server.address().port;
          if (options.discovery !== false) devices.start();
          resolve(server.address());
        });
      });
    },
    async close() {
      devices.stop();
      relay.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

module.exports = { createGateway };
