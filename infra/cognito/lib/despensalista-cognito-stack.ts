import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import { createStageDeliveryControls } from './stage-delivery';
import { Construct } from 'constructs';

type ContextValue = string | undefined;

export class DespensaListaCognitoStack extends cdk.Stack {
  readonly allowedProviders: string[];
  readonly userPoolClientId: string;
  readonly userPoolDomainUrl: string;
  readonly userPoolId: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const projectName = this.readContext('projectName', 'despensalista');
    const stage = this.readContext('stage', 'dev');
    const localFrontendBaseUrl = this.readContext(
      'localFrontendBaseUrl',
      'http://localhost:48673',
    );
    const productionFrontendBaseUrl = this.readOptionalContext(
      'productionFrontendBaseUrl',
    );
    const domainPrefix =
      this.readOptionalContext('domainPrefix') ||
      `${projectName}-${stage}-${cdk.Aws.ACCOUNT_ID}`;

    const callbackUrls = this.buildCallbackUrls(
      stage,
      localFrontendBaseUrl,
      productionFrontendBaseUrl,
    );
    const logoutUrls = this.buildLogoutUrls(
      stage,
      localFrontendBaseUrl,
      productionFrontendBaseUrl,
    );
    const mfaConfiguration = this.readMfaConfiguration(stage);
    const supportedIdentityProviders = ['COGNITO'];

    const userPool = new cognito.CfnUserPool(this, 'UserPool', {
      userPoolName: `${projectName}-${stage}-users`,
      usernameAttributes: ['email'],
      autoVerifiedAttributes: ['email'],
      mfaConfiguration,
      enabledMfas:
        mfaConfiguration === 'OFF' ? undefined : ['SOFTWARE_TOKEN_MFA'],
      deletionProtection: this.isProduction(stage) ||
        this.readBooleanContext('deletionProtection', false)
        ? 'ACTIVE'
        : 'INACTIVE',
      emailConfiguration: {
        // Managed delivery accepts a verified custom sender while SES remains
        // sandboxed. Bootstrap the exact-pool SES sending policy first.
        emailSendingAccount: 'COGNITO_DEFAULT',
        ...(this.isProduction(stage) ? {
          from: 'DespensaLista <no-reply@despensalista.lynxpardelle.com>',
          sourceArn: this.formatArn({ service: 'ses', resource: 'identity', resourceName: 'despensalista.lynxpardelle.com' }),
        } : {}),
      },
      accountRecoverySetting: {
        recoveryMechanisms: [
          {
            name: 'verified_email',
            priority: 1,
          },
        ],
      },
      adminCreateUserConfig: {
        allowAdminCreateUserOnly: false,
      },
      policies: {
        passwordPolicy: {
          minimumLength: 12,
          requireLowercase: true,
          requireNumbers: true,
          requireSymbols: true,
          requireUppercase: true,
          temporaryPasswordValidityDays: 7,
        },
      },
      schema: [
        {
          name: 'email',
          attributeDataType: 'String',
          mutable: true,
          required: true,
        },
        {
          name: 'name',
          attributeDataType: 'String',
          mutable: true,
          required: false,
        },
        {
          name: 'preferred_username',
          attributeDataType: 'String',
          mutable: true,
          required: false,
        },
      ],
      userAttributeUpdateSettings: {
        attributesRequireVerificationBeforeUpdate: ['email'],
      },
      verificationMessageTemplate: {
        defaultEmailOption: 'CONFIRM_WITH_CODE',
      },
    });
    userPool.applyRemovalPolicy(this.resolveRemovalPolicy());

    const userPoolDomain = new cognito.CfnUserPoolDomain(
      this,
      'UserPoolDomain',
      {
        domain: domainPrefix,
        managedLoginVersion: 2,
        userPoolId: userPool.ref,
      },
    );

    this.readExternalSocialProviders().forEach((provider) => {
      supportedIdentityProviders.push(provider);
    });

    const userPoolClient = new cognito.CfnUserPoolClient(
      this,
      'WebUserPoolClient',
      {
        userPoolId: userPool.ref,
        clientName: `${projectName}-${stage}-web`,
        generateSecret: false,
        preventUserExistenceErrors: 'ENABLED',
        enableTokenRevocation: true,
        allowedOAuthFlowsUserPoolClient: true,
        allowedOAuthFlows: ['code'],
        allowedOAuthScopes: ['openid', 'email', 'profile'],
        callbackUrLs: callbackUrls,
        logoutUrLs: logoutUrls,
        supportedIdentityProviders,
        explicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH'],
        accessTokenValidity: 1,
        idTokenValidity: 1,
        refreshTokenValidity: 30,
        tokenValidityUnits: {
          accessToken: 'hours',
          idToken: 'hours',
          refreshToken: 'days',
        },
      },
    );

    const managedLoginBranding = new cognito.CfnManagedLoginBranding(
      this,
      'ManagedLoginBranding',
      {
        userPoolId: userPool.ref,
        clientId: userPoolClient.ref,
        useCognitoProvidedValues: true,
      },
    );
    managedLoginBranding.addDependency(userPoolClient);

    const sesIdentity = this.createSesIdentity(stage);
    createStageDeliveryControls(this, projectName, stage, userPool.attrArn);

    const userPoolDomainUrl = `https://${domainPrefix}.auth.${cdk.Aws.REGION}.amazoncognito.com`;
    this.allowedProviders = supportedIdentityProviders;
    this.userPoolClientId = userPoolClient.ref;
    this.userPoolDomainUrl = userPoolDomainUrl;
    this.userPoolId = userPool.ref;

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.ref,
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.ref,
    });
    new cdk.CfnOutput(this, 'CognitoIssuer', {
      value: `https://cognito-idp.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}/${userPool.ref}`,
    });
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: userPoolDomainUrl,
    });
    new cdk.CfnOutput(this, 'SocialProviderRedirectUri', {
      value: `${userPoolDomainUrl}/oauth2/idpresponse`,
    });
    new cdk.CfnOutput(this, 'AllowedProviders', {
      value: supportedIdentityProviders.join(','),
    });
    if (sesIdentity) {
      new cdk.CfnOutput(this, 'SesEmailIdentityName', {
        value: sesIdentity.emailIdentityName,
      });
      new cdk.CfnOutput(this, 'SesFromAddress', {
        value: `no-reply@${sesIdentity.emailIdentityName}`,
      });
      new cdk.CfnOutput(this, 'CognitoEmailSendingAccount', {
        value: 'COGNITO_DEFAULT',
      });
    }
    if (stage.trim().toLowerCase() !== 'prod') {
      new cdk.CfnOutput(this, 'LocalCallbackUrl', {
        value: `${localFrontendBaseUrl}/api/auth/cognito/callback`,
      });
    }

    userPoolClient.addDependency(userPoolDomain);
  }

  private buildCallbackUrls(
    stage: string,
    localFrontendBaseUrl: string,
    productionFrontendBaseUrl: ContextValue,
  ): string[] {
    return this.allowedAuthUrls(stage, [
      `${localFrontendBaseUrl}/api/auth/cognito/callback`,
      productionFrontendBaseUrl
        ? `${productionFrontendBaseUrl}/api/auth/cognito/callback`
        : undefined,
      ...this.readCsvContext('extraCallbackUrls'),
    ]);
  }

  private buildLogoutUrls(
    stage: string,
    localFrontendBaseUrl: string,
    productionFrontendBaseUrl: ContextValue,
  ): string[] {
    return this.allowedAuthUrls(stage, [
      `${localFrontendBaseUrl}/login`,
      productionFrontendBaseUrl ? `${productionFrontendBaseUrl}/login` : undefined,
      ...this.readCsvContext('extraLogoutUrls'),
    ]);
  }

  private uniqueUrls(values: Array<string | undefined>): string[] {
    return [
      ...new Set(
        values
          .map((value) => value?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ];
  }

  private allowedAuthUrls(
    stage: string,
    values: Array<string | undefined>,
  ): string[] {
    const urls = this.uniqueUrls(values);

    if (stage.trim().toLowerCase() !== 'prod') {
      return urls;
    }

    return urls.filter((url) => !this.isLocalhostUrl(url));
  }

  private isLocalhostUrl(value: string): boolean {
    try {
      const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '');

      return hostname === 'localhost' || hostname.endsWith('.localhost');
    } catch {
      return false;
    }
  }

  private readContext(key: string, fallback: string): string {
    return this.readOptionalContext(key) ?? fallback;
  }

  private readOptionalContext(key: string): ContextValue {
    const value = this.node.tryGetContext(key);

    if (value === undefined || value === null) {
      return undefined;
    }

    const normalizedValue = value.toString().trim();

    return normalizedValue.length > 0 ? normalizedValue : undefined;
  }

  private readBooleanContext(key: string, fallback: boolean): boolean {
    const value = this.readOptionalContext(key);

    if (!value) {
      return fallback;
    }

    return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
  }

  private readCsvContext(key: string): string[] {
    const value = this.readOptionalContext(key);

    if (!value) {
      return [];
    }

    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private readExternalSocialProviders(): string[] {
    const allowed = new Set(['Google', 'Facebook']);

    return this.readCsvContext('externallyManagedSocialProviders').filter(
      (provider) => allowed.has(provider),
    );
  }

  private resolveRemovalPolicy(): cdk.RemovalPolicy {
    const removalPolicy = this.readContext('removalPolicy', 'retain');

    if (removalPolicy.toLowerCase() === 'destroy') {
      return cdk.RemovalPolicy.DESTROY;
    }

    return cdk.RemovalPolicy.RETAIN;
  }

  private createSesIdentity(stage: string): ses.EmailIdentity | undefined {
    if (!this.isProduction(stage)) {
      return undefined;
    }

    const hostedZoneId = this.readContext(
      'hostedZoneId',
      'Z05088763QG63CC5SE7PN',
    );
    const hostedZoneName = this.readContext(
      'hostedZoneName',
      'lynxpardelle.com',
    );
    const identityDomain = this.readContext(
      'sesIdentityDomain',
      'despensalista.lynxpardelle.com',
    );
    const zone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      'SesHostedZone',
      {
        hostedZoneId,
        zoneName: hostedZoneName,
      },
    );
    const identity = new ses.EmailIdentity(this, 'SesEmailIdentity', {
      identity: ses.Identity.domain(identityDomain),
      dkimIdentity: ses.DkimIdentity.easyDkim(
        ses.EasyDkimSigningKeyLength.RSA_2048_BIT,
      ),
      dkimSigning: true,
      feedbackForwarding: true,
    });

    identity.dkimRecords.forEach((record, index) => {
      new route53.CfnRecordSet(this, `SesDkimRecord${index + 1}`, {
        hostedZoneId: zone.hostedZoneId,
        name: record.name,
        type: 'CNAME',
        resourceRecords: [record.value],
        ttl: '1800',
      });
    });

    return identity;
  }

  private isProduction(stage: string): boolean {
    return stage.trim().toLowerCase() === 'prod';
  }

  private readMfaConfiguration(stage: string): 'OFF' | 'OPTIONAL' | 'ON' {
    if (this.isProduction(stage)) {
      return 'ON';
    }

    const value = this.readContext('mfaConfiguration', 'ON')
      .trim()
      .toUpperCase();

    if (value === 'OFF' || value === 'OPTIONAL' || value === 'ON') {
      return value;
    }

    throw new Error(
      `Unsupported mfaConfiguration "${value}". Use OFF, OPTIONAL, or ON.`,
    );
  }

}
