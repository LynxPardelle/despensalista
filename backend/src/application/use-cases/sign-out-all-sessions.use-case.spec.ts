import { BadRequestException } from '@nestjs/common';
import { CognitoUserAdmin } from '../ports/cognito-auth.port';
import { UserDao } from '../ports/daos';
import { User } from '../../domain/entities/user.entity';
import { UserAccountStatus } from '../../domain/enums';
import { SignOutAllSessionsUseCase } from './sign-out-all-sessions.use-case';

describe('SignOutAllSessionsUseCase', () => {
  it('requires explicit confirmation', async () => {
    const { useCase, userDao } = makeUseCase();

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'CERRAR',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userDao.findById).not.toHaveBeenCalled();
  });

  it('globally signs out linked Cognito identities', async () => {
    const { useCase, cognitoUserAdmin } = makeUseCase();

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'CERRAR SESIONES',
      }),
    ).resolves.toEqual({ revokedCognitoSessionCount: 2 });
    expect(cognitoUserAdmin.signOutUsersBySubjectIds).toHaveBeenCalledWith(
      ['auth-subject-1', 'auth-subject-2'],
      {
        'auth-subject-1': 'native-user',
        'auth-subject-2': 'Google_federated-user',
      },
    );
  });
});

function makeUseCase() {
  const userDao = {
    findById: jest.fn().mockResolvedValue(
      User.fromPrimitives({
        id: 'user-1',
        email: 'chef@example.com',
        username: 'chef',
        authSubjectIds: ['auth-subject-1', 'auth-subject-2'],
        authUsernamesBySubject: {
          'auth-subject-1': 'native-user',
          'auth-subject-2': 'Google_federated-user',
        },
        status: UserAccountStatus.ACTIVE,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ),
  } as unknown as jest.Mocked<UserDao>;
  const cognitoUserAdmin = {
    deleteUsersBySubjectIds: jest.fn(),
    signOutUsersBySubjectIds: jest.fn().mockResolvedValue(2),
  } as unknown as jest.Mocked<CognitoUserAdmin>;

  return {
    useCase: new SignOutAllSessionsUseCase(userDao, cognitoUserAdmin),
    userDao,
    cognitoUserAdmin,
  };
}
