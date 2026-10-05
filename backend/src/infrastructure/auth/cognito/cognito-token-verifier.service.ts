import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  CognitoTokenVerifier,
  CognitoVerifiedClaims,
} from '../../../application/ports/cognito-auth.port';

type AwsJwtVerifier = {
  verify(token: string): Promise<Record<string, unknown>>;
};

@Injectable()
export class CognitoTokenVerifierService implements CognitoTokenVerifier {
  private accessTokenVerifier?: AwsJwtVerifier;
  private idTokenVerifier?: AwsJwtVerifier;

  constructor(private readonly configService: ConfigService) {}

  async verifyAccessToken(token: string): Promise<CognitoVerifiedClaims> {
    this.accessTokenVerifier ??= this.createVerifier('access');

    return this.toClaims(await this.accessTokenVerifier.verify(token));
  }

  async verifyIdToken(token: string): Promise<CognitoVerifiedClaims> {
    this.idTokenVerifier ??= this.createVerifier('id');

    return this.toClaims(await this.idTokenVerifier.verify(token));
  }

  private createVerifier(tokenUse: 'access' | 'id'): AwsJwtVerifier {
    return CognitoJwtVerifier.create({
      userPoolId: this.getUserPoolId(),
      tokenUse,
      clientId: this.configService.get<string>('COGNITO_CLIENT_ID') ?? '',
    });
  }

  private getUserPoolId(): string {
    const issuer = this.configService.get<string>('COGNITO_ISSUER');

    if (!issuer) {
      throw new Error('COGNITO_ISSUER is required');
    }

    const pathname = new URL(issuer).pathname;
    const userPoolId = pathname.split('/').filter(Boolean).at(-1);

    if (!userPoolId) {
      throw new Error('COGNITO_ISSUER must include a user pool id');
    }

    return userPoolId;
  }

  private toClaims(payload: Record<string, unknown>): CognitoVerifiedClaims {
    const cognitoUsername =
      this.optionalString(payload['cognito:username'])?.trim() ||
      this.optionalString(payload.username)?.trim() ||
      undefined;

    return {
      sub: this.requiredString(payload.sub),
      cognitoUsername,
      email: this.optionalString(payload.email),
      emailVerified: this.optionalBoolean(payload.email_verified),
      preferredUsername: this.optionalString(payload.preferred_username),
      name: this.optionalString(payload.name),
      nonce: this.optionalString(payload.nonce),
      authTime: this.optionalNumber(payload.auth_time),
    };
  }

  private requiredString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private optionalNumber(value: unknown): number | undefined {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);

      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }
}
