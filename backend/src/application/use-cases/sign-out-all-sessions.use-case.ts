import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CognitoUserAdmin } from '../ports/cognito-auth.port';
import { UserDao } from '../ports/daos';
import { COGNITO_USER_ADMIN, USER_DAO } from '../tokens';
import { UserId } from '../../domain/value-objects/user-id.vo';

const SIGN_OUT_ALL_SESSIONS_CONFIRMATION = 'CERRAR SESIONES';

export interface SignOutAllSessionsResult {
  revokedCognitoSessionCount: number;
}

@Injectable()
export class SignOutAllSessionsUseCase {
  constructor(
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
    @Inject(COGNITO_USER_ADMIN)
    private readonly cognitoUserAdmin: CognitoUserAdmin,
  ) {}

  async execute(command: {
    userId: string;
    confirmationText: string;
  }): Promise<SignOutAllSessionsResult> {
    if (
      command.confirmationText.trim() !== SIGN_OUT_ALL_SESSIONS_CONFIRMATION
    ) {
      throw new BadRequestException(
        `Confirmation text must be ${SIGN_OUT_ALL_SESSIONS_CONFIRMATION}`,
      );
    }

    const user = await this.userDao.findById(UserId.fromString(command.userId));

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      revokedCognitoSessionCount:
        await this.cognitoUserAdmin.signOutUsersBySubjectIds(
          user.authSubjectIds,
          user.authUsernamesBySubject,
        ),
    };
  }
}
