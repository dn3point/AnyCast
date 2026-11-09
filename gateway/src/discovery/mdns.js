'use strict';
// Minimal mDNS / DNS-SD client used to find Google Cast devices
// (_googlecast._tcp.local). Uses "legacy unicast" queries from an ephemeral
// port so it does not fight avahi/Bonjour for UDP 5353.

const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { ipv4Interfaces } = require('./ssdp');
const log = require('../util/log');

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const GOOGLECAST = '_googlecast._tcp.local';

function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('DNS name out of bounds');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (++jumps > 16) throw new Error('DNS compression loop');
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: next >= 0 ? next : pos };
}

function encodeRdata(rr) {
  switch (rr.type) {
    case TYPE.A:
      return Buffer.from(rr.data.split('.').map(Number));
    case TYPE.PTR:
      return encodeName(rr.data);
    case TYPE.SRV: {
      const head = Buffer.alloc(6);
      head.writeUInt16BE(rr.data.priority || 0, 0);
      head.writeUInt16BE(rr.data.weight || 0, 2);
      head.writeUInt16BE(rr.data.port, 4);
      return Buffer.concat([head, encodeName(rr.data.target)]);
    }
    case TYPE.TXT: {
      const entries = Array.isArray(rr.data)
        ? rr.data
        : Object.entries(rr.data).map(([k, v]) => `${k}=${v}`);
      return Buffer.concat(
        entries.map((e) => {
          const b = Buffer.from(e, 'utf8');
          return Buffer.concat([Buffer.from([b.length]), b]);
        }),
      );
    }
    default:
      return Buffer.isBuffer(rr.data) ? rr.data : Buffer.alloc(0);
  }
}

function encodePacket({ id = 0, flags = 0, questions = [], answers = [], authorities = [], additionals = [] }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authorities.length, 8);
  header.writeUInt16BE(additionals.length, 10);
  const parts = [header];
  for (const q of questions) {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(q.cls ?? 1, 2);
    parts.push(encodeName(q.name), tail);
  }
  for (const rr of [...answers, ...authorities, ...additionals]) {
    const rdata = encodeRdata(rr);
    const meta = Buffer.alloc(10);
    meta.writeUInt16BE(rr.type, 0);
    meta.writeUInt16BE(rr.cls ?? 1, 2);
    meta.writeUInt32BE(rr.ttl ?? 120, 4);
    meta.writeUInt16BE(rdata.length, 8);
    parts.push(encodeName(rr.name), meta, rdata);
  }
  return Buffer.concat(parts);
}

function decodeRecord(buf, offset) {
  const { name, next } = decodeName(buf, offset);
  const type = buf.readUInt16BE(next);
  const cls = buf.readUInt16BE(next + 2) & 0x7fff;
  const ttl = buf.readUInt32BE(next + 4);
  const rdlen = buf.readUInt16BE(next + 8);
  const start = next + 10;
  const end = start + rdlen;
  let data;
  switch (type) {
    case TYPE.A:
      data = [...buf.subarray(start, end)].join('.');
      break;
    case TYPE.PTR:
      data = decodeName(buf, start).name;
      break;
    case TYPE.SRV:
      data = {
        priority: buf.readUInt16BE(start),
        weight: buf.readUInt16BE(start + 2),
        port: buf.readUInt16BE(start + 4),
        target: decodeName(buf, start + 6).name,
      };
      break;
    case TYPE.TXT: {
      data = {};
      let p = start;
      while (p < end) {
        const len = buf[p];
        const entry = buf.toString('utf8', p + 1, p + 1 + len);
        const eq = entry.indexOf('=');
        if (eq > 0) data[entry.slice(0, eq)] = entry.slice(eq + 1);
        else if (entry) data[entry] = true;
        p += 1 + len;
      }
      break;
    }
    default:
      data = buf.subarray(start, end);
  }
  return { record: { name, type, cls, ttl, data }, next: end };
}

function decodePacket(buf) {
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o));
  let offset = 12;
  const questions = [];
  for (let i = 0; i < counts[0]; i++) {
    const { name, next } = decodeName(buf, offset);
    questions.push({ name, type: buf.readUInt16BE(next), cls: buf.readUInt16BE(next + 2) });
    offset = next + 4;
  }
  const sections = [[], [], []];
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < counts[s + 1]; i++) {
      const { record, next } = decodeRecord(buf, offset);
      sections[s].push(record);
      offset = next;
    }
  }
  return { id, flags, questions, answers: sections[0], authorities: sections[1], additionals: sections[2] };
}

/** Turn an mDNS response into Cast device descriptors. */
function castDevicesFromPacket(packet, fallbackAddress) {
  const all = [...packet.answers, ...packet.additionals, ...packet.authorities];
  const lc = (s) => String(s).toLowerCase();
  const out = [];
  for (const ptr of all.filter((r) => r.type === TYPE.PTR && lc(r.name) === GOOGLECAST)) {
    const instance = ptr.data;
    const srv = all.find((r) => r.type === TYPE.SRV && lc(r.name) === lc(instance));
    const txt = all.find((r) => r.type === TYPE.TXT && lc(r.name) === lc(instance));
    const a = srv && all.find((r) => r.type === TYPE.A && lc(r.name) === lc(srv.data.target));
    const t = (txt && txt.data) || {};
    out.push({
      id: t.id || instance,
      name: t.fn || instance.split('._googlecast')[0],
      model: t.md || 'Chromecast',
      host: (a && a.data) || fallbackAddress,
      port: srv ? srv.data.port : 8009,
    });
  }
  return out;
}

class MdnsDiscovery extends EventEmitter {
  constructor({ interval = 30000 } = {}) {
    super();
    this.interval = interval;
    this.sockets = [];
  }

  start() {
    const ifaces = ipv4Interfaces();
    for (const { address } of ifaces.length ? ifaces : [{ address: '0.0.0.0' }]) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (err) => log.debug('mdns', `socket ${address}: ${err.message}`));
      sock.on('message', (msg, rinfo) => {
        try {
          for (const dev of castDevicesFromPacket(decodePacket(msg), rinfo.address)) this.emit('device', dev);
        } catch (err) {
          log.debug('mdns', `bad packet from ${rinfo.address}: ${err.message}`);
        }
      });
      sock.bind(0, address, () => {
        try {
          if (address !== '0.0.0.0') sock.setMulticastInterface(address);
        } catch {
          /* ignore */
        }
        this.queryOn(sock);
      });
      this.sockets.push(sock);
    }
    this.timer = setInterval(() => this.query(), this.interval);
    this.timer.unref();
  }

  queryOn(sock) {
    const packet = encodePacket({ questions: [{ name: GOOGLECAST, type: TYPE.PTR, cls: 1 }] });
    sock.send(packet, MDNS_PORT, MDNS_ADDR, () => {});
  }

  query() {
    for (const s of this.sockets) {
      try {
        this.queryOn(s);
      } catch {
        /* ignore */
      }
    }
  }

  stop() {
    clearInterval(this.timer);
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.sockets = [];
  }
}

module.exports = {
  TYPE,
  GOOGLECAST,
  encodeName,
  decodeName,
  encodePacket,
  decodePacket,
  castDevicesFromPacket,
  MdnsDiscovery,
};
