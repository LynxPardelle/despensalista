import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { UserDao } from '../ports/daos';
import { CognitoVerifiedClaims } from '../ports/cognito-auth.port';
import { USER_DAO } from '../tokens';
import { User } from '../../domain/entities/user.entity';
import { UserAccountStatus } from '../../domain/enums';
import { UserId } from '../../domain/value-objects/user-id.vo';

@Injectable()
export class CognitoProfileSyncService {
  constructor(
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
  ) {}

  async syncFromClaims(claims: CognitoVerifiedClaims): Promise<User> {
    const email = claims.email?.trim().toLocaleLowerCase('en-US');
    const authSubjectId = claims.sub.trim();
    const cognitoUsername = claims.cognitoUsername?.trim();

    if (!email) {
      throw new UnauthorizedException('Cognito email claim is required');
    }

    if (!authSubjectId) {
      throw new UnauthorizedException('Cognito subject claim is required');
    }

    if (!cognitoUsername) {
      throw new UnauthorizedException('Cognito username claim is required');
    }

    const existingUserBySubject =
      (await this.userDao.findByAuthSubject(authSubjectId)) ??
      (await this.userDao.findById(UserId.fromString(authSubjectId)));
    const existingUserByEmail = await this.userDao.findByEmail(email);
    const existingUser = this.resolveExistingUser(
      existingUserBySubject,
      existingUserByEmail,
      claims,
    );
    const username = await this.resolveUsername(claims, existingUser);
    const user =
      existingUser ??
      User.fromPrimitives({
        id: authSubjectId,
        email,
        username,
        authSubjectIds: [],
        status: UserAccountStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    if (existingUser) {
      if (existingUser.email !== email) {
        existingUser.updateEmail(email);
      }

      if (existingUser.username !== username) {
        existingUser.updateUsername(username);
      }
    }

    user.linkAuthSubject(authSubjectId, cognitoUsername);

    return this.userDao.save(user);
  }

  private resolveExistingUser(
    existingUserBySubject: User | null,
    existingUserByEmail: User | null,
    claims: CognitoVerifiedClaims,
  ): User | null {
    if (
      existingUserBySubject &&
      existingUserByEmail &&
      !existingUserBySubject.id.equals(existingUserByEmail.id)
    ) {
      throw new UnauthorizedException(
        'Cognito email belongs to a different Despensa Lista account',
      );
    }

    if (existingUserByEmail && !existingUserBySubject) {
      this.ensureVerifiedEmailForLinking(claims);
    }

    return existingUserBySubject ?? existingUserByEmail;
  }

  private ensureVerifiedEmailForLinking(claims: CognitoVerifiedClaims): void {
    if (claims.emailVerified !== true) {
      throw new UnauthorizedException(
        'Verified Cognito email is required to link Despensa Lista account',
      );
    }
  }

  private async resolveUsername(
    claims: CognitoVerifiedClaims,
    existingUser: User | null,
  ): Promise<string> {
    const baseUsername = this.deriveUsername(claims);
    const usernameOwner = await this.userDao.findByUsername(baseUsername);

    if (
      !usernameOwner ||
      (existingUser && usernameOwner.id.equals(existingUser.id))
    ) {
      return baseUsername;
    }

    return `${baseUsername}-${claims.sub.slice(0, 8)}`;
  }

  private deriveUsername(claims: CognitoVerifiedClaims): string {
    return (
      claims.preferredUsername?.trim() ||
      claims.name?.trim() ||
      claims.email?.split('@')[0]?.trim() ||
      claims.sub
    );
  }
}
