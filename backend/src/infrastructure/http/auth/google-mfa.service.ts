import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CognitoVerifiedClaims } from '../../../application/ports/cognito-auth.port';
import { DynamoDbDocumentClientService } from '../../database/dynamodb/dynamodb-document-client.service';
import {
  GOOGLE_MFA_COOKIE,
  GOOGLE_MFA_COOKIE_OPTIONS,
  LEGACY_GOOGLE_MFA_COOKIE,
  GoogleMfaRequiredException,
} from './google-mfa.constants';
import {
  CredentialAccount,
  GoogleMfaStore,
  PendingWebAuthnChallenge,
  digest,
  fromWebAuthnCredential,
  toWebAuthnCredential,
} from './google-mfa-store';

const DEV_ORIGIN = 'https://dev.despensalista.lynxpardelle.com';
const DEV_ISSUER =
  'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_7MDhLOulC';
const DEV_TABLE = 'despensalista-dev-google-mfa';
const CHALLENGE_TTL_SECONDS = 300;
const PROOF_TTL_SECONDS = 3600;
const RECENT_PROOF_SECONDS = 300;
const ENROLLMENT_MAX_AUTH_AGE_SECONDS = 900;
const NATIVE_USERNAME = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const GOOGLE_USERNAME = /^Google_\S+$/i;
const PROOF_TOKEN = /^[a-zA-Z0-9_-]{43}$/;
const RECOVERY_CODE = /^[a-zA-Z0-9_-]{32}$/;

type Ceremony = 'registration' | 'authentication' | 'recovery';

@Injectable()
export class GoogleMfaService {
  readonly enabled: boolean;
  private readonly origin: string;
  private readonly rpID: string;
  private readonly tableName: string;
  private readonly store?: GoogleMfaStore;

  constructor(
    config: ConfigService,
    @Optional() db?: DynamoDbDocumentClientService,
  ) {
    this.tableName = config.get<string>('GOOGLE_MFA_TABLE') ?? '';
    this.origin = config.get<string>('GOOGLE_MFA_ORIGIN') ?? '';
    const proofVersion = config.get<string>('GOOGLE_MFA_PROOF_VERSION');
    this.enabled = Boolean(this.tableName || this.origin);
    this.rpID = new URL(DEV_ORIGIN).hostname;
    if (!this.enabled) return;

    const providers = config
      .get<string>('COGNITO_ALLOWED_PROVIDERS')
      ?.split(',');
    if (
      !db ||
      (proofVersion !== undefined && proofVersion !== '2') ||
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
    this.store = new GoogleMfaStore(db, this.tableName);
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
    if (!this.requiresProof(claims)) return;
    const proof = this.readProofToken(request);
    const account = proof
      ? await this.database.getAccount(claims.sub)
      : undefined;
    if (!(await this.getProof(claims, request, account))) {
      throw new GoogleMfaRequiredException();
    }
  }

  async status(claims: CognitoVerifiedClaims, request: FastifyRequest) {
    this.assertGoogleSession(claims);
    const account = await this.database.getAccount(claims.sub);
    const proof = await this.getProof(claims, request, account);
    return {
      registered: Boolean(account),
      verified: Boolean(proof),
      keyCount: account?.credentials.length ?? 0,
      recoveryConfigured: Boolean(account?.recoveryCodeHash),
      recentVerification: this.isRecent(proof),
    };
  }

  async options(
    ceremony: Exclude<Ceremony, 'recovery'>,
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
  ) {
    this.assertGoogleSession(claims, request);
    const account = await this.database.getAccount(claims.sub);
    if (ceremony === 'registration') {
      await this.authorizeRegistration(claims, request, account);
      return this.registrationOptions(claims, ceremony, account);
    }
    if (!account)
      throw new BadRequestException('Register a WebAuthn credential first');
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'required',
      allowCredentials: account.credentials.map(({ credentialId }) => ({
        id: credentialId,
      })),
      timeout: CHALLENGE_TTL_SECONDS * 1000,
    });
    await this.saveChallenge(claims, ceremony, options.challenge, account);
    return options;
  }

  async register(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
    response: RegistrationResponseJSON,
  ): Promise<{ ok: true }> {
    this.assertGoogleSession(claims, request);
    const account = await this.database.getAccount(claims.sub);
    await this.authorizeRegistration(claims, request, account);
    const pending = await this.consumeChallenge(
      claims,
      'registration',
      account,
    );
    const credential = await this.verifyRegistration(pending, response);
    await this.authorizeRegistration(claims, request, account);
    if (
      account?.credentials.some(
        ({ credentialId }) => credentialId === credential.credentialId,
      )
    ) {
      throw new ConflictException(
        'This WebAuthn credential is already registered',
      );
    }
    await this.writeAccount(claims, account, {
      credentials: [...(account?.credentials ?? []), credential],
      generation: account?.generation ?? randomUUID(),
      recoveryCodeHash: account?.recoveryCodeHash,
    });
    return { ok: true };
  }

  async issueRecoveryCode(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
  ): Promise<{ code: string }> {
    this.assertGoogleSession(claims, request);
    const account = await this.database.getAccount(claims.sub);
    if (!account) throw new GoogleMfaRequiredException();
    await this.assertRecentProof(claims, request, account);
    const code = randomBytes(24).toString('base64url');
    await this.writeAccount(claims, account, {
      ...account,
      recoveryCodeHash: digest(code),
    });
    return { code };
  }

  async recoveryOptions(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
    input: unknown,
  ) {
    this.assertGoogleSession(claims, request);
    this.assertFreshEnrollment(claims);
    if (!(await this.database.countRecoveryAttempt(claims.sub, now()))) {
      throw new HttpException(
        'Try recovering again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const account = await this.database.getAccount(claims.sub);
    const code =
      typeof input === 'string' && input.length <= 64 ? input.trim() : '';
    if (
      !account?.recoveryCodeHash ||
      !RECOVERY_CODE.test(code) ||
      !matchesDigest(account.recoveryCodeHash, digest(code))
    ) {
      throw new BadRequestException('Invalid recovery code');
    }
    return this.registrationOptions(claims, 'recovery', account);
  }

  async recover(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
    reply: FastifyReply,
    response: RegistrationResponseJSON,
  ): Promise<{ ok: true }> {
    this.assertGoogleSession(claims, request);
    this.assertFreshEnrollment(claims);
    const account = await this.database.getAccount(claims.sub);
    const pending = await this.consumeChallenge(claims, 'recovery', account);
    if (
      !account?.recoveryCodeHash ||
      pending.recoveryCodeHash !== account.recoveryCodeHash
    ) {
      throw new BadRequestException('Start WebAuthn recovery again');
    }
    const credential = await this.verifyRegistration(pending, response);
    this.assertFreshEnrollment(claims);
    if (
      account.credentials.some(
        ({ credentialId }) => credentialId === credential.credentialId,
      )
    ) {
      throw new ConflictException(
        'Use a different WebAuthn credential for recovery',
      );
    }
    // One conditional write replaces all keys, consumes the code and revokes
    // existing proofs, even when different sessions try the same code.
    await this.writeAccount(claims, account, {
      credentials: [credential],
      generation: randomUUID(),
    });
    reply.clearCookie(GOOGLE_MFA_COOKIE, GOOGLE_MFA_COOKIE_OPTIONS);
    reply.clearCookie(LEGACY_GOOGLE_MFA_COOKIE, GOOGLE_MFA_COOKIE_OPTIONS);
    return { ok: true };
  }

  async authenticate(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
    reply: FastifyReply,
    response: AuthenticationResponseJSON,
  ): Promise<{ ok: true }> {
    this.assertGoogleSession(claims, request);
    const account = await this.database.getAccount(claims.sub);
    const pending = await this.consumeChallenge(
      claims,
      'authentication',
      account,
    );
    const enrolled = account?.credentials.find(
      ({ credentialId }) => credentialId === response?.id,
    );
    if (
      !account ||
      !enrolled ||
      (response.response?.userHandle &&
        response.response.userHandle !== digest(claims.sub))
    ) {
      throw new BadRequestException('Invalid WebAuthn response');
    }
    const credential = toWebAuthnCredential(enrolled);
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

    await this.writeAccount(claims, account, {
      ...account,
      credentials: account.credentials.map((entry) =>
        entry === enrolled
          ? { ...entry, counter: verification.authenticationInfo.newCounter }
          : entry,
      ),
    });

    await this.revokeProof(request);
    const token = randomBytes(32).toString('base64url');
    const verifiedAt = now();
    await this.database.put(proofKey(token), {
      binding: this.binding(claims),
      generation: account.generation,
      verifiedAt,
      expiresAt: verifiedAt + PROOF_TTL_SECONDS,
    });
    reply.setCookie(GOOGLE_MFA_COOKIE, token, {
      ...GOOGLE_MFA_COOKIE_OPTIONS,
      maxAge: PROOF_TTL_SECONDS,
    });
    return { ok: true };
  }

  async revokeProof(request: FastifyRequest): Promise<void> {
    if (!this.enabled) return;
    const token = this.readProofToken(request);
    if (token) await this.database.delete(token.key);
    if (token && !token.legacy) {
      const legacy = this.readLegacyProofToken(request);
      if (legacy) await this.database.delete(legacy.key);
    }
  }

  async deleteCredential(subject: string): Promise<void> {
    if (!this.enabled) return;
    // Replace the key with a short-lived tombstone so an in-flight
    // registration cannot re-create the credential after account deletion.
    await this.database.tombstoneAccount(
      subject,
      now() + CHALLENGE_TTL_SECONDS,
    );
  }

  private get database(): GoogleMfaStore {
    if (!this.store) throw new Error('WebAuthn storage is unavailable');
    return this.store;
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
    return `challenge:v2:${ceremony}:${this.binding(claims)}`;
  }

  private async consumeChallenge(
    claims: CognitoVerifiedClaims,
    ceremony: Ceremony,
    account: CredentialAccount | undefined,
  ): Promise<PendingWebAuthnChallenge> {
    const pending = await this.database.consumeChallenge(
      this.challengeKey(claims, ceremony),
      now(),
    );
    if (pending?.generation === (account?.generation ?? 'unenrolled'))
      return pending;
    throw new BadRequestException('Request new WebAuthn options and try again');
  }

  private async saveChallenge(
    claims: CognitoVerifiedClaims,
    ceremony: Ceremony,
    challenge: string,
    account: CredentialAccount | undefined,
  ): Promise<void> {
    await this.database.put(this.challengeKey(claims, ceremony), {
      challenge,
      expiresAt: now() + CHALLENGE_TTL_SECONDS,
      generation: account?.generation ?? 'unenrolled',
      ...(ceremony === 'recovery'
        ? { recoveryCodeHash: account?.recoveryCodeHash }
        : {}),
    });
  }

  private assertChallengeActive(expiresAt: number): void {
    if (expiresAt <= now()) {
      throw new BadRequestException(
        'Request new WebAuthn options and try again',
      );
    }
  }

  private async writeAccount(
    claims: CognitoVerifiedClaims,
    previous: CredentialAccount | undefined,
    next: Omit<CredentialAccount, 'revision'>,
  ): Promise<void> {
    if (!(await this.database.writeAccount(claims.sub, previous, next))) {
      throw new ConflictException('Request new WebAuthn options and try again');
    }
  }

  private async authorizeRegistration(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
    account: CredentialAccount | undefined,
  ): Promise<void> {
    if (!account) {
      this.assertFreshEnrollment(claims);
      return;
    }
    await this.assertRecentProof(claims, request, account);
    if (account.credentials.length >= 2) {
      throw new ConflictException(
        'Two WebAuthn credentials are already registered',
      );
    }
  }

  private async registrationOptions(
    claims: CognitoVerifiedClaims,
    ceremony: 'registration' | 'recovery',
    account: CredentialAccount | undefined,
  ) {
    const userHandle = createHash('sha256').update(claims.sub).digest();
    const options = await generateRegistrationOptions({
      rpName: 'DespensaLista Dev',
      rpID: this.rpID,
      userID: userHandle,
      userName: `DespensaLista Dev (${userHandle.toString('hex').slice(0, 8)})`,
      attestationType: 'none',
      timeout: CHALLENGE_TTL_SECONDS * 1000,
      excludeCredentials: account?.credentials.map(({ credentialId }) => ({
        id: credentialId,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    await this.saveChallenge(claims, ceremony, options.challenge, account);
    return options;
  }

  private async verifyRegistration(
    pending: PendingWebAuthnChallenge,
    response: RegistrationResponseJSON,
  ) {
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
    if (!verification.verified)
      throw new BadRequestException('Invalid WebAuthn response');
    return fromWebAuthnCredential(verification.registrationInfo.credential);
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

  private async assertRecentProof(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
    account: CredentialAccount,
  ): Promise<void> {
    if (!this.isRecent(await this.getProof(claims, request, account))) {
      throw new GoogleMfaRequiredException();
    }
  }

  private isRecent(proof: { verifiedAt?: number } | undefined): boolean {
    const age = now() - (proof?.verifiedAt ?? 0);
    return age >= 0 && age <= RECENT_PROOF_SECONDS;
  }

  private async getProof(
    claims: CognitoVerifiedClaims,
    request: FastifyRequest,
    account: CredentialAccount | undefined,
  ): Promise<{ verifiedAt?: number } | undefined> {
    if (!account) return undefined;
    const token = this.readProofToken(request);
    if (!token || (token.legacy && account.revision)) return undefined;
    const item = await this.database.get(token.key);
    if (
      item?.binding !== this.binding(claims) ||
      typeof item.expiresAt !== 'number' ||
      item.expiresAt <= now()
    ) {
      return undefined;
    }
    if (token.legacy) return {};
    if (
      item.generation !== account.generation ||
      typeof item.verifiedAt !== 'number'
    ) {
      return undefined;
    }
    return { verifiedAt: item.verifiedAt };
  }

  private readProofToken(request: FastifyRequest) {
    const token = request.cookies?.[GOOGLE_MFA_COOKIE];
    return token && PROOF_TOKEN.test(token)
      ? { key: proofKey(token), legacy: false }
      : this.readLegacyProofToken(request);
  }

  private readLegacyProofToken(request: FastifyRequest) {
    const token = request.cookies?.[LEGACY_GOOGLE_MFA_COOKIE];
    return token && PROOF_TOKEN.test(token)
      ? { key: `proof:${digest(token)}`, legacy: true }
      : undefined;
  }
}

function proofKey(token: string): string {
  return `proof:v2:${digest(token)}`;
}

function matchesDigest(stored: string, candidate: string): boolean {
  const expected = Buffer.from(stored, 'base64url');
  const actual = Buffer.from(candidate, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
