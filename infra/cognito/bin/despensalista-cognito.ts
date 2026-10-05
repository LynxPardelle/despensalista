#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DespensaListaCognitoStack } from "../lib/despensalista-cognito-stack";
import { DespensaListaServerlessBackendStack } from "../lib/despensalista-serverless-backend-stack";
import { deliveryInventory, stageSynthesizer } from '../lib/stage-delivery';

const app = new cdk.App();

const projectName =
  app.node.tryGetContext("projectName")?.toString().trim() || "despensalista";
const stage = app.node.tryGetContext("stage")?.toString().trim() || "dev";
const region =
  app.node.tryGetContext("awsRegion")?.toString().trim() ||
  process.env.CDK_DEFAULT_REGION ||
  "us-east-1";
const account = process.env.CDK_DEFAULT_ACCOUNT;
const bootstrap = app.node.tryGetContext('controlPlaneBootstrap') === 'true';
if (!['dev', 'tst', 'prod'].includes(stage)) throw new Error('Only dev, tst and prod are supported.');
if (!bootstrap && !deliveryInventory(stage).distributionId) {
  throw new Error(`Stage ${stage} requires administrator bootstrap and delivery-resources.json inventory before GitHub deployment.`);
}

const cognitoStack = new DespensaListaCognitoStack(app, `${projectName}-${stage}-cognito`, {
  env: {
    account,
    region,
  },
  terminationProtection: stage === 'prod',
  synthesizer: bootstrap ? undefined : stageSynthesizer(projectName, stage),
});
cdk.Tags.of(cognitoStack).add("Project", projectName);
cdk.Tags.of(cognitoStack).add("Stage", stage);
// Preserve these exports when deploying only authentication/roles before the app.
cognitoStack.exportValue(cognitoStack.userPoolId);
cognitoStack.exportValue(cognitoStack.userPoolClientId);

const includeServerlessBackend = ["1", "true", "yes", "y"].includes(
  app.node
    .tryGetContext("includeServerlessBackend")
    ?.toString()
    .trim()
    .toLowerCase() ?? "false"
);

if (includeServerlessBackend) {
  const serverlessBackendStack = new DespensaListaServerlessBackendStack(
    app,
    `${projectName}-${stage}-serverless-backend`,
    {
      env: {
        account,
        region,
      },
      terminationProtection: stage === 'prod',
      synthesizer: stageSynthesizer(projectName, stage, bootstrap),
      allowedProviders: cognitoStack.allowedProviders,
      cognitoDomain: cognitoStack.userPoolDomainUrl,
      cognitoUserPoolClientId: cognitoStack.userPoolClientId,
      cognitoUserPoolId: cognitoStack.userPoolId,
    },
  );
  cdk.Tags.of(serverlessBackendStack).add("Project", projectName);
  cdk.Tags.of(serverlessBackendStack).add("Stage", stage);
}
