#!/usr/bin/env node
'use strict';
// A simulated DLNA smart TV (UPnP MediaRenderer). It answers SSDP searches,
// serves a device description, implements AVTransport / RenderingControl /
// ConnectionManager, and on Play it fetches the media exactly like a TV's
// built-in player would: plain GETs, no cookies, no Referer, no CORS.
//
// Use it to try AnyCast without a real TV:   node gateway/tools/fake-dlna-tv.js
// Tests use startFakeTv() programmatically.

const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { textOf, escapeXml } = require('../src/util/xml');
const { request, readBody, peek } = require('../src/util/http-client');

const TV_HEADERS = { 'user-agent': 'FakeTV/1.0 (Linux; SmartTV) DLNADOC/1.50', 'getcontentfeatures.dlna.org': '1' };

const DEFAULT_SINK = [
  'http-get:*:video/mp4:*',
  'http-get:*:video/mp2t:*',
  'http-get:*:video/mpeg:*',
  'http-get:*:application/vnd.apple.mpegurl:*',
  'http-get:*:audio/mpeg:*',
].join(',');

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

function description({ name, udn }) {
  const svc = (type, id, ctl) => `
      <service>
        <serviceType>urn:schemas-upnp-org:service:${type}:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:${id}</serviceId>
        <SCPDURL>/scpd/${type}.xml</SCPDURL>
        <controlURL>${ctl}</controlURL>
        <eventSubURL>/upnp/event/${type}</eventSubURL>
      </service>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>${escapeXml(name)}</friendlyName>
    <manufacturer>AnyCast Lab</manufacturer>
    <modelName>Simulated TV</modelName>
    <UDN>${udn}</UDN>
    <dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>
    <serviceList>${svc('AVTransport', 'AVTransport', '/upnp/control/AVTransport1')}${svc(
      'RenderingControl',
      'RenderingControl',
      'upnp/control/RenderingControl1',
    )}${svc('ConnectionManager', 'ConnectionManager', '/upnp/control/ConnectionManager1')}
    </serviceList>
  </device>
</root>`;
}

function soapResponse(serviceType, action, values = {}) {
  const inner = Object.entries(values)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${serviceType}">${inner}</u:${action}Response></s:Body></s:Envelope>`;
}

function soapFault(code, desc) {
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${escapeXml(desc)}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
}

const hms = (s) => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 3600)}:${String(Math.floor((v % 3600) / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

/** Fetch like a TV media player and validate what comes back. */
async function simulatePlayback(uri, log) {
  const get = async (url, extra = {}) => {
    const res = await request(url, { headers: { ...TV_HEADERS, ...extra }, timeout: 10000 });
    log.push({ url, status: res.status, type: res.headers['content-type'] || '' });
    return res;
  };
  const fail = (msg) => ({ ok: false, error: msg });

  const top = await get(uri);
  if (top.status >= 400) {
    top.abort();
    return fail(`HTTP ${top.status} for ${uri}`);
  }
  const { head, ended } = await peek(top.stream, 512);
  const prefix = head.toString('latin1');

  if (prefix.trimStart().startsWith('#EXTM3U')) {
    const rest = ended ? Buffer.alloc(0) : await readBody(top.stream);
    let playlist = Buffer.concat([head, rest]).toString('utf8');
    let base = top.url;
    if (/#EXT-X-STREAM-INF/.test(playlist)) {
      const variant = playlist.split(/\r?\n/).find((l) => l && !l.startsWith('#'));
      const vurl = new URL(variant.trim(), base).toString();
      const v = await get(vurl);
      if (v.status >= 400) return fail(`HTTP ${v.status} for variant playlist`);
      playlist = (await readBody(v.stream)).toString('utf8');
      base = v.url;
    }
    const key = /#EXT-X-KEY:[^\n]*URI="([^"]+)"/.exec(playlist);
    if (key) {
      const k = await get(new URL(key[1], base).toString());
      const kb = await readBody(k.stream);
      if (k.status >= 400) return fail(`HTTP ${k.status} for key`);
      if (kb.length !== 16) return fail(`bad AES key length ${kb.length}`);
    }
    const segs = playlist.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).slice(0, 3);
    if (!segs.length) return fail('empty playlist');
    for (const s of segs) {
      const r = await get(new URL(s.trim(), base).toString());
      const body = await readBody(r.stream);
      if (r.status >= 400) return fail(`HTTP ${r.status} for segment`);
      if (!key && body[0] !== 0x47 && body.toString('latin1', 4, 8) !== 'ftyp' && body.toString('latin1', 4, 8) !== 'moof') {
        return fail('segment is not MPEG-TS / fMP4 (disguised or corrupt)');
      }
    }
    return { ok: true, kind: 'hls', segments: segs.length };
  }

  if (/<MPD[\s>]/.test(prefix)) {
    top.abort();
    return fail('this TV does not support DASH');
  }

  // Progressive file or live TS stream.
  const isTs = head[0] === 0x47;
  const isMp4 = prefix.slice(4, 8) === 'ftyp';
  if (!isTs && !isMp4) {
    top.abort();
    return fail(`unsupported media (${top.headers['content-type'] || 'unknown type'})`);
  }
  if (isTs) {
    // Read a little more and check packet alignment.
    const more = ended ? head : Buffer.concat([head, (await peek(top.stream, 188 * 20)).head]);
    top.abort();
    for (let i = 0; i + 188 < more.length && i < 188 * 10; i += 188) {
      if (more[i] !== 0x47) return fail('broken MPEG-TS stream');
    }
    return { ok: true, kind: 'ts' };
  }
  top.abort();
  if (top.headers['accept-ranges'] === 'bytes' || top.headers['content-length']) {
    const r = await get(uri, { range: 'bytes=100-199' });
    const body = await readBody(r.stream);
    if (r.status !== 206 || body.length !== 100) return fail(`range request failed (HTTP ${r.status})`);
  }
  return { ok: true, kind: 'mp4' };
}

function startFakeTv({
  name = 'AnyCast 模拟电视',
  port = 0,
  host = '127.0.0.1',
  advertiseHost,
  ssdp = false,
  ssdpPort = 1900,
  sinkProtocols = DEFAULT_SINK,
  quiet = true,
} = {}) {
  const ev = new EventEmitter();
  const udn = `uuid:${crypto.randomUUID()}`;
  const state = {
    uri: null,
    meta: null,
    transport: 'NO_MEDIA_PRESENT',
    position: 0,
    volume: 30,
    lastPlayback: null,
    fetched: [],
    actions: [],
  };
  const say = (...a) => !quiet && console.log('[fake-tv]', ...a);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://tv');
    if (req.method === 'GET' && url.pathname === '/description.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
      res.end(description({ name, udn }));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/upnp/control/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const soapAction = String(req.headers.soapaction || '').replace(/"/g, '');
      const [serviceType, action] = soapAction.split('#');
      state.actions.push(action);
      const reply = (values) => {
        res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
        res.end(soapResponse(serviceType, action, values));
      };
      const fault = (code, desc) => {
        res.writeHead(500, { 'Content-Type': 'text/xml; charset="utf-8"' });
        res.end(soapFault(code, desc));
      };
      switch (action) {
        case 'SetAVTransportURI':
          state.uri = textOf(body, 'CurrentURI');
          state.meta = textOf(body, 'CurrentURIMetaData');
          state.transport = 'STOPPED';
          state.position = 0;
          say('SetAVTransportURI', state.uri);
          return reply();
        case 'Play': {
          if (!state.uri) return fault(701, 'No media');
          state.transport = 'TRANSITIONING';
          reply();
          const log = [];
          state.fetched = log;
          try {
            state.lastPlayback = await simulatePlayback(state.uri, log);
          } catch (err) {
            state.lastPlayback = { ok: false, error: err.message };
          }
          state.transport = state.lastPlayback.ok ? 'PLAYING' : 'STOPPED';
          say('playback', JSON.stringify(state.lastPlayback));
          ev.emit('playback', state.lastPlayback);
          return undefined;
        }
        case 'Pause':
          state.transport = 'PAUSED_PLAYBACK';
          return reply();
        case 'Stop':
          state.transport = 'STOPPED';
          return reply();
        case 'Seek':
          state.position = (textOf(body, 'Target') || '0:0:0').split(':').reduce((a, b) => a * 60 + Number(b), 0);
          return reply();
        case 'GetTransportInfo':
          return reply({ CurrentTransportState: state.transport, CurrentTransportStatus: 'OK', CurrentSpeed: '1' });
        case 'GetPositionInfo':
          return reply({ Track: 1, TrackDuration: '0:10:00', RelTime: hms(state.position), AbsTime: 'NOT_IMPLEMENTED' });
        case 'GetMediaInfo':
          return reply({ CurrentURI: state.uri || '', NrTracks: state.uri ? 1 : 0 });
        case 'SetVolume':
          state.volume = Number(textOf(body, 'DesiredVolume'));
          return reply();
        case 'GetVolume':
          return reply({ CurrentVolume: state.volume });
        case 'GetProtocolInfo':
          return reply({ Source: '', Sink: sinkProtocols });
        default:
          return fault(401, 'Invalid Action');
      }
    });
  });

  let ssdpSock = null;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      const adv = advertiseHost || (host === '0.0.0.0' ? lanAddress() : host);
      const location = `http://${adv}:${p}/description.xml`;
      if (ssdp) {
        ssdpSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        ssdpSock.on('error', (e) => say('ssdp error', e.message));
        ssdpSock.on('message', (msg, rinfo) => {
          const text = msg.toString();
          if (!/^M-SEARCH/i.test(text)) return;
          const st = (/^ST:\s*(.+)$/im.exec(text) || [])[1]?.trim();
          if (st && !/MediaRenderer|ssdp:all|AVTransport/i.test(st)) return;
          const resp =
            'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\n' +
            `LOCATION: ${location}\r\nSERVER: FakeTV/1.0 UPnP/1.0 AnyCast/0.1\r\n` +
            `ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: ${udn}::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n`;
          ssdpSock.send(Buffer.from(resp), rinfo.port, rinfo.address);
        });
        ssdpSock.bind(ssdpPort, () => {
          try {
            ssdpSock.addMembership('239.255.255.250');
          } catch {
            /* unicast only */
          }
        });
      }
      resolve({
        name,
        udn,
        location,
        port: p,
        state,
        events: ev,
        waitForPlayback(timeout = 15000) {
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('fake TV: playback timeout')), timeout);
            ev.once('playback', (r) => {
              clearTimeout(t);
              res2(r);
            });
          });
        },
        close() {
          ssdpSock?.close();
          server.closeAllConnections?.();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

module.exports = { startFakeTv, simulatePlayback };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : d;
  };
  startFakeTv({
    name: opt('--name', 'AnyCast 模拟电视'),
    port: Number(opt('--port', 49152)),
    host: '0.0.0.0',
    ssdp: true,
    ssdpPort: Number(opt('--ssdp-port', 1900)),
    quiet: false,
  }).then((tv) => {
    console.log(`模拟电视已启动: ${tv.name}\n  描述地址: ${tv.location}\n  在网关里“手动添加”或等待自动发现。`);
  });
}
