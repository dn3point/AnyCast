'use strict';
// UPnP AV / DLNA MediaRenderer control (AVTransport + RenderingControl).
// This is the protocol virtually every smart TV speaks: Samsung, LG, Sony,
// Hisense, TCL, Xiaomi, Skyworth, and boxes with "乐播投屏" built in.

const http = require('node:http');
const { escapeXml, findAll, textOf, findFirst } = require('../util/xml');
const { fetchText } = require('../util/http-client');

const SERVICE = {
  AVTransport: 'urn:schemas-upnp-org:service:AVTransport:1',
  RenderingControl: 'urn:schemas-upnp-org:service:RenderingControl:1',
  ConnectionManager: 'urn:schemas-upnp-org:service:ConnectionManager:1',
};

class UpnpError extends Error {
  constructor(action, code, description, status) {
    super(`${action} failed: UPnP ${code || status} ${description || ''}`.trim());
    this.code = code ? Number(code) : null;
    this.status = status;
  }
}

function parseDeviceDescription(xml, location) {
  const base = textOf(xml, 'URLBase') || location;
  const services = {};
  for (const block of findAll(xml, 'service')) {
    const serviceType = textOf(block, 'serviceType');
    const short = serviceType && (/:service:([^:]+):/.exec(serviceType) || [])[1];
    if (!short || services[short]) continue;
    const abs = (p) => {
      const v = textOf(block, p);
      if (!v) return null;
      try {
        return new URL(v, base).toString();
      } catch {
        return null;
      }
    };
    services[short] = {
      serviceType,
      controlURL: abs('controlURL'),
      eventSubURL: abs('eventSubURL'),
      SCPDURL: abs('SCPDURL'),
    };
  }
  return {
    udn: textOf(xml, 'UDN'),
    deviceType: textOf(xml, 'deviceType'),
    friendlyName: textOf(xml, 'friendlyName') || 'DLNA Renderer',
    manufacturer: textOf(xml, 'manufacturer'),
    modelName: textOf(xml, 'modelName'),
    services,
    location,
  };
}

async function fetchDeviceDescription(location) {
  const res = await fetchText(location, { timeout: 5000, limit: 1024 * 1024 });
  if (res.status !== 200) throw new Error(`Description ${location} -> HTTP ${res.status}`);
  return parseDeviceDescription(res.text, location);
}

function buildSoapEnvelope(serviceType, action, args = {}) {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${serviceType}">${body}</u:${action}>` +
    '</s:Body></s:Envelope>'
  );
}

function protocolInfoFor(mime, { seekable = true } = {}) {
  if (mime === 'application/vnd.apple.mpegurl' || mime === 'application/dash+xml') {
    return `http-get:*:${mime}:*`;
  }
  const op = seekable ? '01' : '00';
  return `http-get:*:${mime}:DLNA.ORG_OP=${op};DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`;
}

function buildDidl({ url, title, mime, seekable = true }) {
  const pi = protocolInfoFor(mime, { seekable });
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">' +
    '<item id="anycast-0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(title || 'AnyCast')}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="${escapeXml(pi)}">${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  );
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function parseTime(value) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?/.exec(String(value || '').trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const STATE_MAP = {
  PLAYING: 'playing',
  PAUSED_PLAYBACK: 'paused',
  PAUSED_RECORDING: 'paused',
  STOPPED: 'stopped',
  TRANSITIONING: 'loading',
  NO_MEDIA_PRESENT: 'idle',
};

function soapRequest(controlURL, serviceType, action, args, timeout = 8000) {
  const body = Buffer.from(buildSoapEnvelope(serviceType, action, args), 'utf8');
  const u = new URL(controlURL);
  return new Promise((resolve, reject) => {
    const req = http.request(
      u,
      {
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': body.length,
          SOAPACTION: `"${serviceType}#${action}"`,
          'User-Agent': 'AnyCast/0.1 UPnP/1.0 DLNADOC/1.50',
          Connection: 'close',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(findFirst(text, `${action}Response`) ?? text);
            return;
          }
          reject(new UpnpError(action, textOf(text, 'errorCode'), textOf(text, 'errorDescription'), res.statusCode));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${action} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

class DlnaRenderer {
  constructor(desc) {
    this.desc = desc;
    this.type = 'dlna';
    this.sinkProtocols = null;
  }

  async call(service, action, args = {}) {
    const svc = this.desc.services[service];
    if (!svc || !svc.controlURL) throw new Error(`Renderer has no ${service} service`);
    return soapRequest(svc.controlURL, svc.serviceType || SERVICE[service], action, args);
  }

  avt(action, args = {}) {
    return this.call('AVTransport', action, { InstanceID: 0, ...args });
  }

  /** Mime types the TV advertises via ConnectionManager.GetProtocolInfo. */
  async getSinkProtocols() {
    if (this.sinkProtocols) return this.sinkProtocols;
    try {
      const xml = await this.call('ConnectionManager', 'GetProtocolInfo');
      const sink = textOf(xml, 'Sink') || '';
      this.sinkProtocols = sink.split(',').map((p) => p.trim()).filter(Boolean);
    } catch {
      this.sinkProtocols = [];
    }
    return this.sinkProtocols;
  }

  /** 'yes' | 'no' | 'unknown' */
  async supports(mime) {
    const list = await this.getSinkProtocols();
    if (!list.length) return 'unknown';
    const mimes = list.map((p) => (p.split(':')[2] || '').toLowerCase());
    if (mimes.includes('*')) return 'unknown';
    const aliases = {
      'application/vnd.apple.mpegurl': ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'],
      'video/mp2t': ['video/mp2t', 'video/mpeg', 'video/vnd.dlna.mpeg-tts', 'video/mpeg2'],
    };
    const wanted = aliases[mime] || [mime];
    return mimes.some((m) => wanted.includes(m)) ? 'yes' : 'no';
  }

  async load({ url, mime, title, live = false }) {
    const meta = buildDidl({ url, title, mime, seekable: !live && mime !== 'video/mp2t' });
    const set = (metadata) => this.avt('SetAVTransportURI', { CurrentURI: url, CurrentURIMetaData: metadata });
    try {
      await set(meta);
    } catch (first) {
      // Busy renderers want a Stop first; picky ones reject our metadata.
      await this.avt('Stop').catch(() => {});
      try {
        await set(meta);
      } catch {
        await set('');
      }
    }
    try {
      await this.avt('Play', { Speed: 1 });
    } catch (err) {
      // Some TVs auto-play after SetAVTransportURI and answer 701 (transition not available).
      await new Promise((r) => setTimeout(r, 800));
      await this.avt('Play', { Speed: 1 }).catch((e) => {
        if (e.code !== 701) throw e;
      });
    }
  }

  play() {
    return this.avt('Play', { Speed: 1 });
  }

  pause() {
    return this.avt('Pause');
  }

  stop() {
    return this.avt('Stop');
  }

  seek(seconds) {
    return this.avt('Seek', { Unit: 'REL_TIME', Target: formatTime(seconds) });
  }

  setVolume(volume) {
    return this.call('RenderingControl', 'SetVolume', {
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: Math.round(Math.max(0, Math.min(100, volume))),
    });
  }

  async getStatus() {
    const [transport, position, volume] = await Promise.allSettled([
      this.avt('GetTransportInfo'),
      this.avt('GetPositionInfo'),
      this.call('RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' }),
    ]);
    const state = transport.status === 'fulfilled' ? textOf(transport.value, 'CurrentTransportState') : null;
    const pos = position.status === 'fulfilled' ? position.value : '';
    const vol = volume.status === 'fulfilled' ? Number(textOf(volume.value, 'CurrentVolume')) : null;
    return {
      state: STATE_MAP[state] || (state ? state.toLowerCase() : 'unknown'),
      position: parseTime(textOf(pos, 'RelTime')),
      duration: parseTime(textOf(pos, 'TrackDuration')),
      volume: Number.isFinite(vol) ? vol : null,
    };
  }

  close() {}
}

module.exports = {
  SERVICE,
  UpnpError,
  DlnaRenderer,
  parseDeviceDescription,
  fetchDeviceDescription,
  buildSoapEnvelope,
  buildDidl,
  protocolInfoFor,
  formatTime,
  parseTime,
};
