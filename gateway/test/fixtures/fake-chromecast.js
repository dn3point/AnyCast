'use strict';
// Minimal Google Cast receiver speaking CASTV2 over TLS, for tests.
// On LOAD it fetches the media like the Default Media Receiver would
// (with an Origin header, requiring CORS for HLS/DASH).

const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { encodeCastMessage, decodeCastMessage, NS, DEFAULT_MEDIA_RECEIVER } = require('../../src/renderers/chromecast');
const { request } = require('../../src/util/http-client');

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycast-cast-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=fake-chromecast'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function startFakeChromecast() {
  const state = { loaded: null, playerState: 'IDLE', volume: 0.5, fetch: null, messages: [] };
  const server = tls.createServer(selfSignedCert(), (socket) => {
    let buf = Buffer.alloc(0);
    let appRunning = false;
    const send = (src, dst, ns, payload) => socket.write(encodeCastMessage({ sourceId: src, destinationId: dst, namespace: ns, payload }));
    const receiverStatus = (requestId) => ({
      type: 'RECEIVER_STATUS',
      requestId,
      status: {
        volume: { level: state.volume, muted: false },
        applications: appRunning ? [{ appId: DEFAULT_MEDIA_RECEIVER, sessionId: 'sess-1', transportId: 'web-7', displayName: 'Default Media Receiver' }] : [],
      },
    });
    const mediaStatus = (requestId) => ({
      type: 'MEDIA_STATUS',
      requestId,
      status: state.loaded ? [{ mediaSessionId: 1, playerState: state.playerState, currentTime: 12, media: { duration: 600 } }] : [],
    });
    socket.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const len = buf.readUInt32BE(0);
        const msg = decodeCastMessage(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
        const data = JSON.parse(msg.payloadUtf8 || '{}');
        state.messages.push(`${msg.namespace.split('.').pop()}:${data.type}`);
        const reply = (payload) => send(msg.destinationId, msg.sourceId, msg.namespace, payload);
        if (msg.namespace === NS.heartbeat && data.type === 'PING') reply({ type: 'PONG' });
        else if (msg.namespace === NS.receiver && data.type === 'GET_STATUS') reply(receiverStatus(data.requestId));
        else if (msg.namespace === NS.receiver && data.type === 'LAUNCH') {
          appRunning = true;
          reply(receiverStatus(data.requestId));
        } else if (msg.namespace === NS.receiver && data.type === 'SET_VOLUME') {
          state.volume = data.volume.level;
          reply(receiverStatus(data.requestId));
        } else if (msg.namespace === NS.media) {
          if (msg.destinationId !== 'web-7') continue;
          if (data.type === 'LOAD') {
            state.loaded = data.media;
            // Fetch like the receiver: cross-origin, so CORS must be present for manifests.
            try {
              const res = await request(data.media.contentId, { headers: { origin: 'https://www.gstatic.com' } });
              res.abort();
              state.fetch = { status: res.status, cors: res.headers['access-control-allow-origin'] || null };
            } catch (e) {
              state.fetch = { error: e.message };
            }
            const ok = state.fetch.status === 200 && (data.media.contentType.startsWith('video/') || state.fetch.cors);
            state.playerState = ok ? 'PLAYING' : 'IDLE';
            if (!ok) reply({ type: 'LOAD_FAILED', requestId: data.requestId });
            else reply(mediaStatus(data.requestId));
          } else if (data.type === 'PAUSE') {
            state.playerState = 'PAUSED';
            reply(mediaStatus(data.requestId));
          } else if (data.type === 'PLAY') {
            state.playerState = 'PLAYING';
            reply(mediaStatus(data.requestId));
          } else if (data.type === 'GET_STATUS' || data.type === 'SEEK') {
            reply(mediaStatus(data.requestId));
          }
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((r) => server.close(() => r())),
        server,
      });
    });
  });
}

module.exports = { startFakeChromecast };
