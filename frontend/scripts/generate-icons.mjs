import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  const variants = [
    { size: 192, file: 'icon-192.png' },
    { size: 512, file: 'icon-512.png' },
    { size: 512, file: 'icon-maskable-512.png', safeArea: true },
    { size: 180, file: 'apple-touch-icon.png' },
  ];
  for (const { size, file, safeArea } of variants) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>body{margin:0;background:#c47a4b;display:grid;place-items:center;height:100vh}svg{display:block;width:${safeArea ? 88 : 100}%;height:auto}</style>${svg}`);
    await page.screenshot({ path: fileURLToPath(new URL(`../public/${file}`, import.meta.url)) });
  }
} finally {
  await browser.close();
}
