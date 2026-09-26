import {
  AdminDeleteUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { ConfigService } from '@nestjs/config';
import { CognitoUserAdminService } from './cognito-user-admin.service';

describe('CognitoUserAdminService account deletion retries', () => {
  afterEach(() => jest.restoreAllMocks());

  it('continues when a prior attempt already deleted one identity', async () => {
    const send = jest
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockImplementation((command) => {
        if (
          command instanceof AdminDeleteUserCommand &&
          command.input.Username === 'subject-1'
        ) {
          return Promise.reject(
            Object.assign(new Error('already gone'), {
              name: 'UserNotFoundException',
            }),
          ) as never;
        }
        return Promise.resolve({}) as never;
      });
    const service = new CognitoUserAdminService(
      new ConfigService({
        COGNITO_ENABLED: 'true',
        COGNITO_USER_POOL_ID: 'pool',
        COGNITO_REGION: 'us-east-1',
      }),
    );

    await expect(
      service.deleteUsersBySubjectIds(['subject-1', 'subject-2']),
    ).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.map(
        ([command]) => (command as AdminDeleteUserCommand).input.Username,
      ),
    ).toEqual(['subject-1', 'subject-2']);
  });

  it('signs out the subject directly and treats a missing identity as complete', async () => {
    const send = jest
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockRejectedValue(
        Object.assign(new Error('already gone'), {
          name: 'UserNotFoundException',
        }) as never,
      );
    const service = new CognitoUserAdminService(
      new ConfigService({
        COGNITO_ENABLED: 'true',
        COGNITO_USER_POOL_ID: 'pool',
        COGNITO_REGION: 'us-east-1',
      }),
    );

    await expect(
      service.signOutUsersBySubjectIds(['google-subject']),
    ).resolves.toBe(0);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(
      AdminUserGlobalSignOutCommand,
    );
    expect(
      (send.mock.calls[0]?.[0] as AdminUserGlobalSignOutCommand).input.Username,
    ).toBe('google-subject');
  });
});
