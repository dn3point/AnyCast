'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mdns = require('../src/discovery/mdns');

test('encode/decode round trip of a Cast advertisement', () => {
  const instance = 'Chromecast-abc123._googlecast._tcp.local';
  const pkt = mdns.encodePacket({
    flags: 0x8400,
    answers: [{ name: mdns.GOOGLECAST, type: mdns.TYPE.PTR, data: instance }],
    additionals: [
      { name: instance, type: mdns.TYPE.SRV, data: { port: 8009, target: 'abc123.local' } },
      { name: instance, type: mdns.TYPE.TXT, data: { id: 'abc123', fn: '卧室电视', md: 'Chromecast' } },
      { name: 'abc123.local', type: mdns.TYPE.A, data: '192.168.1.42' },
    ],
  });
  const decoded = mdns.decodePacket(pkt);
  assert.equal(decoded.answers[0].data, instance);
  const devices = mdns.castDevicesFromPacket(decoded, '10.0.0.1');
  assert.deepEqual(devices, [{ id: 'abc123', name: '卧室电视', model: 'Chromecast', host: '192.168.1.42', port: 8009 }]);
});

test('decodes compressed names', () => {
  // header (1 answer) + "_googlecast._tcp.local" + PTR record whose rdata points back into it
  const name = mdns.encodeName('_googlecast._tcp.local');
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  const label = Buffer.concat([Buffer.from([2]), Buffer.from('tv')]);
  const rdata = Buffer.concat([label, Buffer.from([0xc0, 12])]); // "tv" + pointer to offset 12
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(mdns.TYPE.PTR, 0);
  meta.writeUInt16BE(1, 2);
  meta.writeUInt32BE(120, 4);
  meta.writeUInt16BE(rdata.length, 8);
  const pkt = Buffer.concat([header, name, meta, rdata]);
  const decoded = mdns.decodePacket(pkt);
  assert.equal(decoded.answers[0].data, 'tv._googlecast._tcp.local');
});
