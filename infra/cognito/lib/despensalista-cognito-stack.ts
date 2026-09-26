import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import { createStageDeliveryControls } from './stage-delivery';
import { Construct } from 'constructs';
import * as fs from 'node:fs';
import * as path from 'node:path';

type ContextValue = string | undefined;

const EMAIL_QUOTAS = {
  dev: { dailyLimit: 2, recoveryReserve: 1, recipientLimit: 1 },
  tst: { dailyLimit: 3, recoveryReserve: 1, recipientLimit: 2 },
  prod: { dailyLimit: 30, recoveryReserve: 10, recipientLimit: 5 },
} as const;

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
      userPoolTags: {
        Project: projectName,
        Stage: stage,
      },
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
    createStageDeliveryControls(this, projectName, stage);
    const emailQuotaGuard = this.createEmailQuotaGuard(
      projectName,
      stage,
      this.node.findChild('RuntimePermissionsBoundary') as iam.ManagedPolicy,
    );
    userPool.lambdaConfig = { customMessage: emailQuotaGuard.functionArn };
    emailQuotaGuard.addPermission('AllowCognitoCustomMessage', {
      action: 'lambda:InvokeFunction',
      principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      sourceAccount: this.account,
      sourceArn: userPool.attrArn,
    });

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

  private createEmailQuotaGuard(
    projectName: string,
    stage: string,
    runtimeBoundary: iam.IManagedPolicy,
  ): lambda.Function {
    const normalizedStage = stage.trim().toLowerCase() as keyof typeof EMAIL_QUOTAS;
    const quota = EMAIL_QUOTAS[normalizedStage];
    if (!quota) throw new Error(`Unsupported email quota stage "${stage}".`);

    const prefix = `${projectName}-${normalizedStage}`;
    const table = new dynamodb.Table(this, 'CognitoEmailQuotaCounters', {
      tableName: `${prefix}-cognito-email-quota`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
    });
    table.applyRemovalPolicy(this.resolveRemovalPolicy());

    const role = new iam.Role(this, 'CognitoEmailQuotaRole', {
      roleName: `${prefix}-runtime-cognito-email-quota`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: runtimeBoundary,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:TransactWriteItems'],
      resources: [table.tableArn],
    }));

    const logGroup = new logs.LogGroup(this, 'CognitoEmailQuotaLogGroup', {
      logGroupName: `/aws/lambda/${prefix}-cognito-email-quota`,
      retention: normalizedStage === 'prod'
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.ONE_WEEK,
      removalPolicy: this.resolveRemovalPolicy(),
    });

    const fn = new lambda.Function(this, 'CognitoEmailQuotaGuard', {
      functionName: `${prefix}-cognito-email-quota`,
      description: 'Fail-closed quota guard for Cognito managed email',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        fs.readFileSync(
          path.join(__dirname, '..', 'lambda', 'cognito-email-quota', 'index.js'),
          'utf8',
        ),
      ),
      memorySize: 128,
      role,
      logGroup,
      timeout: cdk.Duration.seconds(4),
      environment: {
        TABLE_NAME: table.tableName,
        DAILY_LIMIT: quota.dailyLimit.toString(),
        RECOVERY_RESERVE: quota.recoveryReserve.toString(),
        RECIPIENT_LIMIT: quota.recipientLimit.toString(),
      },
    });

    if (normalizedStage === 'prod') {
      new cloudwatch.Alarm(this, 'CognitoEmailQuotaErrorsAlarm', {
        alarmName: `${prefix}-cognito-email-quota-errors`,
        alarmDescription: 'Cognito managed-email quota guard rejected or failed a request.',
        metric: fn.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    return fn;
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
