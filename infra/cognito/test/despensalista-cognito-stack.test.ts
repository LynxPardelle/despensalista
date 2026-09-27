import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DespensaListaCognitoStack } from '../lib/despensalista-cognito-stack';

interface UserPoolClientProperties {
  CallbackURLs: string[];
  LogoutURLs: string[];
}

function synthesizeUserPoolClient(
  stage: string,
  extraContext: Record<string, string> = {},
): UserPoolClientProperties {
  const app = new cdk.App({
    context: {
      stage,
      localFrontendBaseUrl: 'http://localhost:48673',
      productionFrontendBaseUrl: 'https://despensalista.example',
      ...extraContext,
    },
  });
  const stack = new DespensaListaCognitoStack(app, `Cognito-${stage}`);
  const resources = Template.fromStack(stack).findResources(
    'AWS::Cognito::UserPoolClient',
  );
  const [resource] = Object.values(resources);

  assert.ok(resource);
  return resource.Properties as UserPoolClientProperties;
}

test('production Cognito client excludes every localhost callback and logout URL', () => {
  const client = synthesizeUserPoolClient('prod', {
    extraCallbackUrls:
      'http://localhost:9000/api/auth/cognito/callback,https://admin.example/callback',
    extraLogoutUrls: 'http://localhost:9000/login,https://admin.example/login',
  });

  assert.equal(
    [...client.CallbackURLs, ...client.LogoutURLs].some((url) =>
      url.includes('localhost'),
    ),
    false,
  );
  assert.ok(
    client.CallbackURLs.includes(
      'https://despensalista.example/api/auth/cognito/callback',
    ),
  );
  assert.ok(client.LogoutURLs.includes('https://despensalista.example/login'));
});

test('production Cognito template omits the localhost callback output', () => {
  const app = new cdk.App({
    context: {
      stage: 'prod',
      localFrontendBaseUrl: 'http://localhost:48673',
      productionFrontendBaseUrl: 'https://despensalista.example',
    },
  });
  const stack = new DespensaListaCognitoStack(app, 'Cognito-prod-output');
  const outputs = Template.fromStack(stack).toJSON().Outputs ?? {};

  assert.equal(JSON.stringify(outputs).includes('localhost'), false);
});

test('development Cognito client includes localhost callback and logout URLs', () => {
  const client = synthesizeUserPoolClient('dev');

  assert.ok(
    client.CallbackURLs.includes(
      'http://localhost:48673/api/auth/cognito/callback',
    ),
  );
  assert.ok(client.LogoutURLs.includes('http://localhost:48673/login'));
});

test('production requires software-token MFA and protects the user pool', () => {
  const app = new cdk.App({
    context: {
      stage: 'prod',
      productionFrontendBaseUrl: 'https://despensalista.lynxpardelle.com',
      hostedZoneId: 'Z1234567890',
      hostedZoneName: 'lynxpardelle.com',
      sesIdentityDomain: 'despensalista.lynxpardelle.com',
    },
  });
  const stack = new DespensaListaCognitoStack(app, 'Cognito-prod-security');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::Cognito::UserPool', {
    DeletionProtection: 'ACTIVE',
    EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    MfaConfiguration: 'ON',
  });
  const userPool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0] as any;
  assert.deepEqual(userPool.Properties.EmailConfiguration, {
    EmailSendingAccount: 'COGNITO_DEFAULT',
  });
});

test('managed-mail sender policy permits only the verified identity and production pool', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ses-cognito-sender-policy.json'), 'utf8'));
  assert.equal(policy.Statement.length, 1);
  assert.deepEqual(policy.Statement[0].Principal, { Service: 'email.cognito-idp.amazonaws.com' });
  assert.equal(policy.Statement[0].Condition.ArnEquals['aws:SourceArn'], 'arn:aws:cognito-idp:us-east-1:765932874577:userpool/us-east-1_BmNImLALI');
  assert.equal(policy.Statement[0].Condition.StringEquals['ses:FromAddress'], 'no-reply@despensalista.lynxpardelle.com');
  assert.equal(policy.Statement[0].Resource, 'arn:aws:ses:us-east-1:765932874577:identity/despensalista.lynxpardelle.com');
});

test('production creates the DespensaLista SES identity and Easy DKIM records', () => {
  const app = new cdk.App({
    context: {
      stage: 'prod',
      productionFrontendBaseUrl: 'https://despensalista.lynxpardelle.com',
      hostedZoneId: 'Z1234567890',
      hostedZoneName: 'lynxpardelle.com',
      sesIdentityDomain: 'despensalista.lynxpardelle.com',
    },
  });
  const stack = new DespensaListaCognitoStack(app, 'Cognito-prod-ses');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::SES::EmailIdentity', {
    EmailIdentity: 'despensalista.lynxpardelle.com',
  });
  assert.equal(
    Object.keys(template.findResources('AWS::Route53::RecordSet')).length,
    3,
  );
});

test('deployment OIDC trust is exact repository and environment, with no bootstrap deploy-role escalation', () => {
  const app = new cdk.App({ context: { stage: 'tst' } });
  const template = Template.fromStack(new DespensaListaCognitoStack(app, 'Cognito-trust'));
  const roles = template.findResources('AWS::IAM::Role');
  const role = Object.values(roles).find((resource) => resource.Properties.RoleName === 'despensalista-tst-github-deploy')!;
  const trust = role.Properties.AssumeRolePolicyDocument.Statement[0];
  assert.deepEqual(trust.Condition.StringEquals, {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': 'repo:LynxPardelle/despensalista:environment:tst',
  });
  assert.doesNotMatch(JSON.stringify(template.toJSON().Resources), /cdk-hnb659fds/);
  template.hasResourceProperties('AWS::Cognito::UserPool', { MfaConfiguration: 'ON' });
});

test('GitHub delivery drains only its exact backend and only production deletes quota keys', () => {
  const statementsFor = (stage: 'dev' | 'tst' | 'prod') => {
    const app = new cdk.App({ context: { stage } });
    const template = Template.fromStack(
      new DespensaListaCognitoStack(app, `Cognito-${stage}-cutover-iam`),
    ).toJSON();
    return Object.values(template.Resources)
      .filter(
        (resource: any) =>
          resource.Type === 'AWS::IAM::Policy' &&
          JSON.stringify(resource.Properties.Roles).includes(
            'GitHubDeploymentRole',
          ),
      )
      .flatMap(
        (resource: any) => resource.Properties.PolicyDocument.Statement,
      );
  };

  for (const stage of ['dev', 'tst'] as const) {
    const statements = statementsFor(stage);
    const concurrency = statements.find((statement: any) =>
      Array.isArray(statement.Action) &&
      statement.Action.includes('lambda:PutFunctionConcurrency'),
    );
    assert.match(
      JSON.stringify(concurrency.Resource),
      new RegExp(`function:despensalista-${stage}-backend-api`),
    );
    assert.doesNotMatch(JSON.stringify(concurrency.Resource), /backend-api\*/);
    const serialized = JSON.stringify(statements);
    assert.doesNotMatch(serialized, /PANTRY_QUOTA#/);
    assert.doesNotMatch(serialized, /deployment-drain/);
  }

  const productionStatements = statementsFor('prod');
  const concurrency = productionStatements.find((statement: any) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('lambda:PutFunctionConcurrency'),
  );
  assert.deepEqual(concurrency.Action, [
    'lambda:GetFunctionConcurrency',
    'lambda:GetFunctionConfiguration',
    'lambda:PutFunctionConcurrency',
    'lambda:DeleteFunctionConcurrency',
  ]);
  assert.match(
    JSON.stringify(concurrency.Resource),
    /function:despensalista-prod-backend-api/,
  );
  assert.doesNotMatch(JSON.stringify(concurrency.Resource), /backend-api\*/);

  const drainMarker = productionStatements.find((statement: any) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('ssm:PutParameter'),
  );
  assert.deepEqual(drainMarker.Action, [
    'ssm:GetParameter',
    'ssm:PutParameter',
  ]);
  assert.match(JSON.stringify(drainMarker.Resource), /parameter\/despensalista\/prod\/deployment-drain/);

  const scan = productionStatements.find(
    (statement: any) => statement.Action === 'dynamodb:Scan',
  );
  assert.match(
    JSON.stringify(scan.Resource),
    /table\/despensalista-prod-users/,
  );
  assert.deepEqual(scan.Condition, {
    'ForAllValues:StringEquals': {
      'dynamodb:Attributes': ['pk', 'entityType', 'deleting'],
    },
    StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
  });

  const deleteQuota = productionStatements.find(
    (statement: any) => statement.Action === 'dynamodb:DeleteItem',
  );
  assert.match(
    JSON.stringify(deleteQuota.Resource),
    /table\/despensalista-prod-users/,
  );
  assert.deepEqual(deleteQuota.Condition, {
    'ForAllValues:StringLike': {
      'dynamodb:LeadingKeys': ['PANTRY_QUOTA#*'],
    },
  });
});

test('only the production CloudFormation executor can manage the exact resume rule', () => {
  const statementsFor = (stage: 'dev' | 'tst' | 'prod') => {
    const app = new cdk.App({ context: { stage } });
    const template = Template.fromStack(
      new DespensaListaCognitoStack(app, `Cognito-${stage}-resume-rule-iam`),
    ).toJSON();
    return Object.values(template.Resources)
      .filter(
        (resource: any) =>
          resource.Type === 'AWS::IAM::Policy' &&
          JSON.stringify(resource.Properties.Roles).includes(
            'StageCloudFormationExecutionRole',
          ),
      )
      .flatMap(
        (resource: any) => resource.Properties.PolicyDocument.Statement,
      );
  };

  for (const stage of ['dev', 'tst'] as const) {
    assert.doesNotMatch(JSON.stringify(statementsFor(stage)), /events:PutRule/);
  }

  const statement = statementsFor('prod').find(
    (candidate: any) =>
      Array.isArray(candidate.Action) &&
      candidate.Action.includes('events:PutRule'),
  );
  assert.deepEqual(statement.Action, [
    'events:PutRule',
    'events:DescribeRule',
    'events:ListTargetsByRule',
    'events:ListTagsForResource',
    'events:DeleteRule',
    'events:PutTargets',
    'events:RemoveTargets',
    'events:TagResource',
    'events:UntagResource',
  ]);
  assert.match(
    JSON.stringify(statement.Resource),
    /rule\/despensalista-prod-account-deletion-resume/,
  );
  assert.doesNotMatch(JSON.stringify(statement.Resource), /resume\*/);
});

test('delivery controls require a protected stage boundary and only unavoidable global actions', () => {
  const app = new cdk.App({ context: { stage: 'dev' } });
  const template = Template.fromStack(new DespensaListaCognitoStack(app, 'Cognito-boundary')).toJSON();
  const serialized = JSON.stringify(template);
  assert.match(serialized, /despensalista-dev-runtime-boundary/);
  assert.match(serialized, /despensalista-dev-cfn-execution/);
  assert.match(serialized, /iam:PermissionsBoundary/);
  assert.match(serialized, /iam:DeleteRolePermissionsBoundary/);
  assert.match(serialized, /route53:ChangeResourceRecordSetsNormalizedRecordNames/);
  assert.doesNotMatch(serialized, /AdministratorAccess|pricingplanmanager:CreateSubscription|cloudfront:CreateOriginAccessControl/);
  assert.doesNotMatch(serialized, /%24%7BToken/);
  const permissionPolicies = Object.values(template.Resources).filter((value: any) => value.Type === 'AWS::IAM::Policy');
  assert.doesNotMatch(JSON.stringify(permissionPolicies), /"Action":"sts:AssumeRole","Effect":"Allow"/);
  const globalAllowActions = permissionPolicies
    .filter((policy: any) =>
      JSON.stringify(policy.Properties.Roles).includes(
        'StageCloudFormationExecutionRole',
      ),
    )
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
    .filter(
      (statement: any) =>
        statement.Effect === 'Allow' && statement.Resource === '*',
    )
    .flatMap((statement: any) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    )
    .sort();
  assert.deepEqual(globalAllowActions, [
    'cloudwatch:DescribeAlarms',
    'cloudwatch:GetMetricData',
    'cloudwatch:GetMetricStatistics',
    'codedeploy:CreateCloudFormationDeployment',
    'codedeploy:StopDeployment',
    'logs:DeleteResourcePolicy',
    'logs:DescribeLogGroups',
    'logs:DescribeResourcePolicies',
    'logs:PutResourcePolicy',
    'secretsmanager:GetRandomPassword',
  ].sort());
});

test('runtime boundary permits CodeDeploy to inspect and move only stage aliases', () => {
  const app = new cdk.App({ context: { stage: 'prod' } });
  const template = Template.fromStack(
    new DespensaListaCognitoStack(app, 'Cognito-prod-codedeploy-boundary'),
  ).toJSON();
  const managedPolicies = Object.values(template.Resources)
    .filter((value: any) => value.Type === 'AWS::IAM::ManagedPolicy');
  const statement = managedPolicies
    .flatMap((value: any) => value.Properties.PolicyDocument.Statement)
    .find((candidate: any) => {
      const actions = Array.isArray(candidate.Action)
        ? candidate.Action
        : [candidate.Action];
      return actions.includes('lambda:GetProvisionedConcurrencyConfig');
    });

  assert.ok(statement);
  assert.match(JSON.stringify(statement.Resource), /function:despensalista-prod-\*/);
  assert.match(JSON.stringify(statement.Resource), /function:despensalista-prod-\*:\*/);
  assert.doesNotMatch(JSON.stringify(statement.Resource), /function:\*/);
});

test('CloudFormation execution may read only the exact protected delivery roles', () => {
  const app = new cdk.App({ context: { stage: 'dev' } });
  const template = Template.fromStack(new DespensaListaCognitoStack(app, 'Cognito-execution-role-read')).toJSON();
  const statements = Object.values(template.Resources)
    .filter((value: any) => value.Type === 'AWS::IAM::Policy')
    .flatMap((value: any) => value.Properties.PolicyDocument.Statement);
  const protectedRoleRead = statements.find((statement: any) =>
    statement.Effect === 'Allow'
      && statement.Action === 'iam:GetRole'
      && JSON.stringify(statement.Resource).includes('role/despensalista-dev-cfn-execution'));

  assert.ok(protectedRoleRead);
  assert.match(JSON.stringify(protectedRoleRead.Resource), /role\/despensalista-dev-github-deploy/);
  assert.doesNotMatch(JSON.stringify(protectedRoleRead.Resource), /\*/);
});

test('CloudFormation execution may access only its stage origin secret', () => {
  for (const stage of ['dev', 'tst', 'prod'] as const) {
    const app = new cdk.App({ context: { stage } });
    const template = Template.fromStack(
      new DespensaListaCognitoStack(app, `Cognito-${stage}-origin-secret`),
    ).toJSON();
    const secretStatements = Object.values(template.Resources)
      .filter((value: any) => value.Type === 'AWS::IAM::Policy')
      .flatMap((value: any) => value.Properties.PolicyDocument.Statement)
      .filter((statement: any) => {
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        return actions.includes('secretsmanager:GetSecretValue');
    });

    assert.equal(secretStatements.length, 1);
    assert.ok(secretStatements[0].Action.includes('secretsmanager:CreateSecret'));
    const resourceParts = secretStatements[0].Resource['Fn::Join'][1];
    assert.equal(
      resourceParts.at(-1),
      `:secret:despensalista/${stage}/cloudfront-origin-verification-*`,
    );
    assert.doesNotMatch(JSON.stringify(secretStatements[0]), /\/nonprod\//);
    const randomPasswordStatements = Object.values(template.Resources)
      .filter((value: any) => value.Type === 'AWS::IAM::Policy')
      .flatMap((value: any) => value.Properties.PolicyDocument.Statement)
      .filter((statement: any) => {
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        return actions.includes('secretsmanager:GetRandomPassword');
      });
    assert.equal(randomPasswordStatements.length, 1);
    assert.equal(randomPasswordStatements[0].Resource, '*');
  }
});

test('runtime identity cleanup can only resolve and administer tagged user pools', () => {
  const app = new cdk.App({ context: { stage: 'prod' } });
  const template = Template.fromStack(
    new DespensaListaCognitoStack(app, 'Cognito-prod-no-user-enumeration'),
  ).toJSON();
  const boundary = Object.values(template.Resources).find(
    (resource: any) =>
      resource.Type === 'AWS::IAM::ManagedPolicy' &&
      resource.Properties.ManagedPolicyName ===
        'despensalista-prod-runtime-boundary',
  ) as any;
  assert.ok(boundary);
  const cognitoStatement = boundary.Properties.PolicyDocument.Statement.find(
    (statement: any) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('cognito-idp:ListUsers');
    },
  );
  assert.ok(cognitoStatement);
  assert.deepEqual([...cognitoStatement.Action].sort(), [
    'cognito-idp:AdminDeleteUser',
    'cognito-idp:AdminUserGlobalSignOut',
    'cognito-idp:ListUsers',
  ]);
  assert.match(JSON.stringify(cognitoStatement.Resource), /:userpool\/\*/);
  assert.deepEqual(cognitoStatement.Condition, {
    StringEquals: {
      'aws:ResourceTag/Project': 'despensalista',
      'aws:ResourceTag/Stage': 'prod',
    },
  });
});

test('production retains deploy assets needed by CloudFormation rollback', () => {
  const lifecycleFor = (stage: 'dev' | 'prod') => {
    const app = new cdk.App({ context: { stage } });
    const template = Template.fromStack(
      new DespensaListaCognitoStack(app, `Cognito-${stage}-asset-retention`),
    ).toJSON();
    const bucket = Object.entries(template.Resources).find(
      ([logicalId, resource]: [string, any]) =>
        logicalId.startsWith('DeliveryAssetsBucket') && resource.Type === 'AWS::S3::Bucket',
    )?.[1] as any;
    assert.ok(bucket);
    return bucket.Properties.LifecycleConfiguration.Rules[0];
  };

  assert.equal(lifecycleFor('prod').ExpirationInDays, undefined);
  assert.equal(lifecycleFor('dev').ExpirationInDays, 90);
});

test('CloudFormation can manage the account-level API access-log policy', () => {
  const app = new cdk.App({ context: { stage: 'prod' } });
  const template = Template.fromStack(
    new DespensaListaCognitoStack(app, 'Cognito-prod-log-policy'),
  ).toJSON();
  const statements = Object.values(template.Resources)
    .filter((value: any) => value.Type === 'AWS::IAM::Policy')
    .flatMap((value: any) => value.Properties.PolicyDocument.Statement)
    .filter((statement: any) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('logs:PutResourcePolicy');
    });

  assert.equal(statements.length, 1);
  assert.ok(statements[0].Action.includes('logs:DeleteResourcePolicy'));
  assert.equal(statements[0].Resource, '*');
});

test('CloudFormation has only the unscopable CodeDeploy cutover actions globally', () => {
  const app = new cdk.App({ context: { stage: 'prod' } });
  const template = Template.fromStack(
    new DespensaListaCognitoStack(app, 'Cognito-prod-codedeploy-control'),
  ).toJSON();
  const statements = Object.values(template.Resources)
    .filter((value: any) => value.Type === 'AWS::IAM::Policy')
    .flatMap((value: any) => value.Properties.PolicyDocument.Statement)
    .filter((statement: any) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('codedeploy:CreateCloudFormationDeployment');
    });

  assert.equal(statements.length, 1);
  assert.ok(statements[0].Action.includes('codedeploy:StopDeployment'));
  assert.equal(statements[0].Resource, '*');
});

test('delivery IAM policy synthesis is stable across repeated runs', () => {
  const synthesizePolicies = () => {
    const app = new cdk.App({ context: { stage: 'dev' } });
    const stack = new DespensaListaCognitoStack(app, 'Cognito-stable-delivery-policy');
    return Template.fromStack(stack).findResources('AWS::IAM::Policy');
  };

  assert.deepEqual(synthesizePolicies(), synthesizePolicies());
});
