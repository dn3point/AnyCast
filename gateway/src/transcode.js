'use strict';
// Optional ffmpeg "compat mode": remux whatever the site serves (HLS, DASH,
// separate audio+video tracks, FLV, ...) into a single MPEG-TS stream that
// basically every DLNA TV can play. Streams are copied, never re-encoded, so
// even a Raspberry Pi can do it. Input goes through the local relay, so the
// browser's Referer / Cookie still apply.

const { spawn, spawnSync } = require('node:child_process');
const log = require('./util/log');

let ffmpegBin;
function ffmpegAvailable() {
  if (ffmpegBin !== undefined) return Boolean(ffmpegBin);
  const bin = process.env.ANYCAST_FFMPEG || 'ffmpeg';
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 8000 });
  ffmpegBin = r.status === 0 ? bin : null;
  return Boolean(ffmpegBin);
}

function buildArgs({ inputs, startAt = 0 }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  for (const input of inputs) {
    if (startAt > 0) args.push('-ss', String(startAt));
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4');
    args.push('-i', input);
  }
  if (inputs.length > 1) args.push('-map', '0:v:0', '-map', '1:a:0');
  else args.push('-map', '0:v:0?', '-map', '0:a:0?');
  args.push('-c', 'copy', '-copyts', '-muxdelay', '0', '-f', 'mpegts', 'pipe:1');
  return args;
}

/**
 * Serve /t/<sessionId>/stream.ts
 * @param {{inputs:string[]}} job local relay URLs to read from
 */
function serveTranscode(req, res, job, startAt = 0) {
  const headers = {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-cache',
    Connection: 'close',
    'Access-Control-Allow-Origin': '*',
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org':
      'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000',
  };
  // Raw stream without chunked encoding: several TVs mis-handle chunked TS.
  res.useChunkedEncodingByDefault = false;
  res.chunkedEncoding = false;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  if (!ffmpegAvailable()) return res.end();

  const args = buildArgs({ inputs: job.inputs, startAt });
  log.info('ffmpeg', `remux start (${job.inputs.length} input${job.inputs.length > 1 ? 's' : ''}, ss=${startAt})`);
  const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-2000);
  });
  proc.stdout.pipe(res);
  proc.on('close', (code) => {
    if (code && code !== 255) log.warn('ffmpeg', `exited ${code}: ${stderr.trim().split('\n').pop()}`);
    res.end();
  });
  proc.on('error', (err) => {
    log.warn('ffmpeg', err.message);
    res.end();
  });
  res.on('close', () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  });
  return undefined;
}

module.exports = { ffmpegAvailable, serveTranscode, buildArgs };
