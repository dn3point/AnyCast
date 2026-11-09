'use strict';
// Browser-level tests (Playwright + Chromium): page sniffer, bookmarklet
// hand-off through the phone UI, and the real extension end to end.
//   npm run test:browser
// Set ANYCAST_SHOTS=<dir> to save screenshots of the phone UI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startOrigin } = require('../fixtures/origin');
const { startFakeTv } = require('../../tools/fake-dlna-tv');
const { startGateway } = require('../helpers');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}
const SKIP = !chromium && 'playwright not installed';
const ROOT = path.join(__dirname, '..', '..', '..');
const EXT_DIR = path.join(ROOT, 'extension');
const SNIFFER = fs.readFileSync(path.join(EXT_DIR, 'sniffer.js'), 'utf8');
const SHOTS = process.env.ANYCAST_SHOTS || null;

let origin;
let g;
let tv;
let browser;

test.before(async () => {
  if (SKIP) return;
  origin = await startOrigin();
  g = await startGateway();
  tv = await startFakeTv({ name: '客厅电视（模拟）' });
  await g.api('POST', '/api/devices', { location: tv.location });
  browser = await chromium.launch();
});

test.after(async () => {
  if (SKIP) return;
  await browser?.close();
  await g.gw.close();
  await tv.close();
  await origin.close();
});

async function collectSniffer(context) {
  await context.addInitScript(() => {
    window.__found = { items: [], drm: null, mse: false };
    window.addEventListener('message', (e) => {
      if (!e.data || e.data.__anycast !== 1) return;
      if (e.data.items) window.__found.items.push(...e.data.items);
      if (e.data.drm) window.__found.drm = e.data.drm;
      if (e.data.mse) window.__found.mse = true;
    });
  });
  await context.addInitScript(SNIFFER);
}

test('sniffer: catches the manifest an MSE player fetches, and flags MSE', { skip: SKIP }, async () => {
  const context = await browser.newContext();
  await collectSniffer(context);
  const page = await context.newPage();
  await page.goto(`${origin.base}/set-cookie`);
  await page.goto(`${origin.base}/mse.html`);
  await page.waitForFunction(() => document.title.endsWith('ready'));
  const found = await page.evaluate(() => window.__found);
  const master = found.items.find((i) => i.url === `${origin.base}/hls/master.m3u8`);
  assert.ok(master, JSON.stringify(found));
  assert.ok(found.items.some((i) => i.kind === 'hls'), 'content-type confirms HLS');
  assert.equal(found.mse, true);
  await context.close();
});

test('sniffer: EME usage is reported as DRM', { skip: SKIP }, async () => {
  const context = await browser.newContext();
  await collectSniffer(context);
  const page = await context.newPage();
  await page.goto(`${origin.base}/drm.html`);
  await page.waitForFunction(() => document.title === 'DRM ready');
  assert.equal(await page.evaluate(() => window.__found.drm), 'com.widevine.alpha');
  await context.close();
});

test('bookmarklet -> phone UI -> TV plays (full user flow)', { skip: SKIP }, async () => {
  // 1. The phone UI builds the bookmarklet for this gateway.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const ui = await phone.newPage();
  await ui.goto(g.base + '/');
  await ui.waitForFunction(() => document.getElementById('bookmarklet').href.startsWith('javascript:'));
  const href = await ui.getAttribute('#bookmarklet', 'href');
  await ui.waitForSelector('#devices .item');
  if (SHOTS) await ui.screenshot({ path: path.join(SHOTS, 'phone-home.png'), fullPage: true });

  // 2. On a video site (MSE player, hot-link protected), run the bookmarklet
  //    exactly as the browser would evaluate the javascript: URL.
  const site = await phone.newPage();
  await site.goto(`${origin.base}/mse.html`);
  await site.waitForFunction(() => document.title.endsWith('ready'));
  await site.evaluate((code) => (0, eval)(decodeURIComponent(code)), href.slice('javascript:'.length));
  const sheet = site.locator('#anycast-sheet');
  await sheet.waitFor();
  assert.match(await sheet.innerText(), /找到 \d+ 个视频地址/);
  if (SHOTS) await site.screenshot({ path: path.join(SHOTS, 'bookmarklet-sheet.png') });
  const handoff = await sheet.locator('a').getAttribute('href');
  assert.ok(handoff.startsWith(`${g.base}/#p=`));

  // 3. Hand-off page: candidates are verified by the gateway with the page's cookie.
  await ui.goto(handoff);
  await ui.waitForSelector('#candidates .item');
  assert.equal(await ui.locator('#handoffTitle').innerText(), 'MSE 播放页 ready');
  const firstCandidate = await ui.locator('#candidates .item').first().innerText();
  assert.match(firstCandidate, /HLS/);
  assert.equal(await ui.evaluate(() => location.hash), '', 'payload removed from the address bar');

  // 4. Cast.
  const playback = tv.waitForPlayback();
  await ui.click('#castBtn');
  const result = await playback;
  assert.ok(result.ok, result.error);
  await ui.waitForSelector('#now:not([hidden])');
  await ui.waitForFunction(() => document.getElementById('nowState').textContent.includes('播放中'));
  assert.match(await ui.locator('#nowMode').innerText(), /网关代理/);
  if (SHOTS) await ui.screenshot({ path: path.join(SHOTS, 'phone-casting.png'), fullPage: true });

  // 5. Remote control from the phone.
  await ui.click('#playPause');
  await ui.waitForFunction(() => document.getElementById('nowState').textContent.includes('已暂停'));
  assert.equal(tv.state.transport, 'PAUSED_PLAYBACK');
  await ui.click('#stopBtn');
  await ui.waitForSelector('#now[hidden]', { state: 'attached' });
  await phone.close();
});

test('extension: captures the stream with request headers and casts it', { skip: SKIP }, async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anycast-ext-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
  } catch (err) {
    t.skip(`cannot launch Chromium with extensions here: ${err.message.split('\n')[0]}`);
    return;
  }
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = new URL(worker.url()).host;
    await worker.evaluate((gw) => chrome.storage.local.set({ gateway: gw }), g.base);

    const site = await context.newPage();
    await site.goto(`${origin.base}/set-cookie`);
    await site.goto(`${origin.base}/mse.html`);
    await site.waitForFunction(() => document.title.endsWith('ready'));

    // Floating in-page button appears once something castable was found.
    await site.waitForFunction(() => [...document.body.children].some((el) => el.shadowRoot === null && el.style.position === 'fixed'), null, { timeout: 5000 });

    const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u + '/*' }))[0].id, origin.base);

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
    await panel.waitForSelector('#media .item');
    const first = await panel.locator('#media .item').first().innerText();
    assert.match(first, /HLS/);
    assert.match(first, /已捕获请求头/, 'webRequest captured the real request headers');
    await panel.waitForSelector('#devices .item');

    const playback = tv.waitForPlayback();
    await panel.click('#cast');
    const result = await playback;
    assert.ok(result.ok, result.error);
    await panel.waitForFunction(() => document.getElementById('msg').textContent.includes('已投到'));
    const hits = origin.hits.filter((h) => h.path === '/hls/master.m3u8' && h.cookie);
    assert.ok(hits.length > 0, 'gateway replayed the cookie captured by the extension');
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
