import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminUserGlobalSignOutCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoUserAdmin } from '../../../application/ports/cognito-auth.port';

@Injectable()
export class CognitoUserAdminService implements CognitoUserAdmin {
  private readonly client: CognitoIdentityProviderClient;

  constructor(private readonly configService: ConfigService) {
    this.client = new CognitoIdentityProviderClient({
      region: this.getRegion(),
    });
  }

  async deleteUsersBySubjectIds(subjectIds: string[]): Promise<number> {
    if (this.configService.get<string>('COGNITO_ENABLED') !== 'true') {
      return 0;
    }

    const userPoolId = this.getUserPoolId();
    let deletedCount = 0;

    for (const subjectId of this.normalizeSubjectIds(subjectIds)) {
      try {
        await this.client.send(
          new AdminDeleteUserCommand({
            UserPoolId: userPoolId,
            Username: subjectId,
          }),
        );
      } catch (error) {
        if ((error as Error).name === 'UserNotFoundException') continue;
        throw error;
      }
      deletedCount += 1;
    }

    return deletedCount;
  }

  async signOutUsersBySubjectIds(subjectIds: string[]): Promise<number> {
    if (this.configService.get<string>('COGNITO_ENABLED') !== 'true') {
      return 0;
    }

    const userPoolId = this.getUserPoolId();
    let signedOutCount = 0;

    for (const subjectId of this.normalizeSubjectIds(subjectIds)) {
      try {
        await this.client.send(
          new AdminUserGlobalSignOutCommand({
            UserPoolId: userPoolId,
            Username: subjectId,
          }),
        );
      } catch (error) {
        if ((error as Error).name === 'UserNotFoundException') continue;
        throw error;
      }
      signedOutCount += 1;
    }

    return signedOutCount;
  }

  private getUserPoolId(): string {
    const explicitUserPoolId = this.configService
      .get<string>('COGNITO_USER_POOL_ID')
      ?.trim();

    if (explicitUserPoolId) {
      return explicitUserPoolId;
    }

    const issuer = this.configService.get<string>('COGNITO_ISSUER');
    const userPoolId = issuer
      ? new URL(issuer).pathname.split('/').filter(Boolean).at(-1)
      : undefined;

    if (!userPoolId) {
      throw new ServiceUnavailableException(
        'Cognito user pool id is required for account deletion',
      );
    }

    return userPoolId;
  }

  private getRegion(): string | undefined {
    const explicitRegion = this.configService.get<string>('COGNITO_REGION');

    if (explicitRegion) {
      return explicitRegion;
    }

    const issuer = this.configService.get<string>('COGNITO_ISSUER');
    const host = issuer ? new URL(issuer).hostname : '';
    const match = /^cognito-idp\.([a-z0-9-]+)\./i.exec(host);

    return match?.[1] ?? this.configService.get<string>('DYNAMODB_REGION');
  }

  private normalizeSubjectIds(subjectIds: string[]): string[] {
    return [...new Set(subjectIds.map((id) => id.trim()))].filter(Boolean);
  }
}
