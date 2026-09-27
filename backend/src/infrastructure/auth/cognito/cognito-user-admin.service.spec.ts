import {
  AdminDeleteUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ConfigService } from '@nestjs/config';
import { CognitoUserAdminService } from './cognito-user-admin.service';

function createService(): CognitoUserAdminService {
  return new CognitoUserAdminService(
    new ConfigService({
      COGNITO_ENABLED: 'true',
      COGNITO_USER_POOL_ID: 'pool',
      COGNITO_REGION: 'us-east-1',
    }),
  );
}

describe('CognitoUserAdminService account administration', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves each deduplicated subject to its Cognito username before deletion', async () => {
    const send = jest
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockImplementation((command) => {
        if (command instanceof ListUsersCommand) {
          return Promise.resolve(
            command.input.Filter === 'sub = "subject-1"'
              ? { Users: [{ Username: 'Google_federated-1' }] }
              : { Users: [] },
          ) as never;
        }
        return Promise.resolve({}) as never;
      });
    const service = createService();

    await expect(
      service.deleteUsersBySubjectIds([
        ' subject-1 ',
        'subject-1',
        'subject-2',
        ' ',
      ]),
    ).resolves.toBe(1);
    const lookups = send.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is ListUsersCommand =>
          command instanceof ListUsersCommand,
      );
    expect(lookups.map(({ input }) => input)).toEqual([
      {
        UserPoolId: 'pool',
        Filter: 'sub = "subject-1"',
        Limit: 1,
      },
      {
        UserPoolId: 'pool',
        Filter: 'sub = "subject-2"',
        Limit: 1,
      },
    ]);
    const deletes = send.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is AdminDeleteUserCommand =>
          command instanceof AdminDeleteUserCommand,
      );
    expect(deletes.map(({ input }) => input.Username)).toEqual([
      'Google_federated-1',
    ]);
  });

  it('deletes a known federated username without a subject lookup', async () => {
    const send = jest
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockResolvedValue({} as never);
    const service = createService();

    await expect(
      service.deleteUsersBySubjectIds(['federated-subject'], {
        'federated-subject': 'Google_authoritative-user',
      }),
    ).resolves.toBe(1);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(AdminDeleteUserCommand);
    expect(
      (send.mock.calls[0]?.[0] as AdminDeleteUserCommand).input.Username,
    ).toBe('Google_authoritative-user');
  });

  it('escapes Cognito filter metacharacters in a subject', async () => {
    const send = jest
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockResolvedValue({ Users: [] } as never);
    const service = createService();

    await service.deleteUsersBySubjectIds(['subject\\with"quote']);

    const lookup = send.mock.calls[0]?.[0];
    expect(lookup).toBeInstanceOf(ListUsersCommand);
    expect((lookup as ListUsersCommand).input.Filter).toBe(
      'sub = "subject\\\\with\\"quote"',
    );
  });

  it('treats a known user removed by a previous attempt as idempotent', async () => {
    const send = jest
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockRejectedValue(
        Object.assign(new Error('already gone'), {
          name: 'UserNotFoundException',
        }) as never,
      );
    const service = createService();

    await expect(
      service.deleteUsersBySubjectIds(['deleted-subject'], {
        'deleted-subject': 'Google_already-gone',
      }),
    ).resolves.toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(AdminDeleteUserCommand);
  });

  it('uses a known federated Cognito username for global sign-out', async () => {
    const send = jest
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockResolvedValue({} as never);
    const service = createService();

    await expect(
      service.signOutUsersBySubjectIds(['federated-subject'], {
        'federated-subject': 'Google_federated-session',
      }),
    ).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(
      AdminUserGlobalSignOutCommand,
    );
    expect(
      (send.mock.calls[0]?.[0] as AdminUserGlobalSignOutCommand).input.Username,
    ).toBe('Google_federated-session');
  });

  it('propagates lookup failures without issuing an admin mutation', async () => {
    const lookupFailure = Object.assign(new Error('throttled'), {
      name: 'TooManyRequestsException',
    });
    const send = jest
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockRejectedValue(lookupFailure as never);
    const service = createService();

    await expect(service.signOutUsersBySubjectIds(['subject'])).rejects.toBe(
      lookupFailure,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListUsersCommand);
  });
});
