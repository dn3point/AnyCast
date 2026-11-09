'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dlna = require('../src/renderers/dlna');
const { parseSsdpMessage, buildMSearch } = require('../src/discovery/ssdp');

const DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
 <device>
  <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
  <friendlyName>客厅电视 &amp; 音响</friendlyName>
  <manufacturer>Hisense</manufacturer><modelName>65E7</modelName>
  <UDN>uuid:1234</UDN>
  <serviceList>
   <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
     <controlURL>AVTransport/control</controlURL></service>
   <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
     <controlURL>/RenderingControl/control</controlURL></service>
  </serviceList>
 </device>
</root>`;

test('parses device description and resolves control URLs', () => {
  const d = dlna.parseDeviceDescription(DESC, 'http://192.168.1.20:49152/desc/device.xml');
  assert.equal(d.friendlyName, '客厅电视 & 音响');
  assert.equal(d.udn, 'uuid:1234');
  assert.equal(d.services.AVTransport.controlURL, 'http://192.168.1.20:49152/desc/AVTransport/control');
  assert.equal(d.services.RenderingControl.controlURL, 'http://192.168.1.20:49152/RenderingControl/control');
});

test('SOAP envelope escapes arguments and DIDL metadata', () => {
  const url = 'http://gw/r/x/0/index.m3u8?a=1&b=2';
  const didl = dlna.buildDidl({ url, title: '<第1集>', mime: 'application/vnd.apple.mpegurl' });
  assert.match(didl, /<res protocolInfo="http-get:\*:application\/vnd\.apple\.mpegurl:\*">http:\/\/gw\/r\/x\/0\/index\.m3u8\?a=1&amp;b=2<\/res>/);
  assert.match(didl, /&lt;第1集&gt;/);
  const env = dlna.buildSoapEnvelope(dlna.SERVICE.AVTransport, 'SetAVTransportURI', {
    InstanceID: 0, CurrentURI: url, CurrentURIMetaData: didl,
  });
  assert.match(env, /<CurrentURI>http:\/\/gw\/r\/x\/0\/index\.m3u8\?a=1&amp;b=2<\/CurrentURI>/);
  assert.match(env, /<CurrentURIMetaData>&lt;DIDL-Lite/);
  assert.match(env, /<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">/);
});

test('protocolInfo flags: seekable mp4 vs live TS', () => {
  assert.match(dlna.protocolInfoFor('video/mp4'), /DLNA\.ORG_OP=01/);
  assert.match(dlna.protocolInfoFor('video/mp2t', { seekable: false }), /DLNA\.ORG_OP=00/);
});

test('time helpers', () => {
  assert.equal(dlna.formatTime(3725), '01:02:05');
  assert.equal(dlna.parseTime('1:02:05.500'), 3725);
  assert.equal(dlna.parseTime('NOT_IMPLEMENTED'), null);
});

test('SSDP message parsing', () => {
  const msg = Buffer.from('HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLocation: http://10.0.0.5:1400/xml/device.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n');
  const { startLine, headers } = parseSsdpMessage(msg);
  assert.equal(startLine, 'HTTP/1.1 200 OK');
  assert.equal(headers.location, 'http://10.0.0.5:1400/xml/device.xml');
  assert.match(buildMSearch().toString(), /^M-SEARCH \* HTTP\/1\.1\r\n[\s\S]*ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n/);
});
