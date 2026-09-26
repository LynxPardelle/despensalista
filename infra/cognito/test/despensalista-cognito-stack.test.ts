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
    EmailConfiguration: {
      EmailSendingAccount: 'COGNITO_DEFAULT',
      From: 'DespensaLista <no-reply@despensalista.lynxpardelle.com>',
    },
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

test('delivery controls require a protected stage boundary and do not expose global mutation', () => {
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

test('delivery IAM policy synthesis is stable across repeated runs', () => {
  const synthesizePolicies = () => {
    const app = new cdk.App({ context: { stage: 'dev' } });
    const stack = new DespensaListaCognitoStack(app, 'Cognito-stable-delivery-policy');
    return Template.fromStack(stack).findResources('AWS::IAM::Policy');
  };

  assert.deepEqual(synthesizePolicies(), synthesizePolicies());
});
