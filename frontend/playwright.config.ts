import { defineConfig, devices } from '@playwright/test';

const mobile = process.env.DESPLA_MOBILE_E2E === '1';
const chrome = process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? 'chrome';
const mobileSpecs = [
  '**/pwa.spec.ts',
  '**/auth-cognito-smoke.spec.ts',
  '**/marketing.spec.ts',
  '**/feedback-access.spec.ts',
];

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node scripts/serve-e2e.mjs',
    url: 'http://127.0.0.1:48674',
    reuseExistingServer: false,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:48674',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: mobile ? [
    {
      name: 'chrome-android',
      testMatch: mobileSpecs,
      use: { ...devices['Pixel 7'], channel: chrome, video: 'off' },
    },
    {
      name: 'webkit-iphone',
      testMatch: mobileSpecs,
      use: { ...devices['iPhone 15'], video: 'off' },
    },
  ] : [
    {
      name: 'chromium-system',
      use: { ...devices['Desktop Chrome'], channel: chrome },
    },
  ],
});
