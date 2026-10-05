import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyRuntimeBoundary, deliveryInventory } from './stage-delivery';

interface DespensaListaServerlessBackendStackProps extends cdk.StackProps {
  allowedProviders: string[];
  cognitoDomain: string;
  cognitoUserPoolClientId: string;
  cognitoUserPoolId: string;
}

interface DespensaListaTables {
  inventoryLots: dynamodb.Table;
  productTypes: dynamodb.Table;
  products: dynamodb.Table;
  users: dynamodb.Table;
}

const BACKEND_DATA_CONTRACT_VERSION = '1';

export class DespensaListaServerlessBackendStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: DespensaListaServerlessBackendStackProps,
  ) {
    super(scope, id, props);

    const projectName = this.readContext('projectName', 'despensalista');
    const stage = this.readContext('stage', 'dev');
    const releaseId = this.readContext('releaseId', 'local');
    if (releaseId !== 'local' && !/^[0-9a-f]{12}$/.test(releaseId)) {
      throw new Error('releaseId must be a 12-character hexadecimal release ID.');
    }
    applyRuntimeBoundary(this, projectName, stage);
    const isProduction = stage.trim().toLowerCase() === 'prod';
    const frontendBaseUrl = this.readContext(
      'serverlessFrontendBaseUrl',
      this.readContext('localFrontendBaseUrl', 'http://localhost:48673'),
    );
    const domainName = this.readContext(
      'appDomainName',
      'despensalista.lynxpardelle.com',
    );
    const hostedZoneId = this.readContext(
      'hostedZoneId',
      'Z05088763QG63CC5SE7PN',
    );
    const hostedZoneName = this.readContext('hostedZoneName', 'lynxpardelle.com');
    const tables = this.createTables(projectName, stage);
    const logRetention = isProduction
      ? logs.RetentionDays.ONE_MONTH
      : logs.RetentionDays.ONE_WEEK;
    const resourceRemovalPolicy = this.resolveRemovalPolicy();
    const originVerifyHeaderName = 'x-despensalista-origin-verify';
    const originSecretName = `${projectName}/${stage}/cloudfront-origin-verification`;
    const originVerifySecret = new secretsmanager.Secret(
      this,
      'OriginVerificationSecret',
      {
        secretName: originSecretName,
        description:
          'CloudFront-to-API origin verification value; never send from browsers.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 48,
        },
      },
    );
    originVerifySecret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const backendFunctionName = `${projectName}-${stage}-backend-api`;
    // The production group was auto-created by Lambda before CDK managed logs.
    // LogRetention safely adopts retention without attempting to recreate it.
    const backendLogGroup = logs.LogGroup.fromLogGroupName(
      this, 'BackendLogGroup', `/aws/lambda/${backendFunctionName}`,
    );
    new logs.LogRetention(this, 'BackendLogRetention', {
      logGroupName: backendLogGroup.logGroupName,
      retention: logRetention,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const backendArtifactPath = this.readContext('backendArtifactPath', '');
    const apiFunction = new lambda.Function(this, 'BackendFunction', {
      functionName: backendFunctionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'dist/src/lambda.handler',
      memorySize: this.readNumberContext('backendLambdaMemoryMb', 512),
      timeout: cdk.Duration.seconds(
        this.readNumberContext('backendLambdaTimeoutSeconds', 15),
      ),
      logGroup: backendLogGroup,
      code: backendArtifactPath ? lambda.Code.fromAsset(path.resolve(backendArtifactPath)) : lambda.Code.fromAsset(
        path.join(__dirname, '..', '..', '..', 'backend'),
        {
          bundling: createBackendBundlingOptions(),
        },
      ),
      environment: {
        NODE_ENV: 'production',
        BACKEND_DATA_CONTRACT_VERSION,
        API_PREFIX: 'api',
        PERSISTENCE_PROVIDER: 'dynamodb',
        DYNAMODB_REGION: cdk.Aws.REGION,
        DYNAMODB_USERS_TABLE: tables.users.tableName,
        DYNAMODB_PRODUCTS_TABLE: tables.products.tableName,
        DYNAMODB_PRODUCT_TYPES_TABLE: tables.productTypes.tableName,
        DYNAMODB_INVENTORY_LOTS_TABLE: tables.inventoryLots.tableName,
        CORS_ORIGIN: frontendBaseUrl,
        COGNITO_ENABLED: 'true',
        COGNITO_ISSUER: `https://cognito-idp.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}/${props.cognitoUserPoolId}`,
        COGNITO_DOMAIN: props.cognitoDomain,
        COGNITO_CLIENT_ID: props.cognitoUserPoolClientId,
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_REGION: cdk.Aws.REGION,
        COGNITO_REDIRECT_URI: `${frontendBaseUrl}/api/auth/cognito/callback`,
        COGNITO_LOGOUT_REDIRECT_URI: `${frontendBaseUrl}/login`,
        COGNITO_ALLOWED_PROVIDERS: props.allowedProviders.join(','),
        HELMET_ENABLED: 'true',
        RATE_LIMIT_ENABLED: 'true',
        RATE_LIMIT_TRUST_PROXY: 'false',
        SWAGGER_ENABLED: 'false',
        ORIGIN_VERIFY_HEADER_NAME: originVerifyHeaderName,
        ORIGIN_VERIFY_HEADER_VALUE:
          originVerifySecret.secretValue.unsafeUnwrap(),
      },
    });

    Object.values(tables).forEach((table) => table.grantReadWriteData(apiFunction));
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:TransactWriteItems'],
        resources: Object.values(tables).map((table) => table.tableArn),
      }),
    );
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminUserGlobalSignOut',
          'cognito-idp:ListUsers',
        ],
        resources: [
          this.formatArn({
            service: 'cognito-idp',
            resource: 'userpool',
            resourceName: props.cognitoUserPoolId,
          }),
        ],
      }),
    );

    const publishedVersion = apiFunction.currentVersion;
    publishedVersion.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const liveAlias = new lambda.Alias(this, 'BackendLiveAlias', {
      aliasName: 'live',
      description: 'Stable production traffic target and rollback pointer.',
      version: publishedVersion,
    });
    if (isProduction) {
      new events.Rule(this, 'AccountDeletionResumeRule', {
        ruleName: `${projectName}-${stage}-account-deletion-resume`,
        schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
        targets: [
          new eventTargets.LambdaFunction(liveAlias, {
            event: events.RuleTargetInput.fromObject({
              source: 'despensalista.account-deletion-worker',
              'detail-type': 'resume',
            }),
            maxEventAge: cdk.Duration.minutes(5),
            retryAttempts: 0,
          }),
        ],
      });
    }

    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: `${projectName}-${stage}-backend-api`,
      corsPreflight: {
        allowCredentials: true,
        allowHeaders: [
          'authorization',
          'content-type',
          'idempotency-key',
          'x-xsrf-token',
          'x-metrics-token',
        ],
        allowMethods: [apigatewayv2.CorsHttpMethod.ANY],
        allowOrigins: [frontendBaseUrl],
        exposeHeaders: ['idempotency-key', 'idempotency-replayed'],
      },
    });
    const apiAccessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      logGroupName: `/aws/apigateway/${projectName}-${stage}-backend-api`,
      retention: logRetention,
      removalPolicy: resourceRemovalPolicy,
    });
    apiAccessLogGroup.grantWrite(
      new iam.ServicePrincipal('apigateway.amazonaws.com'),
    );
    const defaultStage = httpApi.defaultStage;
    if (!defaultStage) {
      throw new Error('HTTP API default stage is required for access logging.');
    }
    const cfnDefaultStage = defaultStage.node.defaultChild as apigatewayv2.CfnStage;
    cfnDefaultStage.accessLogSettings = {
      destinationArn: apiAccessLogGroup.logGroupArn,
      format: JSON.stringify({
        apiId: '$context.apiId',
        integrationStatus: '$context.integrationStatus',
        latencyMs: '$context.responseLatency',
        method: '$context.httpMethod',
        protocol: '$context.protocol',
        requestId: '$context.requestId',
        routeKey: '$context.routeKey',
        sourceIp: '$context.identity.sourceIp',
        status: '$context.status',
      }),
    };
    cfnDefaultStage.defaultRouteSettings = {
      throttlingBurstLimit: 30,
      throttlingRateLimit: 10,
      detailedMetricsEnabled: false,
    };
    const integration = new integrations.HttpLambdaIntegration(
      'BackendIntegration',
      liveAlias,
    );

    httpApi.addRoutes({
      path: '/',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration,
    });
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration,
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName: hostedZoneName,
    });
    const certificate = new acm.Certificate(this, 'WebCertificate', {
      domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
      removalPolicy: resourceRemovalPolicy,
      autoDeleteObjects:
        resourceRemovalPolicy === cdk.RemovalPolicy.DESTROY,
    });
    const responseHeadersPolicy = this.createResponseHeadersPolicy(
      projectName,
      stage,
    );
    const enableFlatRateWaf = this.readBooleanContext(
      'enableFlatRateWaf',
      Boolean(deliveryInventory(stage).subscriptionArn) ||
        this.readBooleanContext('controlPlaneBootstrap', false),
    );
    const webAcl = enableFlatRateWaf
      ? this.createFlatRateWebAcl(
          projectName,
          stage,
          originVerifyHeaderName,
        )
      : undefined;
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      comment: `${projectName}-${stage} serverless web`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: this.createSpaRewriteFunction(projectName, stage),
          },
        ],
      },
      additionalBehaviors: {
        'api/*': {
          origin: new origins.HttpOrigin(apiDomainNameFromEndpoint(httpApi.apiEndpoint), {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
            customHeaders: {
              [originVerifyHeaderName]:
                originVerifySecret.secretValue.unsafeUnwrap(),
            },
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      certificate,
      domainNames: [domainName],
      enableIpv6: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      webAclId: webAcl?.attrArn,
    });
    if (webAcl) {
      // Native CF registration fails/rolls back the WAF if FREE enrollment fails.
      const subscription = new cdk.CfnResource(this, 'CloudFrontFreeSubscription', {
        type: 'AWS::PricingPlanManager::Subscription',
        properties: {
          PlanFamily: 'CloudFront',
          PlanTier: 'FREE',
          UsageLevel: 'DEFAULT',
          ResourceArns: [distribution.distributionArn, webAcl.attrArn],
        },
      });
      new cdk.CfnOutput(this, 'CloudFrontFreeSubscriptionArn', { value: subscription.ref });
    }

    const alarmTopic = isProduction
      ? new sns.Topic(this, 'OperationsAlarmTopic', {
          topicName: `${projectName}-${stage}-operations-alarms`,
          displayName: 'DespensaLista production alarms',
        })
      : undefined;
    const deploymentAlarms = isProduction && alarmTopic
      ? this.createProductionAlarms(
          projectName,
          stage,
          liveAlias,
          httpApi,
          distribution,
          alarmTopic,
        )
      : [];

    if (isProduction) {
      new codedeploy.LambdaDeploymentGroup(this, 'BackendDeploymentGroup', {
        alias: liveAlias,
        alarms: deploymentAlarms.slice(0, 1),
        autoRollback: {
          deploymentInAlarm: true,
          failedDeployment: true,
          stoppedDeployment: true,
        },
        deploymentConfig:
          codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE,
        deploymentGroupName: `${projectName}-${stage}-backend-release`,
      });
    }

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [s3deploy.Source.asset(this.readContext('frontendArtifactPath', '') || frontendBrowserDistPath())],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
      cacheControl: [s3deploy.CacheControl.noCache()],
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone,
      recordName: toRecordName(domainName, hostedZoneName),
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution),
      ),
    });
    new route53.AaaaRecord(this, 'AliasIpv6Record', {
      zone,
      recordName: toRecordName(domainName, hostedZoneName),
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution),
      ),
    });

    new cdk.CfnOutput(this, 'ServerlessBackendApiEndpoint', {
      value: httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, 'ServerlessBackendFunctionName', {
      value: apiFunction.functionName,
    });
    new cdk.CfnOutput(this, 'ServerlessBackendLiveAliasArn', {
      value: liveAlias.functionArn,
    });
    new cdk.CfnOutput(this, 'ServerlessBackendAliasName', { value: liveAlias.aliasName });
    new cdk.CfnOutput(this, 'ServerlessBackendVersion', {
      value: publishedVersion.version,
    });
    new cdk.CfnOutput(this, 'DeploymentReleaseId', { value: releaseId });
    new cdk.CfnOutput(this, 'PantryQuotaSchemaVersion', { value: '2' });
    new cdk.CfnOutput(this, 'BackendDataContractVersion', {
      value: BACKEND_DATA_CONTRACT_VERSION,
    });
    new cdk.CfnOutput(this, 'DynamoDbUsersTable', {
      value: tables.users.tableName,
    });
    new cdk.CfnOutput(this, 'DynamoDbProductsTable', {
      value: tables.products.tableName,
    });
    new cdk.CfnOutput(this, 'DynamoDbProductTypesTable', {
      value: tables.productTypes.tableName,
    });
    new cdk.CfnOutput(this, 'DynamoDbInventoryLotsTable', {
      value: tables.inventoryLots.tableName,
    });
    new cdk.CfnOutput(this, 'AppDomainName', { value: domainName });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'WebBucketName', { value: webBucket.bucketName });
    if (webAcl) {
      new cdk.CfnOutput(this, 'FlatRateWebAclArn', {
        value: webAcl.attrArn,
      });
      new cdk.CfnOutput(this, 'FlatRateWebAclId', {
        value: webAcl.attrId,
      });
    }
    if (alarmTopic) {
      new cdk.CfnOutput(this, 'OperationsAlarmTopicArn', {
        value: alarmTopic.topicArn,
      });
    }
    // CDK's generated layer name omits the stack prefix. Give the deployment
    // helper a stage namespace so its IAM permission cannot span environments.
    for (const resource of this.node.findAll()) {
      if (resource instanceof lambda.CfnLayerVersion) {
        resource.layerName = `${projectName}-${stage}-web-deploy-cli`;
      }
      if (resource instanceof iam.CfnRole) {
        resource.roleName = `${projectName}-${stage}-runtime-${this.getLogicalId(resource).slice(-35)}`;
      }
    }
  }

  private createTables(projectName: string, stage: string): DespensaListaTables {
    const users = this.createTable(`${projectName}-${stage}-users`, 'pk');
    const products = this.createTable(`${projectName}-${stage}-products`, 'id');
    const productTypes = this.createTable(
      `${projectName}-${stage}-product-types`,
      'id',
    );
    const inventoryLots = this.createTable(
      `${projectName}-${stage}-inventory-lots`,
      'id',
    );

    users.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });
    users.addGlobalSecondaryIndex({
      indexName: 'gsi2',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
    });
    products.addGlobalSecondaryIndex({
      indexName: 'UserUpdatedAtIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
    });
    productTypes.addGlobalSecondaryIndex({
      indexName: 'UserBaseNameIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'normalizedBaseName', type: dynamodb.AttributeType.STRING },
    });
    productTypes.addGlobalSecondaryIndex({
      indexName: 'UserArchivedAtIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'archivedAt', type: dynamodb.AttributeType.STRING },
    });
    inventoryLots.addGlobalSecondaryIndex({
      indexName: 'UserUpdatedAtIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
    });
    inventoryLots.addGlobalSecondaryIndex({
      indexName: 'ProductTypeUpdatedAtIndex',
      partitionKey: { name: 'productTypeId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
    });
    inventoryLots.addGlobalSecondaryIndex({
      indexName: 'UserArchivedAtIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'archivedAt', type: dynamodb.AttributeType.STRING },
    });

    return { users, products, productTypes, inventoryLots };
  }

  private createTable(tableName: string, partitionKeyName: string): dynamodb.Table {
    const stage = this.readContext('stage', 'dev').trim().toLowerCase();

    return new dynamodb.Table(this, toConstructId(tableName), {
      tableName,
      partitionKey: {
        name: partitionKeyName,
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: stage === 'prod',
      removalPolicy: this.resolveRemovalPolicy(),
      timeToLiveAttribute: 'expiresAtEpochSeconds',
    });
  }

  private readContext(key: string, fallback: string): string {
    const value = this.node.tryGetContext(key);

    if (value === undefined || value === null) {
      return fallback;
    }

    const normalizedValue = value.toString().trim();

    return normalizedValue.length > 0 ? normalizedValue : fallback;
  }

  private readNumberContext(key: string, fallback: number): number {
    const value = Number(this.readContext(key, fallback.toString()));

    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${key} must be a positive number.`);
    }

    return value;
  }

  private readBooleanContext(key: string, fallback: boolean): boolean {
    const normalizedValue = this.readContext(key, fallback.toString())
      .trim()
      .toLowerCase();

    if (['1', 'true', 'yes', 'y'].includes(normalizedValue)) {
      return true;
    }
    if (['0', 'false', 'no', 'n'].includes(normalizedValue)) {
      return false;
    }

    throw new Error(`${key} must be a boolean value.`);
  }

  private resolveRemovalPolicy(): cdk.RemovalPolicy {
    const removalPolicy = this.readContext('removalPolicy', 'retain');

    return removalPolicy.toLowerCase() === 'destroy'
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;
  }

  private createSpaRewriteFunction(
    projectName: string,
    stage: string,
  ): cloudfront.Function {
    return new cloudfront.Function(this, 'SpaRewriteFunction', {
      functionName: `${projectName}-${stage}-spa-rewrite`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri === '/healthz') {
    return {
      statusCode: 200,
      statusDescription: 'OK',
      headers: {
        'cache-control': { value: 'no-store' },
        'content-type': { value: 'application/json' }
      },
      body: '{"status":"ok","service":"despensalista-frontend"}'
    };
  }

  if (uri === '/privacidad' || uri === '/privacidad/') {
    request.uri = '/privacidad/index.html';
    return request;
  }

  if (uri === '/api' || uri.indexOf('/api/') === 0 || uri.indexOf('.') !== -1) {
    return request;
  }

  request.uri = '/index.html';
  return request;
}
`),
    });
  }

  private createFlatRateWebAcl(
    projectName: string,
    stage: string,
    originVerifyHeaderName: string,
  ): wafv2.CfnWebACL {
    const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      metricName,
      sampledRequestsEnabled: false,
    });
    const noTransformation: wafv2.CfnWebACL.TextTransformationProperty[] = [
      { priority: 0, type: 'NONE' },
    ];
    const normalizedTransformations: wafv2.CfnWebACL.TextTransformationProperty[] = [
      { priority: 0, type: 'URL_DECODE' },
      { priority: 1, type: 'LOWERCASE' },
    ];
    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      {
        name: 'PerIpRateLimit',
        priority: 0,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            aggregateKeyType: 'IP',
            evaluationWindowSec: 300,
            limit: 500,
          },
        },
        visibilityConfig: visibility(`${projectName}-${stage}-rate-limit`),
      },
      {
        name: 'KnownScannerPaths',
        priority: 1,
        action: { block: {} },
        statement: {
          regexMatchStatement: {
            fieldToMatch: { uriPath: {} },
            regexString:
              '^/(?:\\.env|\\.git(?:/|$)|wp-admin(?:/|$)|wp-login\\.php|phpmyadmin(?:/|$)|server-status(?:/|$))',
            textTransformations: normalizedTransformations,
          },
        },
        visibilityConfig: visibility(`${projectName}-${stage}-scanner-paths`),
      },
      {
        name: 'ViewerOriginHeader',
        priority: 2,
        action: { block: {} },
        statement: {
          sizeConstraintStatement: {
            comparisonOperator: 'GT',
            fieldToMatch: { singleHeader: { Name: originVerifyHeaderName } },
            size: 0,
            textTransformations: noTransformation,
          },
        },
        visibilityConfig: visibility(`${projectName}-${stage}-oversized-body`),
      },
      {
        name: 'QueryInjection',
        priority: 3,
        action: { block: {} },
        statement: {
          orStatement: {
            statements: [
              {
                sqliMatchStatement: {
                  fieldToMatch: { allQueryArguments: {} },
                  sensitivityLevel: 'LOW',
                  textTransformations: normalizedTransformations,
                },
              },
              {
                xssMatchStatement: {
                  fieldToMatch: { allQueryArguments: {} },
                  textTransformations: normalizedTransformations,
                },
              },
            ],
          },
        },
        visibilityConfig: visibility(`${projectName}-${stage}-query-injection`),
      },
      {
        name: 'AllowedHttpMethods',
        priority: 4,
        action: { block: {} },
        statement: {
          notStatement: {
            statement: {
              regexMatchStatement: {
                fieldToMatch: { method: {} },
                regexString: '^(?:GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$',
                textTransformations: noTransformation,
              },
            },
          },
        },
        visibilityConfig: visibility(`${projectName}-${stage}-http-methods`),
      },
    ];
    const webAcl = new wafv2.CfnWebACL(this, 'FlatRateWebAcl', {
      defaultAction: { allow: {} },
      description:
        'Five individual rules compatible with the CloudFront flat-rate Free plan.',
      name: `${projectName}-${stage}-flat-rate`,
      rules,
      scope: 'CLOUDFRONT',
      visibilityConfig: visibility(`${projectName}-${stage}-web-acl`),
    });
    // Do not retain an un-enrolled ACL on failed initial deployment: PAYG is $5+.
    webAcl.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    return webAcl;
  }

  private createProductionAlarms(
    projectName: string,
    stage: string,
    liveAlias: lambda.Alias,
    httpApi: apigatewayv2.HttpApi,
    distribution: cloudfront.Distribution,
    topic: sns.Topic,
  ): cloudwatch.Alarm[] {
    const commonProps = {
      actionsEnabled: true,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    };
    const alarms = [
      new cloudwatch.Alarm(this, 'BackendErrorsAlarm', {
        ...commonProps,
        alarmDescription: 'The live backend alias returned an error.',
        alarmName: `${projectName}-${stage}-backend-errors`,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        metric: liveAlias.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
      }),
      new cloudwatch.Alarm(this, 'ApiServerErrorsAlarm', {
        ...commonProps,
        alarmDescription: 'The public HTTP API returned a 5xx response.',
        alarmName: `${projectName}-${stage}-api-5xx`,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: '5xx',
          dimensionsMap: {
            ApiId: httpApi.apiId,
            Stage: '$default',
          },
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
      }),
      new cloudwatch.Alarm(this, 'BackendThrottlesAlarm', {
        ...commonProps,
        alarmDescription: 'The live backend alias was throttled.',
        alarmName: `${projectName}-${stage}-backend-throttles`,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        metric: liveAlias.metricThrottles({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
      }),
      new cloudwatch.Alarm(this, 'CloudFrontServerErrorsAlarm', {
        ...commonProps,
        alarmDescription: 'CloudFront 5xx error rate exceeded five percent.',
        alarmName: `${projectName}-${stage}-cloudfront-5xx-rate`,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        metric: distribution.metric5xxErrorRate({
          period: cdk.Duration.minutes(5),
          statistic: 'Average',
        }),
        threshold: 5,
      }),
    ];
    const action = new cloudwatchActions.SnsAction(topic);

    alarms.forEach((alarm) => alarm.addAlarmAction(action));

    return alarms;
  }

  private createResponseHeadersPolicy(
    projectName: string,
    stage: string,
  ): cloudfront.ResponseHeadersPolicy {
    return new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
      responseHeadersPolicyName: `${projectName}-${stage}-serverless-security-headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'self'",
            "img-src 'self' data: https:",
            "font-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self' 'unsafe-inline'",
            "connect-src 'self'",
            "form-action 'self' https://*.amazoncognito.com",
          ].join('; '),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy:
            cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        xssProtection: {
          protection: false,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
            override: true,
          },
        ],
      },
    });
  }
}

function toConstructId(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function createBackendBundlingOptions(): cdk.BundlingOptions {
  return {
    image: lambda.Runtime.NODEJS_22_X.bundlingImage,
    command: [
      'bash',
      '-c',
      [
        'set -euo pipefail',
        'cp -R /asset-input/. /tmp/despensalista-backend',
        'cd /tmp/despensalista-backend',
        'MONGOMS_DISABLE_POSTINSTALL=1 npm ci',
        'npm run build',
        'MONGOMS_DISABLE_POSTINSTALL=1 npm ci --omit=dev',
        'cp -R dist node_modules package.json package-lock.json /asset-output/',
      ].join(' && '),
    ],
    local: {
      tryBundle(outputDir: string): boolean {
        return tryBundleBackendLocally(outputDir);
      },
    },
  };
}

function tryBundleBackendLocally(outputDir: string): boolean {
  const sourceDir = path.join(__dirname, '..', '..', '..', 'backend');
  const temporaryDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'despensalista-backend-bundle-'),
  );

  try {
    fs.cpSync(sourceDir, temporaryDir, {
      recursive: true,
      filter: (source) => !shouldSkipBackendBundlePath(source, sourceDir),
    });

    runNpm(['ci'], temporaryDir);
    runNpm(['run', 'build'], temporaryDir);
    runNpm(['ci', '--omit=dev'], temporaryDir);

    for (const assetName of [
      'dist',
      'node_modules',
      'package.json',
      'package-lock.json',
    ]) {
      fs.cpSync(path.join(temporaryDir, assetName), path.join(outputDir, assetName), {
        recursive: true,
      });
    }

    return true;
  } catch (error) {
    console.warn(
      `Local backend bundle failed; falling back to Docker bundling: ${String(error)}`,
    );

    return false;
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function runNpm(args: string[], cwd: string): void {
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/c', 'npm', ...args], { cwd, stdio: 'inherit', env: { ...process.env, MONGOMS_DISABLE_POSTINSTALL: '1' } });
    return;
  }

  execFileSync('npm', args, { cwd, stdio: 'inherit', env: { ...process.env, MONGOMS_DISABLE_POSTINSTALL: '1' } });
}

function shouldSkipBackendBundlePath(source: string, sourceDir: string): boolean {
  const relativePath = path.relative(sourceDir, source);
  const [firstSegment] = relativePath.split(path.sep);

  return ['coverage', 'dist', 'node_modules'].includes(firstSegment);
}

function apiDomainNameFromEndpoint(endpoint: string): string {
  return cdk.Fn.select(2, cdk.Fn.split('/', endpoint));
}

function frontendBrowserDistPath(): string {
  const distPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'frontend',
    'dist',
    'frontend',
    'browser',
  );

  if (!fs.existsSync(distPath)) {
    throw new Error('Build frontend before CDK synth: npm --prefix frontend run build');
  }

  return distPath;
}

function toRecordName(domainName: string, zoneName: string): string {
  const normalizedZoneName = zoneName.endsWith('.') ? zoneName : `${zoneName}.`;
  const normalizedDomainName = domainName.endsWith('.')
    ? domainName
    : `${domainName}.`;

  if (normalizedDomainName.endsWith(normalizedZoneName)) {
    return normalizedDomainName
      .slice(0, -normalizedZoneName.length)
      .replace(/\.$/, '');
  }

  return domainName;
}
