import { APP_BASE_HREF } from '@angular/common';
import { CommonEngine, isMainModule } from '@angular/ssr/node';
import express from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AppServerModule from './main.server';
import {
  applyApiCacheHeaders,
  buildApiProxyTarget,
  buildProxyHeaders,
  isAbortError,
} from './server-proxy';
import { createProtectedRouteRedirect } from './server-auth-routes';
import {
  createRateLimit,
  readPositiveInteger,
  readTrustProxyConfig,
} from './server-rate-limit';
import { applySecurityHeaders } from './server-security';
import { applyStaticAssetCacheHeaders } from './server-static-cache';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');
const indexHtml = join(serverDistFolder, 'index.server.html');
const backendUrl = process.env['BACKEND_URL'] ?? 'http://localhost:3000';
const apiRateLimitWindowMs = readPositiveInteger(
  process.env['API_RATE_LIMIT_WINDOW_MS'],
  60_000,
);
const apiRateLimitMax = readPositiveInteger(
  process.env['API_RATE_LIMIT_MAX'],
  120,
);
const proxyTimeoutMs = readPositiveInteger(
  process.env['API_PROXY_TIMEOUT_MS'],
  15_000,
);
const trustProxy = readTrustProxyConfig(
  process.env['TRUST_PROXY'] ?? process.env['API_TRUST_PROXY'],
);

const app = express();
const commonEngine = new CommonEngine();

app.set('trust proxy', trustProxy);
app.disable('x-powered-by');
app.use(applySecurityHeaders);

app.get('/healthz', (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.status(200).json({
    status: 'ok',
    service: 'despensalista-frontend',
  });
});

app.use('/api', createRateLimit(apiRateLimitWindowMs, apiRateLimitMax));
app.use('/api', express.json({ limit: '1mb' }), async (req, res, next) => {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), proxyTimeoutMs);

  try {
    const targetPath = req.originalUrl || '/api';
    const targetUrl = buildApiProxyTarget(backendUrl, targetPath);
    const headers = buildProxyHeaders(req);

    const requestInit: RequestInit = {
      method: req.method,
      headers,
      redirect: 'manual',
      signal: abortController.signal,
    };

    if (
      !['GET', 'HEAD'].includes(req.method.toUpperCase()) &&
      req.body &&
      Object.keys(req.body).length > 0
    ) {
      requestInit.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, requestInit);

    applyApiCacheHeaders(res);
    res.status(response.status);
    const setCookieHeaders = getSetCookieHeaders(response.headers);

    response.headers.forEach((value, key) => {
      if (
        key === 'content-length' ||
        key === 'content-encoding' ||
        key === 'cache-control' ||
        key === 'set-cookie'
      ) {
        return;
      }

      res.setHeader(key, value);
    });
    setCookieHeaders.forEach((cookie) => {
      res.append('set-cookie', cookie);
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');

      if (location) {
        res.setHeader('location', location);
        res.end();
        return;
      }
    }

    const payload = Buffer.from(await response.arrayBuffer());
    res.send(payload);
  } catch (error) {
    if (isAbortError(error)) {
      applyApiCacheHeaders(res);
      res.status(504).json({ message: 'Backend request timed out' });
      return;
    }

    next(error);
  } finally {
    clearTimeout(timeout);
  }
});

app.use(createProtectedRouteRedirect());

/**
 * Serve static files from /browser
 */
app.get(
  '**',
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: 'index.html',
    setHeaders: applyStaticAssetCacheHeaders,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.get('**', (req, res, next) => {
  const { protocol, originalUrl, baseUrl, headers } = req;

  commonEngine
    .render({
      bootstrap: AppServerModule,
      documentFilePath: indexHtml,
      url: `${protocol}://${headers.host}${originalUrl}`,
      publicPath: browserDistFolder,
      providers: [{ provide: APP_BASE_HREF, useValue: baseUrl }],
    })
    .then((html) => res.send(html))
    .catch((err) => next(err));
});

/**
 * Start the server if this module is the main entry point.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url)) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, () => {
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

export default app;

function getSetCookieHeaders(headers: Headers): string[] {
  const headersWithSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };
  const setCookieHeaders = headersWithSetCookie.getSetCookie?.();

  if (setCookieHeaders?.length) {
    return setCookieHeaders;
  }

  return headersWithSetCookie.raw?.()['set-cookie'] ?? [];
}
