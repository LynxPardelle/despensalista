import {
  applyApiCacheHeaders,
  buildApiProxyTarget,
  buildProxyHeaders,
  isAbortError,
} from './server-proxy';

describe('server proxy helpers', () => {
  it('sanitizes hop-by-hop headers and forwards safe request context', () => {
    const headers = buildProxyHeaders({
      headers: {
        connection: 'keep-alive',
        cookie: 'session=abc',
        host: 'public.example',
        'idempotency-key': '9b29fb9a-ce30-473f-abaf-f8d987634f55',
        'x-xsrf-token': 'xsrf-token',
      },
      hostname: 'despensalista.example',
      protocol: 'https',
    } as never);

    expect(headers.get('connection')).toBeNull();
    expect(headers.get('host')).toBeNull();
    expect(headers.get('cookie')).toBe('session=abc');
    expect(headers.get('idempotency-key')).toBe(
      '9b29fb9a-ce30-473f-abaf-f8d987634f55',
    );
    expect(headers.get('x-xsrf-token')).toBe('xsrf-token');
    expect(headers.get('x-forwarded-host')).toBe('despensalista.example');
    expect(headers.get('x-forwarded-proto')).toBe('https');
    expect(headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('marks proxied API responses as non-cacheable', () => {
    const res = {
      setHeader: jasmine.createSpy('setHeader'),
    };

    applyApiCacheHeaders(res as never);

    expect(res.setHeader).toHaveBeenCalledWith('cache-control', 'no-store');
  });

  it('detects abort errors for proxy timeout handling', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';

    expect(isAbortError(error)).toBeTrue();
  });

  it('builds API destinations from the backend origin', () => {
    const target = buildApiProxyTarget(
      'https://backend.example/internal/base',
      '/api/products?archived=false',
    );

    expect(target.href).toBe(
      'https://backend.example/api/products?archived=false',
    );
  });

  [
    ['absolute-form targets', 'https://attacker.example/api/products'],
    ['network-path targets', '//attacker.example/api/products'],
    ['backslashes', '/api\\@attacker.example/products'],
    ['encoded backslashes', '/api/%5c../admin'],
    ['control characters', '/api/products\u0000ignored'],
    ['dot-segment escapes', '/api/../admin'],
    ['encoded dot-segment escapes', '/api/%2e%2e/admin'],
    ['non-API prefixes', '/apiary/products'],
  ].forEach(([description, requestTarget]) => {
    it(`rejects ${description}`, () => {
      expect(() =>
        buildApiProxyTarget('https://backend.example', requestTarget),
      ).toThrowError();
    });
  });
});
