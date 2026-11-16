import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/frontend/browser/', import.meta.url);
const workerFile = 'despensalista-sw.js';
const template = await readFile(new URL(`../public/${workerFile}`, import.meta.url), 'utf8');
const shell = await readFile(new URL('index.csr.html', dist));
const bundles = (await readdir(dist)).filter((name) => /^(?:main|polyfills|chunk|styles)-[A-Z0-9]+\.(js|css)$/.test(name));

const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', dist), 'utf8'));
const assets = [...new Set([
  ...bundles,
  'offline.html',
  'manifest.webmanifest',
  'apple-touch-icon.png',
  'favicon.ico',
  ...manifest.icons.map(({ src }) => src.replace(/^\//, '')),
])].sort();

const hash = createHash('sha256').update(template).update(shell);
for (const asset of assets) {
  hash.update(asset).update(await readFile(new URL(asset, dist)));
}

// The shell URL and cache name change together. An installed worker can keep
// serving its complete release while CloudFront publishes a new one.
const version = hash.digest('hex').slice(0, 16);
const shellName = `pwa-shell-${version}.html`;
const release = {
  cacheName: `despensalista-shell-${version}`,
  shell: `/${shellName}`,
  assets: assets.map((asset) => `/${asset}`),
};

await writeFile(new URL(shellName, dist), shell);
await writeFile(new URL(workerFile, dist), template.replace('/* release */ null', JSON.stringify(release)));
