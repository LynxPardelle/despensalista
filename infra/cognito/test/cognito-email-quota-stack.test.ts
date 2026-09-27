import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DespensaListaCognitoStack } from '../lib/despensalista-cognito-stack';

type CloudFormationResource = {
  Type: string;
  Properties: Record<string, any>;
};

function synthesize(stage: 'dev' | 'tst' | 'prod'): Record<string, CloudFormationResource> {
  const app = new cdk.App({ context: { stage } });
  const stack = new DespensaListaCognitoStack(app, `Cognito-email-quota-${stage}`);

  return Template.fromStack(stack).toJSON().Resources;
}

function namedResource(
  resources: Record<string, CloudFormationResource>,
  type: string,
  property: string,
  value: string,
): CloudFormationResource {
  const resource = Object.values(resources).find(
    (candidate) => candidate.Type === type && candidate.Properties[property] === value,
  );

  assert.ok(resource, `${type} named ${value} must exist`);
  return resource;
}

test('each stage gets its conservative email budget without a one-slot concurrency choke', () => {
  const expected = {
    dev: { total: '2', recovery: '1', recipient: '1' },
    tst: { total: '3', recovery: '1', recipient: '2' },
    prod: { total: '30', recovery: '10', recipient: '5' },
  } as const;

  let aggregateDailyLimit = 0;
  for (const stage of ['dev', 'tst', 'prod'] as const) {
    const resources = synthesize(stage);
    const fn = namedResource(
      resources,
      'AWS::Lambda::Function',
      'FunctionName',
      `despensalista-${stage}-cognito-email-quota`,
    );
    const variables = fn.Properties.Environment.Variables;

    assert.equal(variables.DAILY_LIMIT, expected[stage].total);
    assert.equal(variables.RECOVERY_RESERVE, expected[stage].recovery);
    assert.equal(variables.RECIPIENT_LIMIT, expected[stage].recipient);
    assert.equal(fn.Properties.ReservedConcurrentExecutions, undefined);
    assert.equal(fn.Properties.MemorySize, 128);
    assert.equal(fn.Properties.Timeout, 4);
    aggregateDailyLimit += Number(variables.DAILY_LIMIT);

    const logGroup = namedResource(
      resources,
      'AWS::Logs::LogGroup',
      'LogGroupName',
      `/aws/lambda/despensalista-${stage}-cognito-email-quota`,
    );
    assert.equal(logGroup.Properties.RetentionInDays, stage === 'prod' ? 30 : 7);
  }

  assert.equal(aggregateDailyLimit, 35);
});

test('quota counters are atomic on-demand DynamoDB records with TTL', () => {
  const resources = synthesize('prod');
  const table = namedResource(
    resources,
    'AWS::DynamoDB::Table',
    'TableName',
    'despensalista-prod-cognito-email-quota',
  );

  assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST');
  assert.deepEqual(table.Properties.KeySchema, [
    { AttributeName: 'key', KeyType: 'HASH' },
  ]);
  assert.deepEqual(table.Properties.TimeToLiveSpecification, {
    AttributeName: 'expiresAt',
    Enabled: true,
  });

  const statements = Object.values(resources)
    .filter((resource) => resource.Type === 'AWS::IAM::Policy')
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement);
  const quotaWrite = statements.find((statement: any) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.includes('dynamodb:TransactWriteItems');
  });

  assert.ok(quotaWrite);
  assert.doesNotMatch(JSON.stringify(quotaWrite.Resource), /\*/);
});

test('Cognito invokes only the bounded CustomMessage Lambda role', () => {
  const resources = synthesize('prod');
  const userPool = Object.values(resources).find(
    (resource) => resource.Type === 'AWS::Cognito::UserPool',
  );
  const fn = namedResource(
    resources,
    'AWS::Lambda::Function',
    'FunctionName',
    'despensalista-prod-cognito-email-quota',
  );
  const fnLogicalId = Object.keys(resources).find((key) => resources[key] === fn);
  const userPoolLogicalId = Object.keys(resources).find((key) => resources[key] === userPool);
  const role = namedResource(
    resources,
    'AWS::IAM::Role',
    'RoleName',
    'despensalista-prod-runtime-cognito-email-quota',
  );
  const permission = Object.values(resources).find(
    (resource) =>
      resource.Type === 'AWS::Lambda::Permission'
      && resource.Properties.Principal === 'cognito-idp.amazonaws.com',
  );

  assert.ok(userPool);
  assert.deepEqual(userPool.Properties.LambdaConfig, {
    CustomMessage: { 'Fn::GetAtt': [fnLogicalId, 'Arn'] },
  });
  const boundaryLogicalId = role.Properties.PermissionsBoundary.Ref;
  assert.equal(
    resources[boundaryLogicalId].Properties.ManagedPolicyName,
    'despensalista-prod-runtime-boundary',
  );
  assert.ok(permission);
  assert.equal(permission.Properties.Action, 'lambda:InvokeFunction');
  assert.deepEqual(permission.Properties.FunctionName, {
    'Fn::GetAtt': [fnLogicalId, 'Arn'],
  });
  assert.deepEqual(permission.Properties.SourceArn, {
    'Fn::GetAtt': [userPoolLogicalId, 'Arn'],
  });
});

test('delivery IAM scopes Cognito by stage tags without depending on the user pool', () => {
  const resources = synthesize('prod');
  const userPool = Object.values(resources).find(
    (resource) => resource.Type === 'AWS::Cognito::UserPool',
  );
  assert.ok(userPool);
  assert.deepEqual(userPool.Properties.UserPoolTags, {
    Project: 'despensalista',
    Stage: 'prod',
  });

  const statements = Object.values(resources)
    .filter((resource) =>
      resource.Type === 'AWS::IAM::Policy'
      || resource.Type === 'AWS::IAM::ManagedPolicy',
    )
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement)
    .filter((statement: any) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.some((action: string) => action.startsWith('cognito-idp:'));
    });

  assert.equal(statements.length >= 2, true);
  for (const statement of statements) {
    assert.match(JSON.stringify(statement.Resource), /:userpool\/\*/);
    assert.doesNotMatch(JSON.stringify(statement.Resource), /UserPool/);
    assert.deepEqual(statement.Condition, {
      StringEquals: {
        'aws:ResourceTag/Project': 'despensalista',
        'aws:ResourceTag/Stage': 'prod',
      },
    });
  }
});

test('only production has a no-action Lambda Errors alarm and no WAF resource', () => {
  const prod = synthesize('prod');
  const dev = synthesize('dev');
  const alarm = namedResource(
    prod,
    'AWS::CloudWatch::Alarm',
    'AlarmName',
    'despensalista-prod-cognito-email-quota-errors',
  );

  assert.equal(alarm.Properties.Namespace, 'AWS/Lambda');
  assert.equal(alarm.Properties.MetricName, 'Errors');
  assert.equal(alarm.Properties.Threshold, 1);
  assert.equal(alarm.Properties.AlarmActions, undefined);
  assert.equal(
    Object.values(dev).filter((resource) => resource.Type === 'AWS::CloudWatch::Alarm').length,
    0,
  );
  assert.equal(
    Object.values(prod).some((resource) => resource.Type.includes('WAF')),
    false,
  );
});
