import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseArtifact } from './release-artifact.mjs';

const DEPLOYMENT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const RECEIPT_NAME = 'deployment-receipt.json';

function awsCli(args) {
  const output = execFileSync('aws', [...args, '--output', 'json'], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '' },
  });
  return output.trim() ? JSON.parse(output) : {};
}

function stackState(stage, aws) {
  if (!['dev', 'tst', 'prod'].includes(stage)) throw new Error('Invalid deployment stage');
  const response = aws(['cloudformation', 'describe-stacks', '--stack-name', `despensalista-${stage}-serverless-backend`]);
  const outputs = Object.fromEntries(response.Stacks[0].Outputs.map(output => [output.OutputKey, output.OutputValue]));
  const state = {
    stage,
    functionName: outputs.ServerlessBackendFunctionName,
    alias: outputs.ServerlessBackendLiveAliasArn?.split(':').at(-1),
    deploymentVersion: outputs.ServerlessBackendVersion,
    bucket: outputs.WebBucketName,
    distribution: outputs.CloudFrontDistributionId,
  };
  if (!state.functionName || !state.bucket || !state.distribution) throw new Error('Missing deployment outputs');
  return state;
}

export async function captureDeployment({ stage, directory, aws = awsCli }) {
  await mkdir(path.join(directory, 'frontend'), { recursive: true });
  let state;
  try {
    state = stackState(stage, aws);
  } catch (error) {
    if (!String(error.stderr ?? error.message).includes('does not exist')) throw error;
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ stage, unavailable: true }));
    return;
  }
  state.version = state.alias
    ? aws(['lambda', 'get-alias', '--function-name', state.functionName, '--name', state.alias]).FunctionVersion
    : aws(['lambda', 'publish-version', '--function-name', state.functionName]).Version;
  state.alias ??= 'live';
  aws(['s3', 'sync', `s3://${state.bucket}/`, path.join(directory, 'frontend'), '--only-show-errors']);
  await writeFile(path.join(directory, 'state.json'), JSON.stringify(state));
}

function restore(state, frontend, aws) {
  if (!state.functionName || !state.alias || !state.bucket || !state.distribution || !/^\d+$/.test(state.version)) {
    throw new Error('Invalid rollback state');
  }
  aws(['lambda', 'update-alias', '--function-name', state.functionName, '--name', state.alias, '--function-version', state.version, '--routing-config', '{"AdditionalVersionWeights":{}}']);
  aws(['s3', 'sync', frontend, `s3://${state.bucket}/`, '--delete', '--cache-control', 'no-cache', '--only-show-errors']);
  aws(['cloudfront', 'create-invalidation', '--distribution-id', state.distribution, '--paths', '/*']);
}

export async function restoreDeployment({ stage, directory, aws = awsCli }) {
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  if (state.stage !== stage) throw new Error('Rollback stage does not match snapshot');
  if (state.unavailable) throw new Error('No previous published deployment exists; inspect failed initial deployment');
  restore(state, path.join(directory, 'frontend'), aws);
}

export async function reconcilePublishedRelease({ stage, artifact, aws = awsCli }) {
  const manifest = await verifyReleaseArtifact({ artifact });
  releaseDigests(manifest);
  const state = stackState(stage, aws);
  const version = await assertPublishedBackend(state, artifact, aws);
  const frontend = path.join(
    artifact,
    'payload',
    'frontend',
    'dist',
    'frontend',
    'browser',
  );
  aws(['s3', 'sync', frontend, `s3://${state.bucket}/`, '--delete', '--cache-control', 'no-cache', '--only-show-errors']);
  aws(['cloudfront', 'create-invalidation', '--distribution-id', state.distribution, '--paths', '/*']);
  return { ...state, version };
}

export async function recordPublishedRelease({
  stage,
  artifact,
  directory,
  deploymentSha,
  aws = awsCli,
  env = process.env,
}) {
  assertDeploymentSha(deploymentSha);
  const manifest = await verifyReleaseArtifact({ artifact });
  const state = stackState(stage, aws);
  const version = await assertPublishedBackend(state, artifact, aws);
  const identity = deploymentIdentity(aws, env);
  const digests = releaseDigests(manifest);
  const receipt = {
    schemaVersion: 1,
    account: identity.account,
    region: identity.region,
    stage,
    deploymentSha: deploymentSha.toLowerCase(),
    sourceSha: manifest.sourceSha,
    releaseId: manifest.releaseId,
    backendSha256: digests.backendSha256,
    frontendManifestSha256: digests.frontendManifestSha256,
    functionName: state.functionName,
    alias: state.alias,
    version,
    bucket: state.bucket,
    distribution: state.distribution,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function restoreRelease({
  stage,
  artifact,
  receipt,
  deploymentSha,
  aws = awsCli,
  env = process.env,
}) {
  assertDeploymentSha(deploymentSha);
  const manifest = await verifyReleaseArtifact({ artifact });
  const recorded = JSON.parse(await readFile(receipt, 'utf8'));
  const state = stackState(stage, aws);
  const identity = deploymentIdentity(aws, env);
  const digests = releaseDigests(manifest);
  const expected = {
    schemaVersion: 1,
    account: identity.account,
    region: identity.region,
    stage,
    deploymentSha: deploymentSha.toLowerCase(),
    sourceSha: manifest.sourceSha,
    releaseId: manifest.releaseId,
    backendSha256: digests.backendSha256,
    frontendManifestSha256: digests.frontendManifestSha256,
    functionName: state.functionName,
    alias: state.alias,
    bucket: state.bucket,
    distribution: state.distribution,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (recorded[key] !== value) throw new Error(`Deployment receipt mismatch: ${key}`);
  }
  if (!/^\d+$/.test(recorded.version ?? '')) throw new Error('Deployment receipt has no Lambda version');
  const hash = await artifactCodeSha256(artifact);
  const versions = aws(['lambda', 'list-versions-by-function', '--function-name', state.functionName]).Versions;
  const selected = versions.find(version =>
    version.Version === recorded.version && version.CodeSha256 === hash,
  );
  if (!selected) throw new Error('Recorded Lambda version is unavailable or does not match the release');
  restore({ ...state, version: recorded.version }, path.join(artifact, 'payload', 'frontend', 'dist', 'frontend', 'browser'), aws);
}

function deploymentIdentity(aws, env) {
  const account = aws(['sts', 'get-caller-identity']).Account;
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (!/^\d{12}$/.test(account ?? '') || !region) {
    throw new Error('Could not determine deployment account and region');
  }
  return { account, region };
}

async function assertPublishedBackend(state, artifact, aws) {
  if (!state.alias || !/^\d+$/.test(state.deploymentVersion ?? '')) {
    throw new Error('Published deployment has no exact Lambda alias/version output');
  }
  const version = aws([
    'lambda', 'get-alias', '--function-name', state.functionName, '--name', state.alias,
  ]).FunctionVersion;
  if (version !== state.deploymentVersion) {
    throw new Error(`Published Lambda alias version mismatch: expected ${state.deploymentVersion}, received ${version ?? 'none'}`);
  }
  const codeSha256 = aws([
    'lambda', 'get-function', '--function-name', state.functionName, '--qualifier', version,
  ]).Configuration?.CodeSha256;
  if (codeSha256 !== await artifactCodeSha256(artifact)) {
    throw new Error('Published Lambda version hash does not match the release artifact');
  }
  return version;
}

async function artifactCodeSha256(artifact) {
  const zip = await readFile(path.join(artifact, 'payload', 'backend', 'lambda.zip'));
  return createHash('sha256').update(zip).digest('base64');
}

function releaseDigests(manifest) {
  const backend = manifest.files.find(file => file.path === 'backend/lambda.zip');
  const frontend = manifest.files.filter(file => file.path.startsWith('frontend/dist/frontend/'));
  if (!backend || frontend.length === 0) throw new Error('Release is missing backend or frontend payload');
  return {
    backendSha256: backend.sha256,
    frontendManifestSha256: createHash('sha256')
      .update(JSON.stringify(frontend))
      .digest('hex'),
  };
}

function assertDeploymentSha(value) {
  if (!DEPLOYMENT_SHA_PATTERN.test(value ?? '')) {
    throw new Error('Deployment SHA must be a 40-character hexadecimal commit ID');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [command, stage, location, extraLocation, deploymentSha] = process.argv.slice(2);
  if (command === 'capture' && location) {
    await captureDeployment({ stage, directory: location });
  } else if (command === 'restore' && location) {
    await restoreDeployment({ stage, directory: location });
  } else if (command === 'reconcile' && location) {
    await reconcilePublishedRelease({ stage, artifact: location });
  } else if (command === 'record' && location && extraLocation && deploymentSha) {
    await recordPublishedRelease({ stage, artifact: location, directory: extraLocation, deploymentSha });
  } else if (command === 'release' && location && extraLocation && deploymentSha) {
    await restoreRelease({ stage, artifact: location, receipt: extraLocation, deploymentSha });
  } else {
    throw new Error('Usage: deployment-state.mjs <capture|restore> <stage> <directory> | reconcile <stage> <artifact> | <record|release> <stage> <artifact> <receipt-path-or-directory> <deployment-sha>');
  }
}
