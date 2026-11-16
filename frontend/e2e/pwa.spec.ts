import { chromium, expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

test('publishes an installable manifest and an Apple home screen icon', async ({ page, baseURL, browserName }, testInfo) => {
  await page.goto('/login');
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: '/pantry',
    start_url: '/pantry',
    scope: '/',
    display: 'standalone',
    icons: expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    ]),
  });
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
  for (const icon of [...manifest.icons, { src: '/apple-touch-icon.png', sizes: '180x180' }]) {
    const dimensions = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }, icon.src);
    expect(dimensions).toBe(icon.sizes);
  }

  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  if (browserName === 'chromium') {
    // Chrome declines installation in Playwright's usual off-the-record context.
    const installContext = await chromium.launchPersistentContext(testInfo.outputPath('install-profile'), {
      channel: testInfo.project.use.channel,
    });
    try {
      const [installPage] = installContext.pages();
      await installPage.goto(new URL('/login', baseURL).href);
      const cdp = await installContext.newCDPSession(installPage);
      expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
    } finally {
      await installContext.close();
    }
  }
});

test('opens the app shell offline without caching account requests or deleting unrelated caches', async ({ page, context, browserName }) => {
  await page.goto('/favicon.ico');
  await page.evaluate(async () => { await caches.open('other-application-cache'); });
  await page.goto('/login');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.goto('/login?authError=cognito_state');
  await expect(page.getByRole('alert')).toContainText('El inicio de sesión caducó');
  await page.evaluate(() => fetch('/api/auth/cognito/providers'));

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const paths = await Promise.all(names.filter((name) => name.startsWith('despensalista-')).map(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map(({ url }) => url);
    }));
    return { names, urls: paths.flat() };
  });
  expect(cached.names).toContain('other-application-cache');
  expect(cached.urls.some((url) => /\/pwa-shell-[^/]+\.html$/.test(url))).toBe(true);
  expect(cached.urls.some((url) => new URL(url).pathname.startsWith('/api/') || new URL(url).search)).toBe(false);

  // WebKit's setOffline rejects the navigation before its worker can respond.
  // Abort the origin request in the local test server to exercise the same fallback.
  const launch = browserName === 'webkit' ? '/pantry?e2eDisconnect=1' : '/pantry';
  if (browserName !== 'webkit') await context.setOffline(true);
  await page.goto(launch);
  await expect(page.getByRole('button', { name: 'Entrar con correo' })).toBeVisible();
  const loginUrl = new URL(page.url());
  expect(loginUrl.pathname).toBe('/login');
  expect(loginUrl.searchParams.get('redirectTo')).toBe(launch);
});
