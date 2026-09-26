import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DespensaListaServerlessBackendStack } from '../lib/despensalista-serverless-backend-stack';

function synthesizeProductionTemplate(): Template {
  const app = new cdk.App({
    context: {
      stage: 'prod',
      serverlessFrontendBaseUrl: 'https://despensalista.example',
      appDomainName: 'despensalista.example',
      hostedZoneId: 'Z1234567890',
      hostedZoneName: 'example',
      enableFlatRateWaf: 'true',
      backendArtifactPath: __dirname,
      frontendArtifactPath: __dirname,
    },
  });
  const stack = new DespensaListaServerlessBackendStack(app, 'Backend-prod', {
    allowedProviders: ['COGNITO'],
    cognitoDomain: 'https://auth.example',
    cognitoUserPoolClientId: 'client-id',
    cognitoUserPoolId: 'us-east-1_example',
  });

  return Template.fromStack(stack);
}

const productionTemplate = synthesizeProductionTemplate();

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

test('production publishes an aliased Lambda with canary rollback controls', () => {
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

test('test stage shares only the nonproduction origin secret and has no paid alarms', () => {
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
  template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  template.resourceCountIs('AWS::PricingPlanManager::Subscription', 0);
  assert.match(JSON.stringify(template.toJSON()), /despensalista\/nonprod\/cloudfront-origin-verification/);
  assert.doesNotMatch(JSON.stringify(template.toJSON()), /despensalista\/prod\/cloudfront-origin-verification/);
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
