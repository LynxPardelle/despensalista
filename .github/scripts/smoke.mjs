import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifyDeployment({ baseUrl, fetchImpl = fetch }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  await verifyJsonEndpoint({
    fetchImpl,
    label: 'frontend health',
    url: `${normalizedBaseUrl}/healthz`,
    expectedService: 'despensalista-frontend',
  });
  await verifyJsonEndpoint({
    fetchImpl,
    label: 'backend health',
    url: `${normalizedBaseUrl}/api/healthz`,
    expectedService: 'despensalista-backend',
  });

  const loginUrl = `${normalizedBaseUrl}/login/`;
  const loginResponse = await fetchImpl(loginUrl, requestOptions());
  if (!loginResponse.ok) {
    throw new Error(`login route returned HTTP ${loginResponse.status}`);
  }
  const loginHtml = await loginResponse.text();
  if (
    !loginHtml.includes('<app-root') ||
    !/<script[^>]+src=["'][^"']*(?:main|chunk)-[^"']+\.js/i.test(loginHtml)
  ) {
    throw new Error('login route did not contain the Angular application shell');
  }
}

export async function verifyWithRetries({
  baseUrl,
  attempts = 1,
  delayMs = 0,
  fetchImpl = fetch,
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await verifyDeployment({ baseUrl, fetchImpl });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        process.stderr.write(
          `Smoke attempt ${attempt}/${attempts} failed: ${messageOf(error)}\n`,
        );
        await delay(delayMs);
      }
    }
  }

  throw lastError;
}

async function verifyJsonEndpoint({ fetchImpl, label, url, expectedService }) {
  const response = await fetchImpl(url, requestOptions());
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} did not return JSON`);
  }

  if (body?.status !== 'ok' || body?.service !== expectedService) {
    throw new Error(`${label} returned an unexpected service payload`);
  }
}

function requestOptions() {
  return {
    headers: { 'user-agent': 'despensalista-github-smoke/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  };
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Smoke base URL must use HTTP or HTTPS');
  }
  return url.href.replace(/\/$/, '');
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid CLI argument: ${key ?? ''}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options['base-url']) {
    throw new Error('Usage: smoke.mjs --base-url <url> [--attempts N --delay-ms N]');
  }
  const attempts = Number.parseInt(options.attempts ?? '1', 10);
  const delayMs = Number.parseInt(options['delay-ms'] ?? '0', 10);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 30) {
    throw new Error('Smoke attempts must be between 1 and 30');
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error('Smoke delay must be between 0 and 60000 milliseconds');
  }

  await verifyWithRetries({
    baseUrl: options['base-url'],
    attempts,
    delayMs,
  });
  process.stdout.write(`Smoke passed for ${options['base-url']}.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}
