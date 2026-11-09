'use strict';
// Media type helpers shared by the extractor, the relay and the cast planner.

const EXT_MIME = {
  m3u8: 'application/vnd.apple.mpegurl',
  m3u: 'application/vnd.apple.mpegurl',
  mpd: 'application/dash+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  flv: 'video/x-flv',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  m4s: 'video/mp4',
  cmfv: 'video/mp4',
  cmfa: 'audio/mp4',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  vtt: 'text/vtt',
  webvtt: 'text/vtt',
};

const MEDIA_EXTS = new Set(['m3u8', 'm3u', 'mpd', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'flv', 'avi']);
const SEGMENT_EXTS = new Set(['ts', 'm2ts', 'm4s', 'mp4', 'm4v', 'cmfv', 'cmfa', 'm4a', 'aac', 'mp3', 'vtt', 'webvtt', 'fmp4']);

// Well-known DRM system ids. Content protected by these cannot be cast by a
// third-party sender: the licence is bound to the browser's CDM.
const DRM_SYSTEMS = [
  { name: 'Widevine', re: /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|com\.widevine/i },
  { name: 'PlayReady', re: /9a04f079-9840-4286-ab92-e65be0885f95|com\.microsoft\.playready/i },
  { name: 'FairPlay', re: /94ce86fb-07ff-4f43-adb8-93d2fa968ca2|com\.apple\.(?:fps|streamingkeydelivery)|skd:\/\//i },
];

function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const m = /\.([a-z0-9]{1,6})$/i.exec(p);
    return m ? m[1].toLowerCase() : '';
  } catch {
    const m = /\.([a-z0-9]{1,6})(?:[?#]|$)/i.exec(String(url));
    return m ? m[1].toLowerCase() : '';
  }
}

function mimeFromExt(url) {
  return EXT_MIME[extOf(url)] || null;
}

/** Classify a media URL / content-type into hls | dash | progressive | null. */
function detectKind(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (/mpegurl/.test(ct)) return 'hls';
  if (/dash\+xml/.test(ct)) return 'dash';
  const ext = extOf(url);
  if (ext === 'm3u8' || ext === 'm3u') return 'hls';
  if (ext === 'mpd') return 'dash';
  if (/^(video|audio)\//.test(ct)) return 'progressive';
  if (MEDIA_EXTS.has(ext)) return 'progressive';
  if (/[?&](?:type|format|ext)=m3u8\b/i.test(url)) return 'hls';
  return null;
}

/** Sniff a response body prefix. */
function sniffKind(buf) {
  if (!buf || !buf.length) return null;
  const head = buf.subarray(0, 2048).toString('latin1');
  if (head.replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart().startsWith('#EXTM3U')) return 'hls';
  if (/<MPD[\s>]/.test(head)) return 'dash';
  if (head.slice(4, 8) === 'ftyp') return 'progressive';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'progressive'; // EBML (mkv/webm)
  if (head.startsWith('FLV')) return 'progressive';
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'progressive'; // MPEG-TS
  return null;
}

function mimeFor(kind, url, contentType) {
  if (kind === 'hls') return 'application/vnd.apple.mpegurl';
  if (kind === 'dash') return 'application/dash+xml';
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (/^(video|audio)\//.test(ct)) return ct;
  return mimeFromExt(url) || 'video/mp4';
}

function detectDrm(text) {
  if (!text) return null;
  const s = String(text);
  // HLS: only key formats tied to a CDM count; plain AES-128 is not DRM.
  if (/#EXT-X-(?:SESSION-)?KEY/.test(s) || /<ContentProtection/i.test(s)) {
    for (const d of DRM_SYSTEMS) if (d.re.test(s)) return d.name;
  }
  if (/#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=SAMPLE-AES-CTR/.test(s)) return 'CENC';
  return null;
}

/** Image formats some sites wrap MPEG-TS segments in to dodge hot-link filters. */
function isImageSignature(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true; // BMP
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return true;
  return false;
}

/** Offset of the first run of 3 MPEG-TS sync bytes (188-byte packets), or -1. */
function findTsSync(buf, maxOffset = buf.length) {
  const limit = Math.min(maxOffset, buf.length - 377);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i;
  }
  return -1;
}

module.exports = {
  EXT_MIME,
  SEGMENT_EXTS,
  extOf,
  mimeFromExt,
  detectKind,
  sniffKind,
  mimeFor,
  detectDrm,
  isImageSignature,
  findTsSync,
};
