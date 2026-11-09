'use strict';
// SSDP (UPnP discovery). We actively M-SEARCH for MediaRenderers on every
// IPv4 interface and also listen for NOTIFY announcements on 239.255.255.250.

const dgram = require('node:dgram');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const log = require('../util/log');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const MEDIA_RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';

function buildMSearch(st = MEDIA_RENDERER, mx = 2, host = `${SSDP_ADDR}:${SSDP_PORT}`) {
  return Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
      `HOST: ${host}\r\n` +
      'MAN: "ssdp:discover"\r\n' +
      `MX: ${mx}\r\n` +
      `ST: ${st}\r\n` +
      'USER-AGENT: AnyCast/0.1 UPnP/1.1\r\n\r\n',
  );
}

function parseSsdpMessage(buf) {
  const text = buf.toString('utf8');
  const [startLine, ...lines] = text.split(/\r?\n/);
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { startLine: startLine.trim(), headers };
}

function ipv4Interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

class SsdpDiscovery extends EventEmitter {
  constructor({ searchTargets = [MEDIA_RENDERER], interval = 30000, extraTargets = [] } = {}) {
    super();
    this.searchTargets = searchTargets;
    this.interval = interval;
    // Unicast SSDP targets (host:port) – useful in containers/VPNs without multicast.
    this.extraTargets = extraTargets;
    this.sockets = [];
    this.listener = null;
    this.timer = null;
  }

  start() {
    const ifaces = ipv4Interfaces();
    const bindAddrs = ifaces.length ? ifaces.map((i) => i.address) : ['0.0.0.0'];
    for (const address of bindAddrs) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
      sock.on('error', (err) => log.debug('ssdp', `socket ${address}: ${err.message}`));
      sock.bind(0, address, () => {
        try {
          sock.setMulticastTTL(4);
          if (address !== '0.0.0.0') sock.setMulticastInterface(address);
        } catch {
          /* best effort */
        }
        this.searchOn(sock);
      });
      this.sockets.push(sock);
    }

    // Passive listener for NOTIFY (may fail if port 1900 is taken; that's fine).
    const listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    listener.on('error', (err) => {
      log.debug('ssdp', `NOTIFY listener disabled: ${err.message}`);
      listener.close();
    });
    listener.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    listener.bind(SSDP_PORT, () => {
      for (const i of ifaces) {
        try {
          listener.addMembership(SSDP_ADDR, i.address);
        } catch {
          /* ignore */
        }
      }
    });
    this.listener = listener;

    this.timer = setInterval(() => this.search(), this.interval);
    this.timer.unref();
  }

  searchOn(sock) {
    for (const st of this.searchTargets) {
      const msg = buildMSearch(st);
      sock.send(msg, SSDP_PORT, SSDP_ADDR, () => {});
      for (const t of this.extraTargets) {
        const [host, port] = t.split(':');
        sock.send(buildMSearch(st, 1, t), Number(port) || SSDP_PORT, host, () => {});
      }
    }
  }

  search() {
    for (const s of this.sockets) {
      try {
        this.searchOn(s);
      } catch {
        /* socket may be closed */
      }
    }
  }

  onMessage(msg, rinfo) {
    const { startLine, headers } = parseSsdpMessage(msg);
    const isResponse = /^HTTP\/1\.\d 200/i.test(startLine);
    const isNotify = /^NOTIFY /i.test(startLine);
    if (!isResponse && !isNotify) return;
    const type = headers.st || headers.nt || '';
    if (isNotify && headers.nts === 'ssdp:byebye') {
      this.emit('byebye', { usn: headers.usn, address: rinfo.address });
      return;
    }
    if (!/MediaRenderer|AVTransport/i.test(type) || !headers.location) return;
    this.emit('device', {
      location: headers.location,
      usn: headers.usn,
      st: type,
      server: headers.server,
      address: rinfo.address,
    });
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
    try {
      this.listener?.close();
    } catch {
      /* ignore */
    }
    this.sockets = [];
  }
}

module.exports = { SsdpDiscovery, buildMSearch, parseSsdpMessage, ipv4Interfaces, MEDIA_RENDERER, SSDP_ADDR, SSDP_PORT };
