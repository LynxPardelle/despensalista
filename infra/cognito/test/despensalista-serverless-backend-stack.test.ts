import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DespensaListaServerlessBackendStack } from '../lib/despensalista-serverless-backend-stack';

function synthesizeTemplate(stage: 'dev' | 'tst' | 'prod'): Template {
  const app = new cdk.App({
    context: {
      stage,
      serverlessFrontendBaseUrl: 'https://despensalista.example',
      appDomainName: 'despensalista.example',
      hostedZoneId: 'Z1234567890',
      hostedZoneName: 'example',
      enableFlatRateWaf: stage === 'prod' ? 'true' : 'false',
      backendArtifactPath: __dirname,
      frontendArtifactPath: __dirname,
      releaseId: 'a'.repeat(12),
    },
  });
  const stack = new DespensaListaServerlessBackendStack(app, `Backend-${stage}`, {
    allowedProviders: ['COGNITO'],
    cognitoDomain: 'https://auth.example',
    cognitoUserPoolClientId: 'client-id',
    cognitoUserPoolId: 'us-east-1_example',
  });

  return Template.fromStack(stack);
}

const productionTemplate = synthesizeTemplate('prod');

test('production Lambda does not trust X-Forwarded-For for rate-limit identity', () => {
  const functions = productionTemplate.findResources(
    'AWS::Lambda::Function',
  );
  const backend = Object.values(functions).find(
    (resource) =>
      resource.Properties?.Environment?.Variables?.RATE_LIMIT_ENABLED === 'true',
  );

  if (!backend) {
    assert.fail('Expected the backend Lambda resource');
  }
  assert.equal(
    backend.Properties.Environment.Variables.RATE_LIMIT_TRUST_PROXY,
    'false',
  );
});

test('production infrastructure exposes idempotency headers and atomic DynamoDB IAM', () => {
  productionTemplate.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    CorsConfiguration: {
      AllowHeaders: [
        'authorization',
        'content-type',
        'idempotency-key',
        'x-xsrf-token',
        'x-metrics-token',
      ],
      ExposeHeaders: ['idempotency-key', 'idempotency-replayed'],
    },
  });

  const policies = JSON.stringify(
    productionTemplate.findResources('AWS::IAM::Policy'),
  );
  assert.match(policies, /dynamodb:TransactWriteItems/);
  assert.match(policies, /cognito-idp:AdminDeleteUser/);
  assert.doesNotMatch(policies, /cognito-idp:ListUsers/);
  for (const tableName of [
    'despensalista-prod-users',
    'despensalista-prod-products',
    'despensalista-prod-product-types',
    'despensalista-prod-inventory-lots',
  ]) {
    assert.match(JSON.stringify(productionTemplate.toJSON()), new RegExp(tableName));
  }
});

test('production infrastructure has bounded logs and no more than four alarms', () => {
  productionTemplate.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    AccessLogSettings: {
      DestinationArn: {},
      Format: Match.stringLikeRegexp('"requestId":"\\$context.requestId"'),
    },
  });
  const logGroups = productionTemplate.findResources('AWS::Logs::LogGroup');
  assert.ok(Object.keys(logGroups).length >= 1);
  for (const resource of Object.values(logGroups)) {
    assert.ok(resource.Properties?.RetentionInDays <= 30);
  }
  productionTemplate.hasResourceProperties('Custom::LogRetention', {
    LogGroupName: '/aws/lambda/despensalista-prod-backend-api',
    RetentionInDays: 30,
  });
  assert.equal(
    Object.keys(productionTemplate.findResources('AWS::CloudWatch::Alarm')).length,
    4,
  );
  assert.equal(
    Object.keys(productionTemplate.findResources('AWS::SNS::Topic')).length,
    1,
  );
  assert.equal(
    Object.keys(productionTemplate.findResources('AWS::SNS::Subscription')).length,
    0,
  );
});

test('production publishes an aliased Lambda with all-at-once rollback controls', () => {
  assert.equal(
    Object.keys(productionTemplate.findResources('AWS::Lambda::Alias')).length,
    1,
  );
  assert.ok(
    Object.keys(productionTemplate.findResources('AWS::Lambda::Version')).length >= 1,
  );
  productionTemplate.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
    AutoRollbackConfiguration: {
      Enabled: true,
    },
    DeploymentConfigName: 'CodeDeployDefault.LambdaAllAtOnce',
    DeploymentGroupName: 'despensalista-prod-backend-release',
  });
  const [deploymentGroup] = Object.values(
    productionTemplate.findResources('AWS::CodeDeploy::DeploymentGroup'),
  );
  assert.equal(deploymentGroup.Properties.AlarmConfiguration.Alarms.length, 1);
  productionTemplate.hasOutput('PantryQuotaSchemaVersion', { Value: '2' });
  productionTemplate.hasOutput('DeploymentReleaseId', { Value: 'a'.repeat(12) });
});

test('production resumes account deletion through the live alias every fifteen minutes', () => {
  synthesizeTemplate('dev').resourceCountIs('AWS::Events::Rule', 0);
  synthesizeTemplate('tst').resourceCountIs('AWS::Events::Rule', 0);

  const rules = productionTemplate.findResources('AWS::Events::Rule');
  assert.equal(Object.keys(rules).length, 1);
  const [ruleId, rule] = Object.entries(rules)[0];
  assert.equal(rule.Properties.Name, 'despensalista-prod-account-deletion-resume');
  assert.equal(rule.Properties.ScheduleExpression, 'rate(15 minutes)');
  assert.equal(rule.Properties.Targets.length, 1);
  const [target] = rule.Properties.Targets;
  assert.equal(target.Input, JSON.stringify({
    source: 'despensalista.account-deletion-worker',
    'detail-type': 'resume',
  }));
  assert.deepEqual(target.RetryPolicy, {
    MaximumEventAgeInSeconds: 300,
    MaximumRetryAttempts: 0,
  });
  const aliases = productionTemplate.findResources('AWS::Lambda::Alias');
  const [aliasId, alias] = Object.entries(aliases)[0];
  assert.equal(alias.Properties.Name, 'live');
  assert.deepEqual(target.Arn, { Ref: aliasId });

  const permissions = Object.values(
    productionTemplate.findResources('AWS::Lambda::Permission'),
  ).filter((resource) => resource.Properties.Principal === 'events.amazonaws.com');
  assert.equal(permissions.length, 1);
  assert.deepEqual(permissions[0].Properties.FunctionName, target.Arn);
  assert.deepEqual(permissions[0].Properties.SourceArn, {
    'Fn::GetAtt': [ruleId, 'Arn'],
  });
});

test('production protects the API origin and prepares a five-rule flat-rate WAF', () => {
  assert.equal(
    Object.keys(productionTemplate.findResources('AWS::SecretsManager::Secret')).length,
    1,
  );
  const serialized = JSON.stringify(productionTemplate.toJSON());
  assert.match(serialized, /ORIGIN_VERIFY_HEADER_NAME/);
  assert.match(serialized, /ORIGIN_VERIFY_HEADER_VALUE/);
  assert.match(serialized, /x-despensalista-origin-verify/);

  const webAcls = productionTemplate.findResources('AWS::WAFv2::WebACL');
  assert.equal(Object.keys(webAcls).length, 1);
  const [webAcl] = Object.values(webAcls);
  assert.equal(webAcl.Properties?.Rules?.length, 5);
  productionTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: {
      WebACLId: {},
    },
  });
  productionTemplate.hasResourceProperties('AWS::PricingPlanManager::Subscription', {
    PlanFamily: 'CloudFront', PlanTier: 'FREE', UsageLevel: 'DEFAULT',
  });
  for (const resource of Object.values(webAcls)) {
    assert.equal(resource.DeletionPolicy, 'Delete');
  }
});

test('test stage owns and retains an isolated origin secret with no paid alarms', () => {
  const app = new cdk.App({ context: {
    stage: 'tst', backendArtifactPath: __dirname, frontendArtifactPath: __dirname,
    serverlessFrontendBaseUrl: 'https://test.despensalista.example',
    appDomainName: 'test.despensalista.example',
  } });
  const stack = new DespensaListaServerlessBackendStack(app, 'Backend-tst', {
    allowedProviders: ['COGNITO'], cognitoDomain: 'https://auth.example',
    cognitoUserPoolClientId: 'client', cognitoUserPoolId: 'pool',
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'despensalista/tst/cloudfront-origin-verification',
  });
  template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  template.resourceCountIs('AWS::PricingPlanManager::Subscription', 0);
  const serialized = JSON.stringify(template.toJSON());
  assert.match(serialized, /despensalista\/tst\/cloudfront-origin-verification/);
  assert.doesNotMatch(serialized, /despensalista\/nonprod\/cloudfront-origin-verification/);
  assert.doesNotMatch(serialized, /despensalista\/dev\/cloudfront-origin-verification/);
  assert.doesNotMatch(JSON.stringify(template.toJSON()), /despensalista\/prod\/cloudfront-origin-verification/);
  const [secret] = Object.values(template.findResources('AWS::SecretsManager::Secret'));
  assert.equal(secret.DeletionPolicy, 'Retain');
  assert.equal(secret.UpdateReplacePolicy, 'Retain');
});

test('development and production own only their stage origin secrets', () => {
  for (const [stage, template] of [
    ['dev', (() => {
      const app = new cdk.App({ context: {
        stage: 'dev', backendArtifactPath: __dirname, frontendArtifactPath: __dirname,
        serverlessFrontendBaseUrl: 'https://dev.despensalista.example',
        appDomainName: 'dev.despensalista.example',
      } });
      return Template.fromStack(new DespensaListaServerlessBackendStack(app, 'Backend-dev', {
        allowedProviders: ['COGNITO'], cognitoDomain: 'https://auth.example',
        cognitoUserPoolClientId: 'client', cognitoUserPoolId: 'pool',
      }));
    })()],
    ['prod', productionTemplate],
  ] as const) {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `despensalista/${stage}/cloudfront-origin-verification`,
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.doesNotMatch(serialized, /despensalista\/nonprod\/cloudfront-origin-verification/);
  }
});

test('production retains versioned web assets and deletion-protected tables', () => {
  productionTemplate.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: {
      Status: 'Enabled',
    },
  });
  const tables = productionTemplate.findResources('AWS::DynamoDB::Table');
  assert.equal(Object.keys(tables).length, 4);
  for (const table of Object.values(tables)) {
    assert.equal(table.Properties?.DeletionProtectionEnabled, true);
  }
  const archivedIndexes = Object.values(tables)
    .flatMap((table) => table.Properties?.GlobalSecondaryIndexes ?? [])
    .filter((index) => index.IndexName === 'UserArchivedAtIndex');
  assert.equal(archivedIndexes.length, 2);
  for (const index of archivedIndexes) {
    assert.deepEqual(index.KeySchema, [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'archivedAt', KeyType: 'RANGE' },
    ]);
  }
});

test('every runtime/helper role uses the protected stage boundary and namespaced layers', () => {
  for (const resource of Object.values(productionTemplate.findResources('AWS::IAM::Role'))) {
    assert.match(JSON.stringify(resource.Properties.PermissionsBoundary), /despensalista-prod-runtime-boundary/);
  }
  for (const resource of Object.values(productionTemplate.findResources('AWS::Lambda::LayerVersion'))) {
    assert.equal(resource.Properties.LayerName, 'despensalista-prod-web-deploy-cli');
  }
  const stage = Object.values(productionTemplate.findResources('AWS::ApiGatewayV2::Stage'))[0];
  assert.doesNotMatch(stage.Properties.AccessLogSettings.Format, /integrationErrorMessage|queryString|cookie|authorization/i);
});
