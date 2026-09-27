import { UnauthorizedException } from '@nestjs/common';
import { CognitoAuthTransactionService } from './cognito-auth-transaction.service';

describe('CognitoAuthTransactionService', () => {
  const service = new CognitoAuthTransactionService();

  it('creates an S256 PKCE code challenge from a verifier', () => {
    expect(service.createPkceChallenge('sample-verifier')).toEqual({
      codeChallenge: 'abasUUqDJc2OV5lZNoM-7GwF4WqxlIUb0UAD7LsCqHY',
      codeChallengeMethod: 'S256',
    });
  });

  it('rejects providers outside the configured allowlist', () => {
    expect(() =>
      service.normalizeProvider('GitHub', ['Google', 'Facebook']),
    ).toThrow(UnauthorizedException);
  });

  it('accepts allowed provider names case-insensitively and returns canonical casing', () => {
    expect(service.normalizeProvider('google', ['Google', 'Facebook'])).toBe(
      'Google',
    );
  });

  it('keeps safe relative redirects', () => {
    expect(service.normalizeRedirectTo('/pantry?tab=depletion')).toBe(
      '/pantry?tab=depletion',
    );
  });

  it('rejects external and protocol-relative redirects', () => {
    expect(service.normalizeRedirectTo('https://evil.example/pantry')).toBe(
      '/pantry',
    );
    expect(service.normalizeRedirectTo('//evil.example/pantry')).toBe(
      '/pantry',
    );
  });

  it('rejects redirects containing backslashes', () => {
    expect(service.normalizeRedirectTo('/\\evil.example/pantry')).toBe(
      '/pantry',
    );
    expect(service.normalizeRedirectTo('/pantry\\settings')).toBe('/pantry');
  });

  it('rejects redirects containing control characters', () => {
    expect(service.normalizeRedirectTo('/pantry\nhttps://evil.example')).toBe(
      '/pantry',
    );
    expect(service.normalizeRedirectTo('/pantry\u0000')).toBe('/pantry');
    expect(service.normalizeRedirectTo('/pantry\u007f')).toBe('/pantry');
  });
});
