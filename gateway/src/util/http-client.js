'use strict';
// Minimal HTTP(S) client on top of node:http so we keep full control over
// request headers (Referer / Cookie / Origin are "forbidden" in fetch-land),
// never decompress media bodies, and can stream responses straight through.

const http = require('node:http');
const https = require('node:https');

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Mobile Safari/537.36';

const TV_UA = 'AnyCast-Probe/0.1 (SmartTV; DLNADOC/1.50) Lavf/60';

const agentOptions = { keepAlive: true, maxSockets: 64 };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Perform a request and resolve once response headers arrive.
 * Redirects are followed manually; credentials are dropped on cross-origin hops
 * (same rule browsers apply to captured Cookie / Authorization headers).
 *
 * @returns {Promise<{status:number, headers:object, url:string, stream:import('http').IncomingMessage, abort:Function}>}
 */
function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    timeout = 15000,
    streamTimeout = 120000,
    maxRedirects = 5,
    body,
  } = opts;

  return new Promise((resolve, reject) => {
    const attempt = (currentUrl, redirectsLeft, currentHeaders, currentMethod) => {
      let u;
      try {
        u = new URL(currentUrl);
      } catch (err) {
        reject(new Error(`Invalid URL: ${currentUrl}`));
        return;
      }
      const isHttps = u.protocol === 'https:';
      if (!isHttps && u.protocol !== 'http:') {
        reject(new Error(`Unsupported protocol: ${u.protocol}`));
        return;
      }
      const lib = isHttps ? https : http;
      const req = lib.request(
        u,
        {
          method: currentMethod,
          headers: currentHeaders,
          agent: isHttps ? httpsAgent : httpAgent,
          timeout,
          // Many CDNs serve media with certificates that are fine; but never
          // disable verification globally.
        },
        (res) => {
          if (REDIRECTS.has(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            let next;
            try {
              next = new URL(res.headers.location, u).toString();
            } catch {
              reject(new Error(`Bad redirect location: ${res.headers.location}`));
              return;
            }
            const nextHeaders = { ...currentHeaders };
            if (new URL(next).origin !== u.origin) {
              delete nextHeaders.cookie;
              delete nextHeaders.authorization;
            }
            const nextMethod = res.statusCode === 303 ? 'GET' : currentMethod;
            attempt(next, redirectsLeft - 1, nextHeaders, nextMethod);
            return;
          }
          // Headers are in; from now on only guard against a stalled body.
          req.setTimeout(streamTimeout);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            url: currentUrl,
            stream: res,
            abort: () => req.destroy(),
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Upstream timeout: ${u.host}`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    };
    attempt(url, maxRedirects, lowerKeys(headers), method);
  });
}

function readBody(stream, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    // 'end' may already have fired right after a peek() paused the stream.
    if (stream.readableEnded) {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        stream.destroy();
        reject(new Error(`Body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    // A stream paused by peek() does not restart just because a 'data'
    // listener was added; resume explicitly.
    stream.resume();
  });
}

async function fetchText(url, opts = {}) {
  const res = await request(url, opts);
  const buf = await readBody(res.stream, opts.limit);
  return { status: res.status, headers: res.headers, url: res.url, text: buf.toString('utf8') };
}

/**
 * Read at least `n` bytes (or until end) from a readable without losing data.
 * The stream is left paused; continue with pipeRest()/readBody(). Note that
 * 'end' can still fire after we return, so always check `readableEnded`.
 */
function peek(stream, n) {
  return new Promise((resolve, reject) => {
    if (stream.readableEnded) {
      resolve({ head: Buffer.alloc(0), ended: true });
      return;
    }
    const chunks = [];
    let len = 0;
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const finish = (ended) => {
      cleanup();
      stream.pause();
      resolve({ head: Buffer.concat(chunks), ended });
    };
    function onData(chunk) {
      chunks.push(chunk);
      len += chunk.length;
      if (len >= n) finish(false);
    }
    function onEnd() {
      finish(true);
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.resume(); // needed when an earlier peek() paused the stream
  });
}

/** Pipe the remainder of a (possibly already finished) readable into `dest`. */
function pipeRest(stream, dest) {
  if (stream.readableEnded) {
    dest.end();
    return;
  }
  stream.pipe(dest);
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue;
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

module.exports = { request, readBody, fetchText, peek, pipeRest, lowerKeys, DEFAULT_UA, TV_UA };
