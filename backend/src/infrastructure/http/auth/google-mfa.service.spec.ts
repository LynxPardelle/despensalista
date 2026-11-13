import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DynamoDbDocumentClientService } from '../../database/dynamodb/dynamodb-document-client.service';
import {
  GOOGLE_MFA_COOKIE,
  LEGACY_GOOGLE_MFA_COOKIE,
  GoogleMfaRequiredException,
} from './google-mfa.constants';
import { GoogleMfaService } from './google-mfa.service';
import { digest } from './google-mfa-store';

jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual<typeof import('@simplewebauthn/server')>(
    '@simplewebauthn/server',
  ),
  verifyAuthenticationResponse: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
}));

const origin = 'https://dev.despensalista.lynxpardelle.com';
const devConfiguration = {
  NODE_ENV: 'production',
  COGNITO_ENABLED: 'true',
  COGNITO_ISSUER:
    'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_7MDhLOulC',
  COGNITO_REDIRECT_URI: `${origin}/api/auth/cognito/callback`,
  COGNITO_ALLOWED_PROVIDERS: 'COGNITO,Google',
  GOOGLE_MFA_TABLE: 'despensalista-dev-google-mfa',
  GOOGLE_MFA_ORIGIN: origin,
};
const subject = 'cc9b52f2-f72e-4ce4-bd3e-b1dbd3f56641';
const claims = {
  sub: subject,
  cognitoUsername: 'Google_123456789',
  originJti: 'session-a',
  authTime: Math.floor(Date.now() / 1000),
};
const credential = {
  id: 'cred-123',
  publicKey: Uint8Array.from([1, 2, 3]),
  counter: 1,
};
const registration = {} as RegistrationResponseJSON;
const assertion = { id: credential.id } as AuthenticationResponseJSON;
const secondKey = { credentialId: 'cred-456', publicKey: 'AQID', counter: 0 };
const proofToken = 'a'.repeat(43);
const recoveryCode = 'A'.repeat(32);

function request(token?: string, requestOrigin = origin): FastifyRequest {
  return {
    headers: { origin: requestOrigin },
    cookies: token ? { [GOOGLE_MFA_COOKIE]: token } : {},
  } as FastifyRequest;
}

function setup() {
  const send = jest.fn();
  const db = { send } as unknown as DynamoDbDocumentClientService;
  const service = new GoogleMfaService(new ConfigService(devConfiguration), db);
  const setCookie = jest.fn();
  const reply = { setCookie } as unknown as FastifyReply;
  return { send, db, service, setCookie, reply };
}

function storedCredential() {
  return {
    Item: {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
    },
  };
}

function pendingChallenge(generation = 'legacy', recoveryCodeHash?: string) {
  return {
    Attributes: {
      challenge: 'example-challenge',
      expiresAt: Math.floor(Date.now() / 1000) + 299,
      generation,
      recoveryCodeHash,
    },
  };
}

function currentAccount(keyCount = 1, recoveryCodeHash?: string) {
  return {
    Item: {
      revision: 'revision-a',
      generation: 'generation-a',
      credentials:
        keyCount === 1
          ? [storedCredential().Item]
          : [storedCredential().Item, secondKey],
      recoveryCodeHash,
    },
  };
}

function storedProof(age = 0, generation = 'generation-a') {
  const verifiedAt = Math.floor(Date.now() / 1000) - age;
  return {
    Item: {
      binding: digest(`${claims.sub}\0${claims.originJti}`),
      generation,
      verifiedAt,
      expiresAt: verifiedAt + 3600,
    },
  };
}

describe('GoogleMfaService', () => {
  beforeEach(() => jest.resetAllMocks());

  it('leaves a deployment without the pilot configuration disabled', async () => {
    const service = new GoogleMfaService(new ConfigService({}));
    await expect(
      service.assertVerified(claims, request()),
    ).resolves.toBeUndefined();
    await expect(service.status(claims, request())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('requires the dev origin and Cognito pool, a host-only cookie and the dev table', () => {
    const { db } = setup();
    for (const override of [
      { GOOGLE_MFA_TABLE: '' },
      { GOOGLE_MFA_ORIGIN: 'https://despensalista.lynxpardelle.com' },
      { COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/other' },
      { AUTH_COOKIE_DOMAIN: 'despensalista.lynxpardelle.com' },
      { AUTH_COOKIE_SECURE: 'false' },
      { GOOGLE_MFA_PROOF_VERSION: '1' },
    ]) {
      expect(
        () =>
          new GoogleMfaService(
            new ConfigService({ ...devConfiguration, ...override }),
            db,
          ),
      ).toThrow('Invalid DespensaLista dev Google WebAuthn configuration');
    }
  });

  it('accepts native sessions and fails closed for unknown providers or missing Google session binding', async () => {
    const { service, send } = setup();
    await expect(
      service.assertVerified(
        { sub: subject, cognitoUsername: subject },
        request(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      service.assertVerified(
        { sub: subject, cognitoUsername: 'Facebook_unknown' },
        request(),
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.assertVerified({ ...claims, originJti: undefined }, request()),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.assertVerified(claims, request()),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports the legacy key as eligible for upgrading after verification', async () => {
    const { service, send } = setup();
    send.mockResolvedValueOnce(storedCredential());
    await expect(service.status(claims, request())).resolves.toEqual({
      registered: true,
      verified: false,
      keyCount: 1,
      recoveryConfigured: false,
      recentVerification: false,
    });
  });

  it('requires a recent WebAuthn proof for registering a second key', async () => {
    const { service, send } = setup();
    send.mockResolvedValueOnce(storedCredential());
    await expect(
      service.options('registration', claims, request()),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);
  });

  it('issues origin-bound registration options for a fresh Google sign-in', async () => {
    const { service, send } = setup();
    send.mockResolvedValue({});
    await expect(
      service.options(
        'registration',
        claims,
        request(undefined, 'https://other.example'),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.options('registration', { ...claims, authTime: 1 }, request()),
    ).rejects.toMatchObject({ status: 401 });
    const options = await service.options('registration', claims, request());
    expect(options).toMatchObject({
      rp: { id: 'dev.despensalista.lynxpardelle.com' },
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      timeout: 300_000,
      user: {
        name: expect.stringMatching(/^DespensaLista Dev \([a-f0-9]{8}\)$/),
      },
    });
    expect(send).toHaveBeenLastCalledWith(expect.any(PutCommand));
    expect(send.mock.lastCall?.[0]).toMatchObject({
      input: {
        Item: {
          pk: expect.stringMatching(/^challenge:v2:registration:/),
          challenge: options.challenge,
          expiresAt: expect.any(Number),
        },
      },
    });
  });

  it('enrolls only the first credential, without granting a proof', async () => {
    const { service, send } = setup();
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(pendingChallenge('unenrolled'));
    jest.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: { credential },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);

    await expect(
      service.register(claims, request(), registration),
    ).resolves.toEqual({ ok: true });
    expect(verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'example-challenge',
        expectedOrigin: origin,
        expectedRPID: 'dev.despensalista.lynxpardelle.com',
        requireUserVerification: true,
      }),
    );
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall?.[0]).toMatchObject({
      input: {
        ConditionExpression: 'attribute_not_exists(pk)',
        Item: {
          pk: expect.stringMatching(/^credential:/),
          credentials: [storedCredential().Item],
          generation: expect.any(String),
          revision: expect.any(String),
        },
      },
    });
    send.mockResolvedValueOnce(storedCredential());
    await expect(
      service.register(claims, request(), registration),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);
    expect(verifyRegistrationResponse).toHaveBeenCalledTimes(1);
  });

  it('atomically consumes an unexpired challenge before verifying, even if verification fails', async () => {
    const { service, send, reply, setCookie } = setup();
    const used = new Error('used');
    used.name = 'ConditionalCheckFailedException';
    send
      .mockResolvedValueOnce(storedCredential())
      .mockResolvedValueOnce(pendingChallenge())
      .mockResolvedValueOnce(storedCredential())
      .mockRejectedValueOnce(used);
    jest.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: false,
    } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);

    await expect(
      service.authenticate(claims, request(), reply, assertion),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.authenticate(claims, request(), reply, assertion),
    ).rejects.toMatchObject({ status: 400 });
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteCommand);
    expect(send.mock.calls[1][0]).toMatchObject({
      input: {
        ConditionExpression: 'expiresAt > :now',
        ReturnValues: 'ALL_OLD',
      },
    });
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('binds a secure proof to the Cognito refresh family and revokes it by cookie on logout', async () => {
    const { service, send, reply, setCookie } = setup();
    send
      .mockResolvedValueOnce(storedCredential())
      .mockResolvedValueOnce(pendingChallenge())
      .mockResolvedValue({});
    jest.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);

    await expect(
      service.authenticate(claims, request(), reply, assertion),
    ).resolves.toEqual({ ok: true });
    expect(send.mock.calls[2][0]).toBeInstanceOf(PutCommand);
    expect(send.mock.calls[2][0]).toMatchObject({
      input: {
        ConditionExpression:
          'attribute_not_exists(revision) AND credentialId = :id AND #counter = :counter',
      },
    });
    expect(setCookie).toHaveBeenCalledWith(
      GOOGLE_MFA_COOKIE,
      expect.any(String),
      {
        httpOnly: true,
        secure: true,
        path: '/',
        sameSite: 'strict',
        maxAge: 3600,
      },
    );
    const token = setCookie.mock.calls[0][1] as string;
    const account = (send.mock.calls[2][0] as PutCommand).input.Item;
    const proof = (send.mock.calls[3][0] as PutCommand).input.Item;
    expect(proof?.pk).not.toContain(token);
    expect(proof?.binding).not.toContain(subject);
    send.mockImplementation((command: GetCommand) =>
      Promise.resolve({
        Item: command.input.Key?.pk === proof?.pk ? proof : account,
      }),
    );

    await expect(
      service.assertVerified({ ...claims, authTime: 0 }, request(token)),
    ).resolves.toBeUndefined();
    await expect(
      service.assertVerified(
        { ...claims, originJti: 'session-b' },
        request(token),
      ),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);
    await expect(
      service.assertVerified(
        { ...claims, sub: 'different-subject' },
        request(token),
      ),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);
    expect(send).toHaveBeenLastCalledWith(expect.any(GetCommand));
    send.mockResolvedValueOnce({ Item: account });
    send.mockResolvedValueOnce({ Item: { ...proof, expiresAt: 0 } });
    await expect(
      service.assertVerified(claims, request(token)),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);
    await service.revokeProof(request(token));
    expect(send).toHaveBeenLastCalledWith(expect.any(DeleteCommand));
    expect(send.mock.lastCall?.[0]).toMatchObject({
      input: { Key: { pk: proof?.pk } },
    });
  });

  it('offers either registered key and requires recent verification before adding a distinct second one', async () => {
    const { service, send } = setup();
    send
      .mockResolvedValueOnce(currentAccount())
      .mockResolvedValueOnce(storedProof(301));
    await expect(
      service.options('registration', claims, request(proofToken)),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);

    send
      .mockResolvedValueOnce(currentAccount())
      .mockResolvedValueOnce(storedProof());
    await expect(
      service.options('registration', claims, request(proofToken)),
    ).resolves.toMatchObject({ excludeCredentials: [{ id: credential.id }] });
    send
      .mockResolvedValueOnce(currentAccount(2))
      .mockResolvedValueOnce(storedProof());
    await expect(
      service.options('registration', claims, request(proofToken)),
    ).rejects.toMatchObject({ status: 409 });

    send.mockResolvedValueOnce(currentAccount(2));
    await expect(
      service.options('authentication', claims, request()),
    ).resolves.toMatchObject({
      allowCredentials: [{ id: credential.id }, { id: secondKey.credentialId }],
    });

    const secondCredential = {
      ...credential,
      id: secondKey.credentialId,
      counter: 0,
    };
    jest.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: { credential: secondCredential },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
    send
      .mockResolvedValueOnce(currentAccount())
      .mockResolvedValueOnce(storedProof())
      .mockResolvedValueOnce(pendingChallenge('generation-a'))
      .mockResolvedValueOnce(storedProof());
    await expect(
      service.register(claims, request(proofToken), registration),
    ).resolves.toEqual({ ok: true });
    expect(send.mock.lastCall?.[0]).toMatchObject({
      input: {
        ConditionExpression: 'revision = :revision',
        Item: {
          credentials: [storedCredential().Item, secondKey],
          generation: 'generation-a',
        },
      },
    });
  });

  it('generates a high-entropy recovery code only after WebAuthn and stores only its digest', async () => {
    const { service, send } = setup();
    send
      .mockResolvedValueOnce(currentAccount())
      .mockResolvedValueOnce(storedProof(301));
    await expect(
      service.issueRecoveryCode(claims, request(proofToken)),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);
    send
      .mockResolvedValueOnce(currentAccount())
      .mockResolvedValueOnce(storedProof());
    const { code } = await service.issueRecoveryCode(
      claims,
      request(proofToken),
    );
    expect(Buffer.from(code, 'base64url')).toHaveLength(24);
    const input = (send.mock.lastCall?.[0] as PutCommand).input;
    expect(input.Item?.recoveryCodeHash).toBe(digest(code));
    expect(JSON.stringify(input)).not.toContain(code);
    expect(input.Item).not.toHaveProperty('credentialId');
  });

  it('counts recovery attempts per subject across sessions before comparing the code', async () => {
    const { service, send } = setup();
    const exhausted = new Error('attempt limit');
    exhausted.name = 'ConditionalCheckFailedException';
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(currentAccount(1, digest(recoveryCode)));
    await expect(
      service.recoveryOptions(claims, request(), 'bad-code'),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Invalid recovery code',
    });
    send.mockRejectedValueOnce(exhausted);
    await expect(
      service.recoveryOptions(
        { ...claims, originJti: 'session-b' },
        request(),
        recoveryCode,
      ),
    ).rejects.toMatchObject({ status: 429 });
    const first = send.mock.calls[0][0] as UpdateCommand;
    const last = send.mock.lastCall?.[0] as UpdateCommand;
    expect(first.input.Key).toEqual(last.input.Key);
    expect(first.input).toMatchObject({
      ConditionExpression: 'attribute_not_exists(attempts) OR attempts < :max',
      ExpressionAttributeValues: { ':max': 5 },
    });
    await expect(
      service.recoveryOptions(
        { ...claims, authTime: 1 },
        request(),
        recoveryCode,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('requires the same code generation to consume the code and replace all keys in one conditional write', async () => {
    const { service, send, setCookie } = setup();
    const clearCookie = jest.fn();
    const reply = { clearCookie } as unknown as FastifyReply;
    const hash = digest(recoveryCode);
    const account = currentAccount(2, hash);
    const replacement = { ...credential, id: 'new-key', counter: 0 };
    jest.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: { credential: replacement },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
    send.mockResolvedValueOnce({}).mockResolvedValueOnce(account);
    await expect(
      service.recoveryOptions(claims, request(), recoveryCode),
    ).resolves.toMatchObject({
      excludeCredentials: [
        { id: credential.id },
        { id: secondKey.credentialId },
      ],
    });
    expect(send.mock.lastCall?.[0]).toMatchObject({
      input: { Item: { recoveryCodeHash: hash, generation: 'generation-a' } },
    });
    send
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce(pendingChallenge('generation-a', 'rotated'));
    await expect(
      service.recover(claims, request(), reply, registration),
    ).rejects.toMatchObject({ status: 400 });
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();

    send
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce(pendingChallenge('generation-a', hash));
    await expect(
      service.recover(claims, request(), reply, registration),
    ).resolves.toEqual({ ok: true });
    const write = (send.mock.lastCall?.[0] as PutCommand).input;
    expect(write.ConditionExpression).toBe('revision = :revision');
    expect(write.ExpressionAttributeValues).toEqual({
      ':revision': 'revision-a',
    });
    expect(write.Item?.generation).not.toBe('generation-a');
    expect(write.Item?.credentials).toEqual([
      { credentialId: 'new-key', publicKey: 'AQID', counter: 0 },
    ]);
    expect(write.Item).not.toHaveProperty('recoveryCodeHash');
    expect(clearCookie).toHaveBeenCalledTimes(2);
    expect(setCookie).not.toHaveBeenCalled();

    send
      .mockResolvedValueOnce({ Item: write.Item })
      .mockResolvedValueOnce(storedProof());
    await expect(
      service.assertVerified(claims, request(proofToken)),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);
    send
      .mockResolvedValueOnce({ Item: write.Item })
      .mockResolvedValueOnce(pendingChallenge('generation-a', hash));
    await expect(
      service.recover(claims, request(), reply, registration),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('accepts legacy proofs only while the legacy account has not been upgraded and never as recent', async () => {
    const { service, send } = setup();
    const legacyRequest = {
      ...request(),
      cookies: { [LEGACY_GOOGLE_MFA_COOKIE]: proofToken },
    } as FastifyRequest;
    send
      .mockResolvedValueOnce(storedCredential())
      .mockResolvedValueOnce(storedProof());
    await expect(service.status(claims, legacyRequest)).resolves.toMatchObject({
      verified: true,
      recentVerification: false,
    });
    send.mockResolvedValueOnce(currentAccount());
    await expect(
      service.assertVerified(claims, legacyRequest),
    ).rejects.toBeInstanceOf(GoogleMfaRequiredException);
  });

  it('erases credential material and fences concurrent registration on account deletion', async () => {
    const { service, send } = setup();
    send.mockResolvedValue({});
    await service.deleteCredential(claims.sub);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.lastCall?.[0]).toBeInstanceOf(PutCommand);
    const { Item } = (send.mock.lastCall?.[0] as PutCommand).input;
    expect(Item).toEqual({
      pk: expect.stringMatching(/^credential:[a-zA-Z0-9_-]+$/),
      expiresAt: expect.any(Number),
    });
    expect(Item?.pk).not.toContain(claims.sub);
  });
});
