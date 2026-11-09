'use strict';
// Registry of every cast target the gateway knows about, regardless of protocol.

const { EventEmitter } = require('node:events');
const log = require('./util/log');
const { SsdpDiscovery } = require('./discovery/ssdp');
const { MdnsDiscovery } = require('./discovery/mdns');
const { DlnaRenderer, fetchDeviceDescription } = require('./renderers/dlna');
const { ChromecastRenderer } = require('./renderers/chromecast');
const { WebRenderer } = require('./renderers/web');

const STALE_MS = 10 * 60 * 1000;

class DeviceManager extends EventEmitter {
  constructor({ webHub, ssdp = true, mdns = true, ssdpTargets = [] } = {}) {
    super();
    this.devices = new Map();
    this.pendingLocations = new Set();
    this.knownLocations = new Map(); // location -> device id
    this.webHub = webHub;
    this.ssdp = ssdp ? new SsdpDiscovery({ extraTargets: ssdpTargets }) : null;
    this.mdns = mdns ? new MdnsDiscovery() : null;

    if (webHub) {
      webHub.on('online', (c) =>
        this.upsert({
          id: `web:${c.id}`,
          type: 'web',
          name: c.name,
          host: c.host,
          model: 'Browser receiver',
          renderer: new WebRenderer(webHub, c.id),
        }),
      );
      webHub.on('offline', (id) => this.remove(`web:${id}`));
    }
  }

  start() {
    if (this.ssdp) {
      this.ssdp.on('device', (d) => this.addDlna(d.location).catch((e) => log.debug('devices', e.message)));
      this.ssdp.on('byebye', ({ usn }) => {
        const udn = String(usn || '').split('::')[0];
        if (udn) this.remove(`dlna:${udn}`);
      });
      this.ssdp.start();
    }
    if (this.mdns) {
      this.mdns.on('device', (d) => this.addChromecast(d));
      this.mdns.start();
    }
  }

  stop() {
    this.ssdp?.stop();
    this.mdns?.stop();
    for (const d of this.devices.values()) d.renderer?.close?.();
  }

  refresh() {
    this.ssdp?.search();
    this.mdns?.query();
  }

  upsert(device) {
    const existing = this.devices.get(device.id);
    const merged = { ...existing, ...device, lastSeen: Date.now() };
    if (existing?.renderer && device.renderer && existing.renderer !== device.renderer) {
      // Keep the live renderer (Chromecast connection, cached DLNA caps).
      if (device.type !== 'web') merged.renderer = existing.renderer;
    }
    this.devices.set(device.id, merged);
    if (!existing) {
      log.info('devices', `+ ${merged.type} "${merged.name}" (${merged.host || ''})`);
      this.emit('added', merged);
    }
    return merged;
  }

  remove(id) {
    const d = this.devices.get(id);
    if (!d) return;
    if (d.manual) return; // manually added devices stay until restart
    d.renderer?.close?.();
    this.devices.delete(id);
    log.info('devices', `- ${d.type} "${d.name}"`);
    this.emit('removed', d);
  }

  async addDlna(location, { manual = false } = {}) {
    const knownId = this.knownLocations.get(location);
    if (knownId && this.devices.has(knownId)) {
      const d = this.devices.get(knownId);
      d.lastSeen = Date.now();
      return d;
    }
    if (this.pendingLocations.has(location)) return null;
    this.pendingLocations.add(location);
    try {
      const desc = await fetchDeviceDescription(location);
      if (!desc.services.AVTransport) throw new Error(`${location} has no AVTransport service`);
      const id = `dlna:${desc.udn || location}`;
      this.knownLocations.set(location, id);
      return this.upsert({
        id,
        type: 'dlna',
        name: desc.friendlyName,
        manufacturer: desc.manufacturer,
        model: desc.modelName,
        host: new URL(location).hostname,
        location,
        manual,
        renderer: new DlnaRenderer(desc),
      });
    } finally {
      this.pendingLocations.delete(location);
    }
  }

  addChromecast({ id, name, host, port = 8009, model, manual = false }) {
    const did = `cast:${id || host}`;
    return this.upsert({
      id: did,
      type: 'chromecast',
      name: name || `Chromecast ${host}`,
      model: model || 'Chromecast',
      host,
      port,
      manual,
      renderer: this.devices.get(did)?.renderer || new ChromecastRenderer({ host, port }),
    });
  }

  get(id) {
    return this.devices.get(id) || null;
  }

  list() {
    const now = Date.now();
    return [...this.devices.values()]
      .filter((d) => d.manual || d.type === 'web' || now - d.lastSeen < STALE_MS)
      .map(publicDevice)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }
}

function publicDevice(d) {
  return {
    id: d.id,
    type: d.type,
    name: d.name,
    model: [d.manufacturer, d.model].filter(Boolean).join(' ') || null,
    host: d.host || null,
    manual: Boolean(d.manual),
  };
}

module.exports = { DeviceManager, publicDevice };
