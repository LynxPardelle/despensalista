// Replaced at build time by scripts/prepare-pwa.mjs.
const RELEASE = /* release */ null;

if (RELEASE) {
  const APP_PAGES = new Set(['/login', '/pantry', '/profile', '/feedback', '/mfa-google']);
  const PUBLIC_PAGES = new Set(['/', '/planes', '/privacidad', '/terminos-plus-hogar', '/shared-shopping-list']);
  const STATIC_ASSETS = new Set(RELEASE.assets);

  self.addEventListener('install', (event) => {
    event.waitUntil(prepareCache());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(activateRelease());
  });

  self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;

    const path = url.pathname.replace(/\/$/, '') || '/';
    if (request.mode === 'navigate') {
      const fallback = APP_PAGES.has(path) ? RELEASE.shell : PUBLIC_PAGES.has(path) ? '/offline.html' : null;
      if (fallback) event.respondWith(fetchWithOfflineFallback(request, fallback));
    } else if (!url.search && STATIC_ASSETS.has(url.pathname)) {
      event.respondWith(cachedAsset(request));
    }
  });
}

async function prepareCache() {
  const cache = await caches.open(RELEASE.cacheName);
  try {
    const urls = [RELEASE.shell, ...RELEASE.assets];
    await cache.addAll(urls.map((url) => new Request(url, { cache: 'reload' })));
  } catch (error) {
    await caches.delete(RELEASE.cacheName);
    throw error;
  }
}

async function activateRelease() {
  const names = await caches.keys();
  const previous = names.filter((name) => name.startsWith('despensalista-shell-') && name !== RELEASE.cacheName);
  await Promise.all(previous.map((name) => caches.delete(name)));
  await self.clients.claim();
}

async function fetchWithOfflineFallback(request, fallback) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(RELEASE.cacheName);
    return (await cache.match(fallback)) ?? Response.error();
  }
}

async function cachedAsset(request) {
  const cache = await caches.open(RELEASE.cacheName);
  return (await cache.match(request)) ?? fetch(request);
}
