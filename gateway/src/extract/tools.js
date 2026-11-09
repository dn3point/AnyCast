'use strict';
// Optional heavy-weight extractors. Both are used only if available on the
// gateway host: yt-dlp (thousands of site-specific extractors) and a headless
// Chromium via Playwright (sniffs network requests like the browser would).

const { spawn, spawnSync } = require('node:child_process');
const { detectKind } = require('../media');
const log = require('../util/log');

let ytdlpBin;
function ytdlpAvailable() {
  if (ytdlpBin !== undefined) return Boolean(ytdlpBin);
  const bin = process.env.ANYCAST_YTDLP || 'yt-dlp';
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000 });
  ytdlpBin = r.status === 0 ? bin : null;
  return Boolean(ytdlpBin);
}

function resetToolCache() {
  ytdlpBin = undefined;
  headlessOk = undefined;
}

function runJson(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `exit ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`yt-dlp returned invalid JSON: ${e.message}`));
      }
    });
  });
}

function kindFromYtdlp(f) {
  const proto = String(f.protocol || '');
  if (proto.includes('m3u8')) return 'hls';
  if (proto.includes('dash')) return 'dash';
  return detectKind(f.url, f.ext ? `video/${f.ext}` : '') || 'progressive';
}

/** Convert yt-dlp JSON (-J) into AnyCast candidates. */
function candidatesFromYtdlp(info) {
  const out = [];
  const headersOf = (f) => ({ ...(info.http_headers || {}), ...(f.http_headers || {}) });
  if (Array.isArray(info.requested_formats) && info.requested_formats.length === 2) {
    const v = info.requested_formats.find((f) => f.vcodec && f.vcodec !== 'none') || info.requested_formats[0];
    const a = info.requested_formats.find((f) => f !== v);
    out.push({
      url: v.manifest_url && kindFromYtdlp(v) !== 'progressive' ? v.manifest_url : v.url,
      audioUrl: a.url,
      kind: kindFromYtdlp(v),
      headers: headersOf(v),
      title: info.title,
      label: `${v.height ? `${v.height}p ` : ''}视频+音频（分离，需转封装）`,
      how: 'yt-dlp',
    });
  }
  if (info.url) {
    out.push({
      url: info.manifest_url && kindFromYtdlp(info) !== 'progressive' ? info.manifest_url : info.url,
      kind: kindFromYtdlp(info),
      headers: headersOf(info),
      title: info.title,
      label: `${info.height ? `${info.height}p ` : ''}${info.format_note || info.ext || ''}`.trim(),
      how: 'yt-dlp',
    });
  }
  // Best muxed (audio+video) formats as alternatives.
  const muxed = (info.formats || [])
    .filter((f) => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .slice(0, 3);
  for (const f of muxed) {
    if (out.some((c) => c.url === f.url)) continue;
    out.push({
      url: f.manifest_url && kindFromYtdlp(f) !== 'progressive' ? f.manifest_url : f.url,
      kind: kindFromYtdlp(f),
      headers: headersOf(f),
      title: info.title,
      label: `${f.height ? `${f.height}p ` : ''}${f.ext || ''}`.trim(),
      how: 'yt-dlp',
    });
  }
  return out;
}

async function extractWithYtdlp(pageUrl, { timeoutMs = 45000 } = {}) {
  if (!ytdlpAvailable()) return [];
  try {
    const info = await runJson(
      ytdlpBin,
      ['-J', '--no-playlist', '--no-warnings', '-f', 'b/bv*+ba', pageUrl],
      timeoutMs,
    );
    return candidatesFromYtdlp(info);
  } catch (err) {
    log.info('extract', `yt-dlp: ${err.message}`);
    return [];
  }
}

let headlessOk;
function headlessAvailable() {
  if (headlessOk !== undefined) return headlessOk;
  if (process.env.ANYCAST_HEADLESS === '0') return (headlessOk = false);
  try {
    require.resolve('playwright');
    headlessOk = true;
  } catch {
    headlessOk = false;
  }
  return headlessOk;
}

function cookieList(cookieHeader, pageUrl) {
  if (!cookieHeader) return [];
  const { hostname } = new URL(pageUrl);
  return cookieHeader
    .split(/;\s*/)
    .map((p) => p.split('='))
    .filter(([k]) => k)
    .map(([name, ...v]) => ({ name: name.trim(), value: v.join('='), domain: hostname, path: '/' }));
}

/**
 * Load the page in headless Chromium, tap the first video, and record media
 * requests together with the exact headers the browser sent.
 */
async function extractWithHeadless(pageUrl, { headers = {}, timeoutMs = 20000 } = {}) {
  if (!headlessAvailable()) return [];
  const { chromium } = require('playwright');
  let browser;
  const found = new Map();
  try {
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const context = await browser.newContext({
      userAgent: headers['user-agent'],
      viewport: { width: 412, height: 860 },
      isMobile: true,
    });
    await context.addCookies(cookieList(headers.cookie, pageUrl)).catch(() => {});
    const page = await context.newPage();
    let firstHit = null;
    page.on('request', async (req) => {
      const url = req.url();
      const kind = detectKind(url);
      if (!kind || found.has(url)) return;
      if (kind === 'progressive' && req.resourceType() === 'image') return;
      found.set(url, { url, kind, headers: await req.allHeaders().catch(() => req.headers()), how: 'headless' });
      firstHit = firstHit || Date.now();
    });
    page.on('response', async (res) => {
      const url = res.url();
      if (found.has(url)) return;
      const ct = res.headers()['content-type'] || '';
      if (!/mpegurl|dash\+xml|^video\//i.test(ct)) return;
      found.set(url, {
        url,
        kind: detectKind(url, ct) || 'progressive',
        headers: await res.request().allHeaders().catch(() => ({})),
        how: 'headless',
      });
      firstHit = firstHit || Date.now();
    });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    const title = await page.title().catch(() => null);
    // Nudge players that wait for a user gesture.
    await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (v) {
          v.muted = true;
          v.play().catch(() => {});
        }
        const btn = document.querySelector('[class*="play" i],[aria-label*="play" i],[aria-label*="播放"]');
        if (btn && btn.click) btn.click();
      })
      .catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (firstHit && Date.now() - firstHit > 2500) break;
      await page.waitForTimeout(300);
    }
    return [...found.values()].map((c) => ({ ...c, title }));
  } catch (err) {
    log.info('extract', `headless: ${err.message}`);
    return [...found.values()];
  } finally {
    await browser?.close().catch(() => {});
  }
}

module.exports = {
  ytdlpAvailable,
  headlessAvailable,
  extractWithYtdlp,
  extractWithHeadless,
  candidatesFromYtdlp,
  resetToolCache,
};
