import { ForbiddenException } from '@nestjs/common';

export const GOOGLE_MFA_COOKIE = '__Host-despensalista-google-mfa';
export const GOOGLE_MFA_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/',
} as const;

export class GoogleMfaRequiredException extends ForbiddenException {
  readonly code = 'GOOGLE_MFA_REQUIRED';

  constructor() {
    super('Google sign-in requires WebAuthn verification');
  }
}
