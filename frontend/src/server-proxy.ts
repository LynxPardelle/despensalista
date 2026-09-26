import type { Request, Response } from 'express';

const SKIPPED_PROXY_HEADERS = new Set([
  'connection',
  'content-length',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
]);

export function buildProxyHeaders(req: Request): Headers {
  const headers = new Headers();

  Object.entries(req.headers).forEach(([key, value]) => {
    const normalizedKey = key.toLowerCase();

    if (!value || SKIPPED_PROXY_HEADERS.has(normalizedKey)) {
      return;
    }

    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  });

  if (!headers.has('x-request-id')) {
    headers.set('x-request-id', createRequestId());
  }

  headers.set('x-forwarded-host', req.hostname);
  headers.set('x-forwarded-proto', req.protocol);

  return headers;
}

export function buildApiProxyTarget(
  backendUrl: string,
  requestTarget: string,
): URL {
  const requestPath = requestTarget.split(/[?#]/, 1)[0];

  if (
    /[\u0000-\u001f\u007f]/.test(requestTarget) ||
    requestTarget.includes('\\') ||
    /%(?:2f|5c)/i.test(requestPath) ||
    !isApiPath(requestTarget)
  ) {
    throw new TypeError('Invalid API proxy target');
  }

  const backend = new URL(backendUrl);

  if (backend.protocol !== 'http:' && backend.protocol !== 'https:') {
    throw new TypeError('Backend URL must use HTTP or HTTPS');
  }

  const target = new URL(requestTarget, `${backend.origin}/`);

  if (target.origin !== backend.origin || !isApiPath(target.pathname)) {
    throw new TypeError('API proxy target escaped the backend origin or API path');
  }

  return target;
}

export function applyApiCacheHeaders(res: Response): void {
  res.setHeader('cache-control', 'no-store');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function createRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isApiPath(value: string): boolean {
  return (
    value === '/api' || value.startsWith('/api/') || value.startsWith('/api?')
  );
}
