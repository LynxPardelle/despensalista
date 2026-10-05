import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminUserGlobalSignOutCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
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

  async deleteUsersBySubjectIds(
    subjectIds: string[],
    authUsernamesBySubject: Readonly<Record<string, string>> = {},
  ): Promise<number> {
    if (this.configService.get<string>('COGNITO_ENABLED') !== 'true') {
      return 0;
    }

    const userPoolId = this.getUserPoolId();
    const knownUsernames = this.normalizeUsernames(authUsernamesBySubject);
    let deletedCount = 0;

    for (const subjectId of this.normalizeSubjectIds(subjectIds)) {
      const username =
        knownUsernames[subjectId] ??
        (await this.findUsernameBySubjectId(userPoolId, subjectId));

      if (!username) {
        continue;
      }

      try {
        await this.client.send(
          new AdminDeleteUserCommand({
            UserPoolId: userPoolId,
            Username: username,
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

  async signOutUsersBySubjectIds(
    subjectIds: string[],
    authUsernamesBySubject: Readonly<Record<string, string>> = {},
  ): Promise<number> {
    if (this.configService.get<string>('COGNITO_ENABLED') !== 'true') {
      return 0;
    }

    const userPoolId = this.getUserPoolId();
    const knownUsernames = this.normalizeUsernames(authUsernamesBySubject);
    let signedOutCount = 0;

    for (const subjectId of this.normalizeSubjectIds(subjectIds)) {
      const username =
        knownUsernames[subjectId] ??
        (await this.findUsernameBySubjectId(userPoolId, subjectId));

      if (!username) {
        continue;
      }

      try {
        await this.client.send(
          new AdminUserGlobalSignOutCommand({
            UserPoolId: userPoolId,
            Username: username,
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

  private async findUsernameBySubjectId(
    userPoolId: string,
    subjectId: string,
  ): Promise<string | undefined> {
    const result = await this.client.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `sub = "${escapeCognitoFilterValue(subjectId)}"`,
        Limit: 1,
      }),
    );

    return result.Users?.[0]?.Username;
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

  private normalizeUsernames(
    authUsernamesBySubject: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const normalized: [string, string][] = [];
    for (const [subjectId, username] of Object.entries(
      authUsernamesBySubject,
    )) {
      const normalizedSubjectId = subjectId.trim();
      const normalizedUsername = username.trim();
      if (normalizedSubjectId && normalizedUsername) {
        normalized.push([normalizedSubjectId, normalizedUsername]);
      }
    }
    return Object.fromEntries(normalized);
  }
}

function escapeCognitoFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
