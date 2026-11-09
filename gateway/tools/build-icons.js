#!/usr/bin/env node
'use strict';
// Render extension PNG icons from gateway/public/icon.svg (needs Playwright).
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'icon.svg'), 'utf8');
  const outDir = path.join(__dirname, '..', '..', 'extension', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(outDir, `icon${size}.png`), omitBackground: true });
  }
  await browser.close();
  console.log('icons written to', outDir);
})();
