import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CognitoVerifiedClaims } from '../../../application/ports/cognito-auth.port';
import { DynamoDbDocumentClientService } from '../../database/dynamodb/dynamodb-document-client.service';
import {
  GOOGLE_MFA_COOKIE,
  GOOGLE_MFA_COOKIE_OPTIONS,
  GoogleMfaRequiredException,
} from './google-mfa.constants';

const DEV_ORIGIN = 'https://dev.despensalista.lynxpardelle.com';
const DEV_ISSUER =
  'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_7MDhLOulC';
const DEV_TABLE = 'despensalista-dev-google-mfa';
const CHALLENGE_TTL_SECONDS = 300;
const PROOF_TTL_SECONDS = 3600;
const ENROLLMENT_MAX_AUTH_AGE_SECONDS = 900;
const NATIVE_USERNAME = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const GOOGLE_USERNAME = /^Google_\S+$/i;
const PROOF_TOKEN = /^[a-zA-Z0-9_-]{43}$/;

type Ceremony = 'registration' | 'authentication';

@Injectable()
export class GoogleMfaService {
  readonly enabled: boolean;
  private readonly origin: string;
  private readonly rpID: string;
  private readonly tableName: string;

  constructor(
    config: ConfigService,
    @Optional() private readonly db?: DynamoDbDocumentClientService,
  ) {
    this.tableName = config.get<string>('GOOGLE_MFA_TABLE') ?? '';
    this.origin = config.get<string>('GOOGLE_MFA_ORIGIN') ?? '';
    this.enabled = Boolean(this.tableName || this.origin);
    this.rpID = new URL(DEV_ORIGIN).hostname;
    if (!this.enabled) return;

    const providers = config
      .get<string>('COGNITO_ALLOWED_PROVIDERS')
      ?.split(',');
    if (
      !db ||
      this.origin !== DEV_ORIGIN ||
      this.tableName !== DEV_TABLE ||
      config.get<string>('COGNITO_ENABLED') !== 'true' ||
      config.get<string>('COGNITO_ISSUER') !== DEV_ISSUER ||
      config.get<string>('COGNITO_REDIRECT_URI') !==
        `${this.origin}/api/auth/cognito/callback` ||
      config.get<string>('AUTH_COOKIE_SECURE') === 'false' ||
      (config.get<string>('AUTH_COOKIE_SECURE') !== 'true' &&
        config.get<string>('NODE_ENV') !== 'production') ||
      config.get<string>('AUTH_COOKIE_DOMAIN') ||
      !providers?.includes('Google') ||
      providers.some((provider) => !['COGNITO', 'Google'].includes(provider))
    ) {
      throw new Error(
        'Invalid DespensaLista dev Google WebAuthn configuration',
      );
    }
  }

  requiresProof(claims: CognitoVerifiedClaims): boolean {
    if (!this.enabled) return false;

    // This email-only Cognito pool assigns UUID usernames to local accounts
    // and adds the identity provider prefix to Google federated usernames.
    const username = claims.cognitoUsername ?? '';
    if (NATIVE_USERNAME.test(username)) return false;
    if (GOOGLE_USERNAME.test(username)) {
      this.binding(claims);
      return true;
    }
    throw new UnauthorizedException('Invalid Cognito sign-in identity');
  }

  async assertVerified(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
  ): Promise<void> {
    if (this.requiresProof(claims) && !(await this.hasProof(claims, request))) {
      throw new GoogleMfaRequiredException();
    }
  }

  async status(claims: CognitoVerifiedClaims, request: FastifyRequest) {
    this.assertGoogleSession(claims);
    const [credential, verified] = await Promise.all([
      this.getCredential(claims.sub),
      this.hasProof(claims, request),
    ]);
    return { registered: Boolean(credential), verified };
  }

  async options(
    ceremony: Ceremony,
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
  ) {
    this.assertGoogleSession(claims, request);
    const credential = await this.getCredential(claims.sub);
    const timeout = CHALLENGE_TTL_SECONDS * 1000;
    const options =
      ceremony === 'registration'
        ? await generateRegistrationOptions({
            ...this.registrationOptions(claims, credential),
            timeout,
          })
        : await generateAuthenticationOptions({
            rpID: this.rpID,
            userVerification: 'required',
            allowCredentials: [{ id: this.requireCredential(credential).id }],
            timeout,
          });
    await this.database.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: this.challengeKey(claims, ceremony),
          challenge: options.challenge,
          expiresAt: now() + CHALLENGE_TTL_SECONDS,
        },
      }),
    );
    return options;
  }

  async register(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
    response: RegistrationResponseJSON,
  ): Promise<{ ok: true }> {
    this.assertGoogleSession(claims, request);
    this.assertFreshEnrollment(claims);
    if (await this.getCredential(claims.sub)) {
      throw new ConflictException(
        'A WebAuthn credential is already registered',
      );
    }
    const pending = await this.consumeChallenge(claims, 'registration');
    const verification = await this.verifyResponse(() =>
      verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      }),
    );
    this.assertChallengeActive(pending.expiresAt);
    this.assertFreshEnrollment(claims);
    if (!verification.verified)
      throw new BadRequestException('Invalid WebAuthn response');

    const credential = verification.registrationInfo.credential;
    try {
      await this.database.send(
        new PutCommand({
          TableName: this.tableName,
          ConditionExpression: 'attribute_not_exists(pk)',
          Item: {
            pk: credentialKey(claims.sub),
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: credential.counter,
          },
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      throw new ConflictException('A WebAuthn credential cannot be registered');
    }
    return { ok: true };
  }

  async authenticate(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
    reply: FastifyReply,
    response: AuthenticationResponseJSON,
  ): Promise<{ ok: true }> {
    this.assertGoogleSession(claims, request);
    const pending = await this.consumeChallenge(claims, 'authentication');
    const credential = this.requireCredential(
      await this.getCredential(claims.sub),
    );
    const verification = await this.verifyResponse(() =>
      verifyAuthenticationResponse({
        response,
        credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      }),
    );
    this.assertChallengeActive(pending.expiresAt);
    if (!verification.verified)
      throw new BadRequestException('Invalid WebAuthn response');

    try {
      await this.database.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: credentialKey(claims.sub) },
          UpdateExpression: 'SET #counter = :newCounter',
          ConditionExpression:
            'credentialId = :credentialId AND #counter = :oldCounter',
          ExpressionAttributeNames: { '#counter': 'counter' },
          ExpressionAttributeValues: {
            ':credentialId': credential.id,
            ':oldCounter': credential.counter,
            ':newCounter': verification.authenticationInfo.newCounter,
          },
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      throw new ConflictException('Request new WebAuthn options and try again');
    }

    await this.revokeProof(request);
    const token = randomBytes(32).toString('base64url');
    await this.database.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: proofKey(token),
          binding: this.binding(claims),
          expiresAt: now() + PROOF_TTL_SECONDS,
        },
      }),
    );
    reply.setCookie(GOOGLE_MFA_COOKIE, token, {
      ...GOOGLE_MFA_COOKIE_OPTIONS,
      maxAge: PROOF_TTL_SECONDS,
    });
    return { ok: true };
  }

  async revokeProof(request: FastifyRequest): Promise<void> {
    const token = this.readProofToken(request);
    if (!token || !this.enabled) return;
    await this.database.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: proofKey(token) },
      }),
    );
  }

  async deleteCredential(subject: string): Promise<void> {
    if (!this.enabled) return;
    // Replace the key with a short-lived tombstone so an in-flight
    // registration cannot re-create the credential after account deletion.
    await this.database.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: credentialKey(subject),
          expiresAt: now() + CHALLENGE_TTL_SECONDS,
        },
      }),
    );
  }

  private get database(): DynamoDbDocumentClientService {
    if (!this.db) throw new Error('WebAuthn storage is unavailable');
    return this.db;
  }

  private assertGoogleSession(
    claims: CognitoVerifiedClaims,
    request?: FastifyRequest,
  ): void {
    if (!this.requiresProof(claims)) {
      throw new NotFoundException('Google WebAuthn is unavailable');
    }
    if (request && request.headers.origin !== this.origin) {
      throw new ForbiddenException('Invalid WebAuthn request origin');
    }
  }

  private binding(claims: CognitoVerifiedClaims): string {
    if (!claims.sub || !claims.originJti) {
      throw new UnauthorizedException('Invalid Google session binding');
    }
    return digest(`${claims.sub}\0${claims.originJti}`);
  }

  private challengeKey(
    claims: CognitoVerifiedClaims,
    ceremony: Ceremony,
  ): string {
    return `challenge:${ceremony}:${this.binding(claims)}`;
  }

  private async consumeChallenge(
    claims: CognitoVerifiedClaims,
    ceremony: Ceremony,
  ) {
    try {
      const { Attributes } = await this.database.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: this.challengeKey(claims, ceremony) },
          ConditionExpression: 'expiresAt > :now',
          ExpressionAttributeValues: { ':now': now() },
          ReturnValues: 'ALL_OLD',
        }),
      );
      if (
        typeof Attributes?.challenge === 'string' &&
        typeof Attributes.expiresAt === 'number'
      ) {
        return {
          challenge: Attributes.challenge,
          expiresAt: Attributes.expiresAt,
        };
      }
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
    throw new BadRequestException('Request new WebAuthn options and try again');
  }

  private assertChallengeActive(expiresAt: number): void {
    if (expiresAt <= now()) {
      throw new BadRequestException(
        'Request new WebAuthn options and try again',
      );
    }
  }

  private async getCredential(
    subject: string,
  ): Promise<WebAuthnCredential | undefined> {
    const { Item } = await this.database.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: credentialKey(subject) },
        ConsistentRead: true,
      }),
    );
    if (!Item || typeof Item.expiresAt === 'number') return undefined;
    if (
      typeof Item.credentialId !== 'string' ||
      typeof Item.publicKey !== 'string' ||
      typeof Item.counter !== 'number'
    ) {
      throw new Error('Invalid stored WebAuthn credential');
    }
    return {
      id: Item.credentialId,
      publicKey: Buffer.from(Item.publicKey, 'base64url'),
      counter: Item.counter,
    };
  }

  private requireCredential(
    credential: WebAuthnCredential | undefined,
  ): WebAuthnCredential {
    if (!credential)
      throw new BadRequestException('Register a WebAuthn credential first');
    return credential;
  }

  private registrationOptions(
    claims: CognitoVerifiedClaims,
    existing: WebAuthnCredential | undefined,
  ): Parameters<typeof generateRegistrationOptions>[0] {
    this.assertFreshEnrollment(claims);
    if (existing)
      throw new ConflictException(
        'A WebAuthn credential is already registered',
      );
    const userHandle = createHash('sha256').update(claims.sub).digest();
    return {
      rpName: 'DespensaLista Dev',
      rpID: this.rpID,
      userID: userHandle,
      userName: `DespensaLista Dev (${userHandle.toString('hex').slice(0, 8)})`,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    };
  }

  private assertFreshEnrollment(claims: CognitoVerifiedClaims): void {
    const authTime = claims.authTime ?? 0;
    const age = now() - authTime;
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age >= ENROLLMENT_MAX_AUTH_AGE_SECONDS
    ) {
      throw new UnauthorizedException(
        'Sign in again before registering a WebAuthn credential',
      );
    }
  }

  private async verifyResponse<T>(verify: () => Promise<T>): Promise<T> {
    try {
      return await verify();
    } catch {
      throw new BadRequestException('Invalid WebAuthn response');
    }
  }

  private async hasProof(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
  ): Promise<boolean> {
    const token = this.readProofToken(request);
    if (!token) return false;
    const { Item } = await this.database.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: proofKey(token) },
        ConsistentRead: true,
      }),
    );
    return (
      Item?.binding === this.binding(claims) &&
      typeof Item.expiresAt === 'number' &&
      Item.expiresAt > now()
    );
  }

  private readProofToken(request: FastifyRequest): string | undefined {
    const token = request.cookies?.[GOOGLE_MFA_COOKIE];
    return token && PROOF_TOKEN.test(token) ? token : undefined;
  }
}

function credentialKey(subject: string): string {
  return `credential:${digest(subject)}`;
}

function proofKey(token: string): string {
  return `proof:${digest(token)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'ConditionalCheckFailedException'
  );
}
