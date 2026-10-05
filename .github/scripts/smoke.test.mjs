import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

async function loadSmokeModule() {
  return import(pathToFileURL(path.join(import.meta.dirname, 'smoke.mjs')));
}

test('verifies frontend, backend, and login from one public base URL', async () => {
  const { verifyDeployment } = await loadSmokeModule();
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.endsWith('/api/healthz')) {
      return response({ status: 'ok', service: 'despensalista-backend' });
    }
    if (url.endsWith('/healthz')) {
      return response({ status: 'ok', service: 'despensalista-frontend' });
    }
    return response('<html><app-root></app-root><script src="main-ABC.js"></script></html>');
  };

  await verifyDeployment({
    baseUrl: 'https://despensalista.example/',
    fetchImpl,
  });

  assert.deepEqual(requestedUrls, [
    'https://despensalista.example/healthz',
    'https://despensalista.example/api/healthz',
    'https://despensalista.example/login/',
  ]);
});

test('fails when a key user-facing endpoint is unhealthy', async () => {
  const { verifyDeployment } = await loadSmokeModule();
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/healthz')) {
      return new Response('failed', { status: 503 });
    }
    if (url.endsWith('/healthz')) {
      return response({ status: 'ok', service: 'despensalista-frontend' });
    }
    return response('<app-root></app-root><script src="main-ABC.js"></script>');
  };

  await assert.rejects(
    verifyDeployment({ baseUrl: 'https://despensalista.example', fetchImpl }),
    /backend health/i,
  );
});

function response(body) {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status: 200 },
  );
}
