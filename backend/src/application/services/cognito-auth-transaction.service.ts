import { randomBytes, createHash } from 'crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';

export interface CognitoAuthTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

@Injectable()
export class CognitoAuthTransactionService {
  createTransaction(): CognitoAuthTransaction {
    const codeVerifier = this.createOpaqueValue(64);
    const { codeChallenge, codeChallengeMethod } =
      this.createPkceChallenge(codeVerifier);

    return {
      state: this.createOpaqueValue(32),
      nonce: this.createOpaqueValue(32),
      codeVerifier,
      codeChallenge,
      codeChallengeMethod,
    };
  }

  createPkceChallenge(codeVerifier: string): {
    codeChallenge: string;
    codeChallengeMethod: 'S256';
  } {
    return {
      codeChallenge: createHash('sha256')
        .update(codeVerifier)
        .digest('base64url'),
      codeChallengeMethod: 'S256',
    };
  }

  normalizeProvider(
    provider: string | null | undefined,
    allowedProviders: string[],
  ): string | undefined {
    const requestedProvider = provider?.trim();

    if (!requestedProvider) {
      return undefined;
    }

    const allowedProvider = allowedProviders.find(
      (allowed) =>
        allowed.toLocaleLowerCase('en-US') ===
        requestedProvider.toLocaleLowerCase('en-US'),
    );

    if (!allowedProvider) {
      throw new UnauthorizedException('Cognito provider is not allowed');
    }

    return allowedProvider;
  }

  normalizeRedirectTo(
    redirectTo: string | null | undefined,
    fallback = '/pantry',
  ): string {
    if (
      !redirectTo ||
      !redirectTo.startsWith('/') ||
      redirectTo.startsWith('//') ||
      containsUnsafeRedirectCharacter(redirectTo)
    ) {
      return fallback;
    }

    return redirectTo;
  }

  assertStateMatches(receivedState: string, expectedState: string): void {
    if (!receivedState || receivedState !== expectedState) {
      throw new UnauthorizedException('Invalid Cognito auth state');
    }
  }

  private createOpaqueValue(byteLength: number): string {
    return randomBytes(byteLength).toString('base64url');
  }
}

function containsUnsafeRedirectCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (
      character === '\\' ||
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true;
    }
  }

  return false;
}
