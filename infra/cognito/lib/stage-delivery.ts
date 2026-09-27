import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Bootstrap-owned allowlist: changing it also changes protected IAM, which the
// GitHub/CF roles cannot do. New global resources require an administrator.
export interface DeliveryInventory {
  apiId?: string;
  distributionId?: string;
  responseHeadersPolicyId?: string;
  originAccessControlId?: string;
  certificateArn?: string;
  subscriptionArn?: string;
  webBucketName?: string;
}

export function deliveryInventory(stage: string): DeliveryInventory {
  const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'delivery-resources.json'), 'utf8'));
  return inventory[stage] ?? {};
}

export function stageSynthesizer(project: string, stage: string, administrativeBootstrap = false): cdk.DefaultStackSynthesizer {
  return new cdk.DefaultStackSynthesizer({
    fileAssetsBucketName: `${project}-${stage}-cdk-assets-\${AWS::AccountId}-\${AWS::Region}`,
    fileAssetPublishingRoleArn: '',
    imageAssetPublishingRoleArn: '',
    deployRoleArn: '',
    lookupRoleArn: '',
    useLookupRoleForStackOperations: false,
    cloudFormationExecutionRole: administrativeBootstrap
      ? cdk.DefaultStackSynthesizer.DEFAULT_CLOUDFORMATION_ROLE_ARN
      : `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/${project}-${stage}-cfn-execution`,
    bootstrapStackVersionSsmParameter: `/${project}/${stage}/cdk-bootstrap-version`,
    generateBootstrapVersionRule: false,
  });
}

export function applyRuntimeBoundary(stack: cdk.Stack, project: string, stage: string): void {
  iam.PermissionsBoundary.of(stack).apply(iam.ManagedPolicy.fromManagedPolicyArn(
    stack, 'RuntimeBoundary', stack.formatArn({ service: 'iam', region: '', resource: 'policy', resourceName: `${project}-${stage}-runtime-boundary` }),
  ));
}

export function createStageDeliveryControls(stack: cdk.Stack, project: string, stage: string): void {
  const prefix = `${project}-${stage}`;
  const inventory = deliveryInventory(stage);
  const arn = (service: string, resource: string, resourceName: string, region = stack.region) =>
    stack.formatArn({ service, region, resource, resourceName });
  const roleArn = (name: string) => arn('iam', 'role', name, '');
  const boundaryArn = arn('iam', 'policy', `${prefix}-runtime-boundary`, '');
  const assetsName = `${prefix}-cdk-assets-${stack.account}-${stack.region}`;
  const assetsArn = `arn:${stack.partition}:s3:::${assetsName}`;
  const webArn = `arn:${stack.partition}:s3:::${inventory.webBucketName ?? `${prefix}-serverless-*`}`;
  const functionArn = `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:function:${prefix}-*`;
  const tableArn = arn('dynamodb', 'table', `${prefix}-*`);
  const logArn = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:`;
  const logResources = [`${logArn}/aws/lambda/${prefix}-*`, `${logArn}/aws/apigateway/${prefix}-*`];
  const secretArn = arn('secretsmanager', 'secret', `${project}/${stage}/cloudfront-origin-verification-*`).replace(':secret/', ':secret:');
  const userPoolArn = arn('cognito-idp', 'userpool', '*');
  const userPoolConditions = { StringEquals: {
    'aws:ResourceTag/Project': project,
    'aws:ResourceTag/Stage': stage,
  } };
  const distributionArn = inventory.distributionId ? arn('cloudfront', 'distribution', inventory.distributionId, '') : undefined;
  const scoped = (actions: string[], resources: string[], conditions?: iam.Conditions) => new iam.PolicyStatement({ actions, resources, conditions });

  new s3.Bucket(stack, 'DeliveryAssetsBucket', {
    bucketName: assetsName, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    lifecycleRules: [stage === 'prod'
      ? { abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }
      : { expiration: cdk.Duration.days(90), abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }],
  });
  new ssm.StringParameter(stack, 'DeliveryBootstrapVersion', {
    parameterName: `/${project}/${stage}/cdk-bootstrap-version`, stringValue: '30',
    description: 'Isolated file-assets-only CDK deployment contract, administrator managed.',
  });

  // The boundary is an allowlist, not AdministratorAccess minus a few actions.
  // Neither application roles nor the deployment executor can alter this policy.
  const runtimeStatements = [
    scoped(['dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchWriteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:DescribeTable', 'dynamodb:ConditionCheckItem', 'dynamodb:TransactWriteItems'], [tableArn, `${tableArn}/index/*`]),
    scoped(['cognito-idp:AdminDeleteUser', 'cognito-idp:AdminUserGlobalSignOut', 'cognito-idp:ListUsers'], [userPoolArn], userPoolConditions),
    scoped(['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy', 'logs:DescribeLogStreams'], logResources),
    scoped(['logs:DescribeLogGroups', 'cloudwatch:DescribeAlarms'], ['*']),
    scoped(['s3:GetObject*', 's3:PutObject*', 's3:DeleteObject*', 's3:ListBucket*', 's3:GetBucketLocation'], [assetsArn, `${assetsArn}/*`, webArn, `${webArn}/*`]),
    scoped(
      ['lambda:GetFunction*', 'lambda:GetAlias', 'lambda:GetProvisionedConcurrencyConfig', 'lambda:UpdateAlias', 'lambda:InvokeFunction'],
      [functionArn, `${functionArn}:*`],
    ),
    scoped(['sns:Publish'], [`arn:${stack.partition}:sns:${stack.region}:${stack.account}:${prefix}-*`]),
    scoped(['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'], [arn('cloudfront', 'distribution', '*', '')], { StringEquals: { 'aws:ResourceTag/Project': project, 'aws:ResourceTag/Stage': stage } }),
  ];
  const boundary = new iam.ManagedPolicy(stack, 'RuntimePermissionsBoundary', {
    managedPolicyName: `${prefix}-runtime-boundary`, statements: runtimeStatements,
  });
  boundary.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const execution = new iam.Role(stack, 'StageCloudFormationExecutionRole', {
    roleName: `${prefix}-cfn-execution`, assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
    maxSessionDuration: cdk.Duration.hours(1),
  });
  const protectedRoles = [roleArn(`${prefix}-github-deploy`), roleArn(`${prefix}-cfn-execution`)];
  execution.addToPolicy(scoped(['iam:GetRole'], protectedRoles));
  execution.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.DENY, actions: ['iam:Create*', 'iam:Delete*', 'iam:Update*', 'iam:Put*', 'iam:Attach*', 'iam:Detach*', 'iam:Tag*', 'iam:Untag*', 'iam:PassRole'], resources: [...protectedRoles, boundaryArn],
  }));
  execution.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.DENY, actions: ['iam:DeleteRolePermissionsBoundary'], resources: ['*'],
  }));
  execution.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.DENY, actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'], resources: ['*'],
    conditions: { StringNotEquals: { 'iam:PermissionsBoundary': boundaryArn } },
  }));
  execution.addToPolicy(scoped(['iam:CreateRole', 'iam:PutRolePermissionsBoundary'], [roleArn(`${prefix}-runtime-*`)], { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } }));
  execution.addToPolicy(scoped([
    'iam:GetRole', 'iam:DeleteRole', 'iam:UpdateRole', 'iam:UpdateAssumeRolePolicy', 'iam:TagRole', 'iam:UntagRole',
    'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:GetRolePolicy', 'iam:ListRolePolicies',
    'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:ListAttachedRolePolicies',
  ], [roleArn(`${prefix}-runtime-*`)]));
  execution.addToPolicy(scoped(['iam:PassRole'], [roleArn(`${prefix}-runtime-*`)], { StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com', 'codedeploy.amazonaws.com'] } }));
  execution.addToPolicy(scoped(['iam:GetPolicy', 'iam:GetPolicyVersion'], [boundaryArn]));
  execution.addToPolicy(scoped(['lambda:*'], [functionArn, `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:layer:${prefix}-*`]));
  execution.addToPolicy(scoped(['dynamodb:*'], [tableArn, `${tableArn}/*`]));
  execution.addToPolicy(scoped(['cognito-idp:*'], [userPoolArn], userPoolConditions));
  execution.addToPolicy(scoped(['s3:*'], [webArn, `${webArn}/*`]));
  execution.addToPolicy(scoped(['s3:GetObject', 's3:GetBucketLocation', 's3:ListBucket'], [assetsArn, `${assetsArn}/*`]));
  execution.addToPolicy(scoped(['logs:*'], logResources));
  // These reads and control-plane actions do not support resource ARNs. Keep
  // them in one statement so the protected role stays below IAM's policy size
  // limit without widening any permission.
  execution.addToPolicy(scoped([
    'logs:DescribeLogGroups',
    'logs:DescribeResourcePolicies',
    'cloudwatch:DescribeAlarms',
    'cloudwatch:GetMetricData',
    'cloudwatch:GetMetricStatistics',
    'logs:PutResourcePolicy',
    'logs:DeleteResourcePolicy',
    'codedeploy:CreateCloudFormationDeployment',
    'codedeploy:StopDeployment',
    'secretsmanager:GetRandomPassword',
  ], ['*']));
  execution.addToPolicy(scoped(['cloudwatch:*'], [`arn:${stack.partition}:cloudwatch:${stack.region}:${stack.account}:alarm:${prefix}-*`]));
  execution.addToPolicy(scoped(['sns:*'], [`arn:${stack.partition}:sns:${stack.region}:${stack.account}:${prefix}-*`]));
  execution.addToPolicy(scoped(['codedeploy:*'], [arn('codedeploy', 'application', `${prefix}-*`).replace(':application/', ':application:'), arn('codedeploy', 'deploymentgroup', `${prefix}-*/*`).replace(':deploymentgroup/', ':deploymentgroup:'), arn('codedeploy', 'deploymentconfig', 'CodeDeployDefault.LambdaAllAtOnce').replace(':deploymentconfig/', ':deploymentconfig:')]));
  execution.addToPolicy(scoped(['secretsmanager:CreateSecret', 'secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret', 'secretsmanager:UpdateSecret', 'secretsmanager:TagResource', 'secretsmanager:UntagResource'], [secretArn]));
  const fixedCloudFrontResources = [
    distributionArn,
    inventory.originAccessControlId && arn('cloudfront', 'origin-access-control', inventory.originAccessControlId, ''),
    inventory.responseHeadersPolicyId && arn('cloudfront', 'response-headers-policy', inventory.responseHeadersPolicyId, ''),
    arn('cloudfront', 'function', `${prefix}-spa-rewrite`, ''),
  ].filter((value): value is string => Boolean(value));
  execution.addToPolicy(scoped(['cloudfront:*'], fixedCloudFrontResources));
  if (inventory.apiId) {
    const apiArn = `arn:${stack.partition}:apigateway:${stack.region}::/apis/${inventory.apiId}`;
    const apiTagArn = cdk.Fn.join('', [
      'arn:', stack.partition, ':apigateway:', stack.region,
      '::/tags/arn%3A', stack.partition, '%3Aapigateway%3A', stack.region,
      `%3A%3A%2Fapis%2F${inventory.apiId}`,
    ]);
    execution.addToPolicy(scoped(['apigateway:*'], [apiArn, `${apiArn}/*`, apiTagArn]));
  }
  if (inventory.certificateArn) execution.addToPolicy(scoped(['acm:*'], [inventory.certificateArn]));
  if (inventory.subscriptionArn) execution.addToPolicy(scoped(['pricingplanmanager:GetSubscription'], [inventory.subscriptionArn]));
  execution.addToPolicy(scoped(['wafv2:*'], [arn('wafv2', 'global/webacl', `${prefix}-flat-rate/*`)]));
  execution.addToPolicy(scoped(['route53:GetHostedZone', 'route53:ListResourceRecordSets'], [`arn:${stack.partition}:route53:::hostedzone/Z05088763QG63CC5SE7PN`]));
  execution.addToPolicy(scoped(['route53:GetChange'], [`arn:${stack.partition}:route53:::change/*`]));
  const domain = stage === 'prod' ? 'despensalista.lynxpardelle.com' : `${stage === 'tst' ? 'test' : 'dev'}.despensalista.lynxpardelle.com`;
  execution.addToPolicy(scoped(['route53:ChangeResourceRecordSets'], [`arn:${stack.partition}:route53:::hostedzone/Z05088763QG63CC5SE7PN`], {
    'ForAllValues:StringLike': { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': [domain, `_${'*'}.${domain}`, ...(stage === 'prod' ? [`*._domainkey.${domain}`] : [])] },
    'ForAllValues:StringEquals': { 'route53:ChangeResourceRecordSetsRecordTypes': ['A', 'AAAA', 'CNAME'], 'route53:ChangeResourceRecordSetsActions': ['CREATE', 'UPSERT', 'DELETE'] },
  }));
  if (stage === 'prod') execution.addToPolicy(scoped(['ses:GetEmailIdentity', 'ses:PutEmailIdentityDkimSigningAttributes', 'ses:PutEmailIdentityFeedbackAttributes', 'ses:PutEmailIdentityMailFromAttributes', 'ses:TagResource', 'ses:UntagResource', 'ses:ListTagsForResource'], [arn('ses', 'identity', domain)]));
  if (stage === 'prod') execution.addToPolicy(scoped([
    'events:PutRule',
    'events:DescribeRule',
    'events:ListTargetsByRule',
    'events:ListTagsForResource',
    'events:DeleteRule',
    'events:PutTargets',
    'events:RemoveTargets',
    'events:TagResource',
    'events:UntagResource',
  ], [arn('events', 'rule', `${prefix}-account-deletion-resume`)]));

  const oidc = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(stack, 'GitHubOidcProvider', arn('iam', 'oidc-provider', 'token.actions.githubusercontent.com', ''));
  const github = new iam.Role(stack, 'GitHubDeploymentRole', {
    roleName: `${prefix}-github-deploy`, maxSessionDuration: cdk.Duration.hours(1),
    assumedBy: new iam.OpenIdConnectPrincipal(oidc, { StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': `repo:LynxPardelle/despensalista:environment:${stage}`,
    } }),
  });
  github.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['sts:AssumeRole'], resources: ['*'] }));
  // Without this guard, omitting RoleARN could reuse an old administrator
  // service role saved on a bootstrapped CloudFormation stack.
  github.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['cloudformation:CreateChangeSet', 'cloudformation:ContinueUpdateRollback'], resources: ['*'], conditions: { StringNotEquals: { 'cloudformation:RoleArn': execution.roleArn } } }));
  github.addToPolicy(scoped(['cloudformation:CreateChangeSet', 'cloudformation:ExecuteChangeSet', 'cloudformation:Describe*', 'cloudformation:Get*', 'cloudformation:List*', 'cloudformation:DeleteChangeSet', 'cloudformation:ContinueUpdateRollback', 'cloudformation:UpdateTerminationProtection'], [arn('cloudformation', 'stack', `${prefix}-*/*`), arn('cloudformation', 'changeSet', `${prefix}-*/*`)]));
  github.addToPolicy(scoped(['cloudformation:ValidateTemplate', 'cloudformation:GetTemplateSummary'], ['*']));
  github.addToPolicy(scoped(['iam:PassRole'], [execution.roleArn], { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } }));
  github.addToPolicy(scoped(['ssm:GetParameter'], [arn('ssm', 'parameter', `${project}/${stage}/cdk-bootstrap-version`)]));
  github.addToPolicy(scoped(['s3:GetObject*', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket', 's3:GetBucketLocation'], [assetsArn, `${assetsArn}/*`, webArn, `${webArn}/*`]));
  github.addToPolicy(scoped(['lambda:GetAlias', 'lambda:UpdateAlias', 'lambda:ListVersionsByFunction', 'lambda:GetFunction', 'lambda:PublishVersion'], [functionArn]));
  const backendFunctionArn = `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:function:${prefix}-backend-api`;
  github.addToPolicy(scoped([
    'lambda:GetFunctionConcurrency',
    'lambda:GetFunctionConfiguration',
    'lambda:PutFunctionConcurrency',
    'lambda:DeleteFunctionConcurrency',
  ], [backendFunctionArn, `${backendFunctionArn}:*`]));
  if (stage === 'prod') {
    const usersTableArn = arn('dynamodb', 'table', `${prefix}-users`);
    github.addToPolicy(scoped([
      'ssm:GetParameter',
      'ssm:PutParameter',
    ], [arn('ssm', 'parameter', `${project}/prod/deployment-drain`)]));
    github.addToPolicy(scoped(['dynamodb:Scan'], [usersTableArn], {
      'ForAllValues:StringEquals': {
        'dynamodb:Attributes': ['pk', 'entityType', 'deleting'],
      },
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    }));
    github.addToPolicy(scoped(['dynamodb:DeleteItem'], [usersTableArn], {
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['PANTRY_QUOTA#*'],
      },
    }));
  }
  if (distributionArn) github.addToPolicy(scoped(['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'], [distributionArn]));
  new cdk.CfnOutput(stack, 'GitHubDeploymentRoleArn', { value: github.roleArn });
  new cdk.CfnOutput(stack, 'CloudFormationExecutionRoleArn', { value: execution.roleArn });
  new cdk.CfnOutput(stack, 'DeliveryAssetsBucketName', { value: assetsName });
  new cdk.CfnOutput(stack, 'RuntimePermissionsBoundaryArn', { value: boundaryArn });
}
