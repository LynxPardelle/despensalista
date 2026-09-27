import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseArtifact } from './release-artifact.mjs';

const DEPLOYMENT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const RECEIPT_NAME = 'deployment-receipt.json';
const PRODUCTION_DRAIN_PARAMETER = '/despensalista/prod/deployment-drain';
const STABLE_STACK_STATUSES = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);

function awsCli(args) {
  const output = execFileSync('aws', [...args, '--output', 'json'], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '' },
  });
  return output.trim() ? JSON.parse(output) : {};
}

function stackState(stage, aws) {
  const stack = backendStack(stage, aws);
  return stackDeploymentState(stage, stack);
}

function backendStack(stage, aws) {
  if (!['dev', 'tst', 'prod'].includes(stage)) throw new Error('Invalid deployment stage');
  const response = aws(['cloudformation', 'describe-stacks', '--stack-name', `despensalista-${stage}-serverless-backend`]);
  const stack = response.Stacks?.[0];
  assertStableStack(stack, stage);
  return stack;
}

function stackDeploymentState(stage, stack) {
  if (!Array.isArray(stack.Outputs)) throw new Error(`Backend stack for ${stage} has no deployment outputs`);
  const outputs = Object.fromEntries(stack.Outputs.map(output => [output.OutputKey, output.OutputValue]));
  const state = {
    stage,
    functionName: outputs.ServerlessBackendFunctionName,
    alias: outputs.ServerlessBackendLiveAliasArn?.split(':').at(-1),
    deploymentVersion: outputs.ServerlessBackendVersion,
    deploymentReleaseId: outputs.DeploymentReleaseId,
    backendDataContractVersion: stackBackendDataContractVersion(stack),
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
  state.aliasExisted = Boolean(state.alias);
  state.version = state.alias
    ? aws(['lambda', 'get-alias', '--function-name', state.functionName, '--name', state.alias]).FunctionVersion
    : publishOrReuseLatestVersion(state.functionName, aws);
  state.alias ??= 'live';
  const aliasContract = versionBackendDataContractVersion(
    state.functionName,
    state.version,
    aws,
  );
  if (
    state.version === state.deploymentVersion &&
    aliasContract !== state.backendDataContractVersion
  ) {
    throw new Error('Published Lambda data contract does not match the deployed stack');
  }
  state.backendDataContractVersion = aliasContract;
  state.reservedConcurrency = normalizedReservedConcurrency(aws([
    'lambda', 'get-function-concurrency', '--function-name', state.functionName,
  ]).ReservedConcurrentExecutions);
  state.writersDrained = false;
  aws(['s3', 'sync', `s3://${state.bucket}/`, path.join(directory, 'frontend'), '--only-show-errors']);
  await writeFile(path.join(directory, 'state.json'), JSON.stringify(state));
}

export async function armProductionDrain({
  stage,
  directory,
  artifact,
  aws = awsCli,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  if (stage !== 'prod') throw new Error('Writer drain is production-only');
  const manifest = await verifyReleaseArtifact({ artifact });
  releaseDigests(manifest);
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  if (state.unavailable) return false;
  const previous = readProductionDrainMarker(aws, { includeInactive: true });
  if (previous?.active) throw new Error('Production recovery is already active');
  if (previous) cleanupProductionRecovery(previous, aws);
  const recoveryBucket = deliveryAssetsBucket(stage, aws);
  const recoveryPrefix = `deployment-recovery/${manifest.releaseId}/${randomUUID()}/frontend`;
  const pending = createPendingProductionDrainMarker({
    ...state,
    releaseId: manifest.releaseId,
    codeSha256: await artifactCodeSha256(artifact),
    webBucket: state.bucket,
    recoveryBucket,
    recoveryPrefix,
  }, aws, 'armed');
  aws([
    's3', 'sync',
    path.join(directory, 'frontend'),
    `s3://${recoveryBucket}/${recoveryPrefix}/`,
    '--delete', '--cache-control', 'no-cache', '--only-show-errors',
  ]);
  const marker = transitionProductionDrainMarker(pending, 'armed', aws);
  await drainWriters(marker.functionName, aws, wait);
  return marker;
}

export async function activateProductionRelease({
  stage,
  aws = awsCli,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  if (stage !== 'prod') throw new Error('Writer drain is production-only');
  const marker = readProductionDrainMarker(aws);
  if (!marker) return false;
  if (marker.phase !== 'armed') {
    throw new Error(`Production release cannot activate phase ${marker.phase}`);
  }
  await drainWriters(marker.functionName, aws, wait);
  const response = aws([
    'cloudformation', 'describe-stacks',
    '--stack-name', 'despensalista-prod-serverless-backend',
  ]);
  const stack = response.Stacks?.[0];
  assertStableStack(stack, stage);
  activateExactDeployment({
    stack,
    expected: marker,
    aws,
    options: { allowBaselineRelease: true },
    mismatchMessage: 'Production release output or Lambda hash does not match the armed release',
  });
  return true;
}

export async function activatePublishedRelease({ stage, artifact, aws = awsCli }) {
  if (!['dev', 'tst'].includes(stage)) {
    throw new Error('Direct release activation is only supported for dev and tst');
  }
  const manifest = await verifyReleaseArtifact({ artifact });
  releaseDigests(manifest);
  const stack = backendStack(stage, aws);
  const state = stackDeploymentState(stage, stack);
  assertDeploymentReleaseId(state, manifest);
  assertArtifactContractMatchesState(manifest, state);
  if (!state.alias || !/^\d+$/.test(state.deploymentVersion ?? '')) {
    throw new Error('Published deployment has no exact Lambda alias/version output');
  }
  const activated = activateExactDeployment({
    stack,
    expected: {
      phase: 'release',
      functionName: state.functionName,
      alias: state.alias,
      releaseId: manifest.releaseId,
      codeSha256: await artifactCodeSha256(artifact),
    },
    aws,
    mismatchMessage: 'Published deployment output or Lambda hash does not match the release artifact',
  });
  return { ...state, version: activated.version };
}

export async function releaseProductionDrain({ stage, aws = awsCli }) {
  if (stage !== 'prod') throw new Error('Writer drain is production-only');
  const marker = readProductionDrainMarker(aws);
  if (!marker) return false;
  if (marker.phase !== 'verified') {
    throw new Error('Production writer drain has not verified the deployed release');
  }
  const reopening = transitionProductionDrainMarker(marker, 'reopening', aws);
  await restoreDeploymentConcurrency(reopening, aws);
  transitionProductionDrainMarker(reopening, 'smoke_pending', aws);
  return true;
}

export async function drainCapturedWriters({
  stage,
  directory,
  aws = awsCli,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  if (!['dev', 'tst'].includes(stage)) {
    throw new Error('Captured writer drain is only supported for dev and tst');
  }
  const statePath = path.join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (state.stage !== stage) throw new Error('Writer drain stage does not match snapshot');
  if (state.unavailable) return false;
  await drainWriters(state.functionName, aws, wait);
  await writeFile(statePath, JSON.stringify({ ...state, writersDrained: true }));
  return true;
}

export async function releaseCapturedWriters({
  stage,
  directory,
  aws = awsCli,
}) {
  if (!['dev', 'tst'].includes(stage)) {
    throw new Error('Captured writer release is only supported for dev and tst');
  }
  const statePath = path.join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (state.stage !== stage) throw new Error('Writer release stage does not match snapshot');
  if (state.unavailable) return false;
  if (state.writersDrained !== true) throw new Error('Stage writers were not drained');
  await restoreDeploymentConcurrency(state, aws);
  await writeFile(statePath, JSON.stringify({ ...state, writersDrained: false }));
  return true;
}

export function finalizeProductionDrain({ stage, aws = awsCli }) {
  if (stage !== 'prod') throw new Error('Writer drain is production-only');
  const marker = readProductionDrainMarker(aws, { includeInactive: true });
  if (!marker) return false;
  if (marker.active) {
    if (!['reopening', 'smoke_pending'].includes(marker.phase)) {
      throw new Error(`Production drain cannot finalize phase ${marker.phase}`);
    }
    if (marker.phase === 'reopening') {
      const reserved = aws([
        'lambda', 'get-function-concurrency',
        '--function-name', marker.functionName,
      ]).ReservedConcurrentExecutions;
      if (reserved === 0) {
        throw new Error('Production Lambda remains drained; recover instead');
      }
    }
    deactivateProductionDrainMarker(marker, aws);
  }
  cleanupProductionRecovery(marker, aws);
  return true;
}

export async function recoverProductionDrain({
  stage,
  aws = awsCli,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  if (stage !== 'prod') throw new Error('Writer drain is production-only');
  const marker = readProductionDrainMarker(aws);
  if (!marker) return false;
  if (marker.phase !== 'rollback') {
    const stack = await waitForStableBackendStack({
      stage,
      aws,
      wait,
      acceptTerminalFailure: true,
    });
    const currentContract = stackBackendDataContractVersion(stack);
    if (currentContract !== marker.backendDataContractVersion) {
      const reserved = aws([
        'lambda', 'get-function-concurrency',
        '--function-name', marker.functionName,
      ]).ReservedConcurrentExecutions;
      if (
        !['armed', 'verified', 'reopening'].includes(marker.phase) ||
        reserved !== 0
      ) {
        throw new Error(
          'Automatic rollback cannot cross the active backend data contract; fix forward',
        );
      }
    }
  }
  const rollback = marker.phase === 'rollback'
    ? marker
    : transitionProductionDrainMarker(marker, 'rollback', aws);
  await recoverProductionRollback(rollback, aws, wait);
  return true;
}

async function restore(
  state,
  frontend,
  aws,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
) {
  if (!state.functionName || !state.alias || !state.bucket || !state.distribution || !/^\d+$/.test(state.version)) {
    throw new Error('Invalid rollback state');
  }
  if (state.stage === 'prod') {
    const marker = await prepareProductionRollback(state, frontend, aws);
    await recoverProductionRollback(marker, aws, wait);
    return;
  }
  restoreAlias(state, aws);
  aws(['s3', 'cp', frontend, `s3://${state.bucket}/`, '--recursive', '--cache-control', 'no-cache', '--only-show-errors']);
  aws(['s3', 'sync', frontend, `s3://${state.bucket}/`, '--delete', '--cache-control', 'no-cache', '--only-show-errors']);
  aws(['cloudfront', 'create-invalidation', '--distribution-id', state.distribution, '--paths', '/*']);
}

export async function restoreDeployment({
  stage,
  directory,
  aws = awsCli,
  wait,
}) {
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  if (state.stage !== stage) throw new Error('Rollback stage does not match snapshot');
  if (state.unavailable) throw new Error('No previous published deployment exists; inspect failed initial deployment');
  const baselineContract = normalizeBackendDataContractVersion(
    state.backendDataContractVersion,
  );
  const current = stackState(stage, aws);
  if (baselineContract !== current.backendDataContractVersion) {
    const marker = stage === 'prod' ? readProductionDrainMarker(aws) : null;
    const functionName = marker?.functionName ?? state.functionName;
    const reserved = functionName
      ? aws([
          'lambda', 'get-function-concurrency',
          '--function-name', functionName,
        ]).ReservedConcurrentExecutions
      : undefined;
    const safeProductionRollback =
      marker?.backendDataContractVersion === baselineContract &&
      ['armed', 'verified', 'reopening'].includes(marker.phase) &&
      reserved === 0;
    const safeNonProductionRollback =
      stage !== 'prod' && state.writersDrained === true && reserved === 0;
    if (!safeProductionRollback && !safeNonProductionRollback) {
      throw new Error(
        'Automatic rollback cannot cross the active backend data contract; fix forward',
      );
    }
  }
  await restore(state, path.join(directory, 'frontend'), aws, wait);
  if (stage !== 'prod') {
    await restoreDeploymentConcurrency(state, aws);
    await writeFile(
      path.join(directory, 'state.json'),
      JSON.stringify({ ...state, writersDrained: false }),
    );
  }
}

export async function verifyPublishedRelease({ stage, artifact, aws = awsCli }) {
  const manifest = await verifyReleaseArtifact({ artifact });
  releaseDigests(manifest);
  const state = stackState(stage, aws);
  assertDeploymentReleaseId(state, manifest);
  assertArtifactContractMatchesState(manifest, state);
  const version = await assertPublishedBackend(state, artifact, aws);
  return { ...state, version };
}

export function markProductionDrainVerified({
  stage,
  aws = awsCli,
}) {
  if (stage !== 'prod') throw new Error('Writer drain is production-only');
  const marker = readProductionDrainMarker(aws);
  if (!marker) return false;
  if (marker.phase !== 'armed' && marker.phase !== 'verified') {
    throw new Error(`Production writer drain cannot verify phase ${marker.phase}`);
  }
  const response = aws([
    'cloudformation', 'describe-stacks',
    '--stack-name', 'despensalista-prod-serverless-backend',
  ]);
  const stack = response.Stacks?.[0];
  assertStableStack(stack, stage);
  const forward = forwardDeployment(stack, marker, aws, {
    allowBaselineRelease: true,
  });
  if (!forward || forward.currentVersion !== forward.version) {
    throw new Error('Production writer drain cannot verify the exact deployed release');
  }
  transitionProductionDrainMarker({
    ...marker,
    verifiedVersion: forward.version,
  }, 'verified', aws);
  return true;
}

export async function reconcilePublishedRelease({ stage, artifact, aws = awsCli }) {
  const state = await verifyPublishedRelease({ stage, artifact, aws });
  const frontend = path.join(
    artifact,
    'payload',
    'frontend',
    'dist',
    'frontend',
    'browser',
  );
  aws([
    's3', 'cp', frontend, `s3://${state.bucket}/`,
    '--recursive', '--cache-control', 'no-cache', '--only-show-errors',
  ]);
  aws(['s3', 'sync', frontend, `s3://${state.bucket}/`, '--delete', '--cache-control', 'no-cache', '--only-show-errors']);
  const invalidation = aws([
    'cloudfront', 'create-invalidation',
    '--distribution-id', state.distribution,
    '--paths', '/*',
  ]);
  if (stage === 'prod') {
    const invalidationId = invalidation.Invalidation?.Id;
    if (!invalidationId) throw new Error('CloudFront release invalidation was not created');
    aws([
      'cloudfront', 'wait', 'invalidation-completed',
      '--distribution-id', state.distribution,
      '--id', invalidationId,
    ]);
  }
  return state;
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
  assertDeploymentReleaseId(state, manifest);
  assertArtifactContractMatchesState(manifest, state);
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
    backendDataContractVersion: state.backendDataContractVersion,
    backendSha256: digests.backendSha256,
    frontendManifestSha256: digests.frontendManifestSha256,
    functionName: state.functionName,
    alias: state.alias,
    version,
    reservedConcurrency: stage === 'prod'
      ? normalizedReservedConcurrency(aws([
          'lambda', 'get-function-concurrency', '--function-name', state.functionName,
        ]).ReservedConcurrentExecutions)
      : null,
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
  wait,
}) {
  assertDeploymentSha(deploymentSha);
  const manifest = await verifyReleaseArtifact({ artifact });
  const recorded = JSON.parse(await readFile(receipt, 'utf8'));
  const state = stackState(stage, aws);
  const artifactContract = normalizeBackendDataContractVersion(
    manifest.backendDataContractVersion,
  );
  const receiptContract = normalizeBackendDataContractVersion(
    recorded.backendDataContractVersion,
  );
  if (receiptContract !== artifactContract) {
    throw new Error('Deployment receipt data contract does not match the release artifact');
  }
  if (receiptContract !== state.backendDataContractVersion) {
    throw new Error('Rollback data contract does not match the active backend contract');
  }
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
  const reservedConcurrency = normalizedReservedConcurrency(
    recorded.reservedConcurrency,
  );
  await restore(
    {
      ...state,
      version: recorded.version,
      reservedConcurrency,
    },
    path.join(artifact, 'payload', 'frontend', 'dist', 'frontend', 'browser'),
    aws,
    wait,
  );
}

function publishOrReuseLatestVersion(functionName, aws) {
  try {
    return aws([
      'lambda', 'publish-version', '--function-name', functionName,
    ]).Version;
  } catch (error) {
    const details = [error.name, error.code, error.message, error.stderr]
      .filter(Boolean)
      .join(' ');
    if (
      !/ResourceConflict/i.test(details) ||
      !/version.*exists|no changes|modify the function/i.test(details)
    ) {
      throw error;
    }
    const versions = aws([
      'lambda', 'list-versions-by-function', '--function-name', functionName,
    ]).Versions ?? [];
    const latest = versions
      .filter(version => /^\d+$/.test(version.Version ?? ''))
      .sort((left, right) => Number(left.Version) - Number(right.Version))
      .at(-1);
    if (!latest) throw error;
    return latest.Version;
  }
}

async function restoreDeploymentConcurrency(state, aws) {
  const desired = normalizedReservedConcurrency(state.reservedConcurrency);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const reserved = aws([
        'lambda', 'get-function-concurrency', '--function-name', state.functionName,
      ]).ReservedConcurrentExecutions;
      if ((desired === null && reserved === undefined) || reserved === desired) {
        return;
      }
      if (desired === null) {
        aws(['lambda', 'delete-function-concurrency', '--function-name', state.functionName]);
      } else {
        aws([
          'lambda', 'put-function-concurrency', '--function-name', state.functionName,
          '--reserved-concurrent-executions', String(desired),
        ]);
      }
      const verified = aws([
        'lambda', 'get-function-concurrency', '--function-name', state.functionName,
      ]).ReservedConcurrentExecutions;
      if ((desired === null && verified === undefined) || verified === desired) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) {
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 100));
    }
  }
  throw new Error(`${state.stage} Lambda remains drained after recovery`, {
    cause: lastError,
  });
}

function normalizedReservedConcurrency(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeBackendDataContractVersion(value) {
  if (value === undefined || value === null || value === '') return 0;
  const normalized = typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error('Invalid backend data contract version');
  }
  return normalized;
}

function stackBackendDataContractVersion(stack) {
  const output = (stack.Outputs ?? []).find(
    item => item.OutputKey === 'BackendDataContractVersion',
  )?.OutputValue;
  return normalizeBackendDataContractVersion(output);
}

function versionBackendDataContractVersion(functionName, version, aws) {
  const configuration = aws([
    'lambda', 'get-function-configuration',
    '--function-name', functionName,
    '--qualifier', version,
  ]);
  return normalizeBackendDataContractVersion(
    configuration.Environment?.Variables?.BACKEND_DATA_CONTRACT_VERSION,
  );
}

function assertArtifactContractMatchesState(manifest, state) {
  const artifactContract = normalizeBackendDataContractVersion(
    manifest.backendDataContractVersion,
  );
  if (artifactContract !== state.backendDataContractVersion) {
    throw new Error('Release artifact data contract does not match the deployed stack');
  }
}

function deliveryAssetsBucket(stage, aws) {
  const response = aws([
    'cloudformation', 'describe-stacks',
    '--stack-name', `despensalista-${stage}-cognito`,
  ]);
  const stack = response.Stacks?.[0];
  assertStableStack(stack, `${stage} Cognito`);
  const bucket = (stack.Outputs ?? []).find(
    output => output.OutputKey === 'DeliveryAssetsBucketName',
  )?.OutputValue;
  if (!bucket) throw new Error('Cognito stack has no delivery assets bucket');
  return bucket;
}

async function prepareProductionRollback(state, frontend, aws) {
  const existing = readProductionDrainMarker(aws, { includeInactive: true });
  if (existing?.active && rollbackStateMatches(existing, state)) {
    return transitionProductionDrainMarker(existing, 'rollback', aws);
  }
  if (existing?.active) {
    throw new Error('Production drain marker does not match rollback state');
  }
  if (existing) cleanupProductionRecovery(existing, aws);
  const recoveryBucket = deliveryAssetsBucket(state.stage, aws);
  const recoveryPrefix = `deployment-recovery/rollback/${randomUUID()}/frontend`;
  const pending = createPendingProductionDrainMarker({
    ...state,
    releaseId: null,
    codeSha256: null,
    webBucket: state.bucket,
    recoveryBucket,
    recoveryPrefix,
  }, aws, 'rollback');
  aws([
    's3', 'sync', frontend,
    `s3://${recoveryBucket}/${recoveryPrefix}/`,
    '--delete', '--cache-control', 'no-cache', '--only-show-errors',
  ]);
  return transitionProductionDrainMarker(pending, 'rollback', aws);
}

function rollbackStateMatches(marker, state) {
  return marker.functionName === state.functionName &&
    marker.alias === state.alias &&
    marker.aliasExisted === (state.aliasExisted !== false) &&
    marker.version === state.version &&
    marker.deploymentVersion === (/^\d+$/.test(state.deploymentVersion ?? '')
      ? state.deploymentVersion
      : null) &&
    marker.deploymentReleaseId === (/^[0-9a-f]{12}$/.test(state.deploymentReleaseId ?? '')
      ? state.deploymentReleaseId
      : null) &&
    marker.backendDataContractVersion === normalizeBackendDataContractVersion(
      state.backendDataContractVersion,
    ) &&
    marker.reservedConcurrency === normalizedReservedConcurrency(state.reservedConcurrency) &&
    marker.webBucket === state.bucket &&
    marker.distribution === state.distribution;
}

async function recoverProductionRollback(marker, aws, wait) {
  await drainWriters(marker.functionName, aws, wait);
  const stack = await waitForStableBackendStack({
    stage: marker.stage,
    aws,
    wait,
    acceptTerminalFailure: true,
  });
  finishProductionRollback(marker, aws);
  if (!STABLE_STACK_STATUSES.has(stack.StackStatus)) {
    throw new Error(
      `Backend stack remains ${stack.StackStatus}; frontend restored but writers remain drained`,
    );
  }
  await restoreDeploymentConcurrency(marker, aws);
  deactivateProductionDrainMarker(marker, aws);
  cleanupProductionRecovery(marker, aws);
}

function finishProductionRollback(marker, aws) {
  restoreAlias(marker, aws);
  aws([
    's3', 'cp',
    `s3://${marker.recoveryBucket}/${marker.recoveryPrefix}/`,
    `s3://${marker.webBucket}/`,
    '--recursive', '--copy-props', 'metadata-directive', '--only-show-errors',
  ]);
  aws([
    's3', 'sync',
    `s3://${marker.recoveryBucket}/${marker.recoveryPrefix}/`,
    `s3://${marker.webBucket}/`,
    '--delete', '--only-show-errors',
  ]);
  const invalidation = aws([
    'cloudfront', 'create-invalidation',
    '--distribution-id', marker.distribution,
    '--paths', '/*',
  ]);
  const invalidationId = invalidation.Invalidation?.Id;
  if (!invalidationId) throw new Error('CloudFront rollback invalidation was not created');
  aws([
    'cloudfront', 'wait', 'invalidation-completed',
    '--distribution-id', marker.distribution,
    '--id', invalidationId,
  ]);
}

function restoreAlias(state, aws) {
  let aliasAvailable = state.aliasExisted !== false;
  if (!aliasAvailable) {
    try {
      aws(['lambda', 'get-alias', '--function-name', state.functionName, '--name', state.alias]);
      aliasAvailable = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  if (aliasAvailable) {
    aws([
      'lambda', 'update-alias',
      '--function-name', state.functionName,
      '--name', state.alias,
      '--function-version', state.version,
      '--routing-config', '{"AdditionalVersionWeights":{}}',
    ]);
  }
}

function productionDrainMarker(
  state,
  phase = state.phase ?? 'armed',
  active = state.active !== false,
) {
  const webBucket = state.webBucket ?? state.bucket;
  const releaseId = state.releaseId ?? null;
  const codeSha256 = state.codeSha256 ?? null;
  const verifiedVersion = /^\d+$/.test(state.verifiedVersion ?? '')
    ? state.verifiedVersion
    : null;
  const backendDataContractVersion = normalizeBackendDataContractVersion(
    state.backendDataContractVersion,
  );
  if (
    state.stage !== 'prod' ||
    state.unavailable ||
    !state.functionName ||
    state.functionName !== 'despensalista-prod-backend-api' ||
    state.alias !== 'live' ||
    !/^\d+$/.test(state.version ?? '') ||
    !Object.hasOwn(state, 'reservedConcurrency') ||
    (state.reservedConcurrency !== null &&
      (!Number.isInteger(state.reservedConcurrency) || state.reservedConcurrency <= 0)) ||
    !['armed', 'verified', 'reopening', 'smoke_pending', 'rollback'].includes(phase) ||
    !webBucket ||
    !state.distribution ||
    !state.recoveryBucket ||
    !state.recoveryPrefix?.startsWith('deployment-recovery/') ||
    state.recoveryPrefix.includes('..') ||
    (phase !== 'rollback' &&
      (!/^[0-9a-f]{12}$/.test(releaseId ?? '') ||
        !/^[A-Za-z0-9+/]{43}=$/.test(codeSha256 ?? ''))) ||
    ((phase === 'verified' || phase === 'reopening' || phase === 'smoke_pending') &&
      verifiedVersion === null)
  ) {
    throw new Error('Invalid production drain snapshot');
  }
  return {
    schemaVersion: 1,
    active,
    phase,
    stage: 'prod',
    functionName: state.functionName,
    alias: state.alias,
    aliasExisted: state.aliasExisted !== false,
    version: state.version,
    deploymentVersion: /^\d+$/.test(state.deploymentVersion ?? '')
      ? state.deploymentVersion
      : null,
    deploymentReleaseId: /^[0-9a-f]{12}$/.test(state.deploymentReleaseId ?? '')
      ? state.deploymentReleaseId
      : null,
    backendDataContractVersion,
    reservedConcurrency: normalizedReservedConcurrency(state.reservedConcurrency),
    releaseId,
    codeSha256,
    verifiedVersion,
    webBucket,
    distribution: state.distribution,
    recoveryBucket: state.recoveryBucket,
    recoveryPrefix: state.recoveryPrefix,
  };
}

function createPendingProductionDrainMarker(state, aws, phase) {
  const pending = productionDrainMarker(state, phase, false);
  writeProductionDrainMarker(pending, aws);
  return pending;
}

function transitionProductionDrainMarker(marker, phase, aws) {
  const transitioned = productionDrainMarker(
    { ...marker, active: true },
    phase,
    true,
  );
  writeProductionDrainMarker(transitioned, aws);
  return transitioned;
}

function writeProductionDrainMarker(marker, aws) {
  aws([
    'ssm', 'put-parameter',
    '--name', PRODUCTION_DRAIN_PARAMETER,
    '--type', 'String',
    '--value', JSON.stringify(marker),
    '--overwrite',
  ]);
}

function readProductionDrainMarker(aws, { includeInactive = false } = {}) {
  let response;
  try {
    response = aws(['ssm', 'get-parameter', '--name', PRODUCTION_DRAIN_PARAMETER]);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  let marker;
  try {
    marker = JSON.parse(response.Parameter?.Value ?? '');
  } catch {
    throw new Error('Production drain marker is invalid JSON');
  }
  if (
    marker?.schemaVersion === 1 &&
    marker.active === false &&
    !marker.phase
  ) return null;
  if (marker?.active !== true && marker?.active !== false) {
    throw new Error('Production drain marker has invalid state');
  }
  if (marker.active === false && !includeInactive) return null;
  if (!Object.hasOwn(marker, 'deploymentVersion')) {
    throw new Error('Production drain marker has no deployment baseline');
  }
  if (marker.deploymentVersion !== null && !/^\d+$/.test(marker.deploymentVersion ?? '')) {
    throw new Error('Production drain marker has invalid deployment baseline');
  }
  return productionDrainMarker(marker, marker.phase, marker.active);
}

function deactivateProductionDrainMarker(marker, aws) {
  writeProductionDrainMarker({ ...marker, active: false }, aws);
}

function cleanupProductionRecovery(marker, aws) {
  aws([
    's3', 'rm',
    `s3://${marker.recoveryBucket}/${marker.recoveryPrefix}/`,
    '--recursive', '--only-show-errors',
  ]);
}

async function waitForStableBackendStack({
  stage,
  aws,
  wait,
  acceptTerminalFailure = false,
}) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = aws([
      'cloudformation', 'describe-stacks',
      '--stack-name', `despensalista-${stage}-serverless-backend`,
    ]);
    const stack = response.Stacks?.[0];
    const status = stack?.StackStatus;
    if (STABLE_STACK_STATUSES.has(status)) return stack;
    if (!status?.endsWith('_IN_PROGRESS')) {
      if (acceptTerminalFailure && stack && typeof status === 'string') return stack;
      throw new Error(`Backend stack for ${stage} is not recoverable: ${status ?? 'missing'}`);
    }
    if (attempt < 119) await wait(15_000);
  }
  throw new Error(`Backend stack for ${stage} did not become stable`);
}

function forwardDeployment(
  stack,
  marker,
  aws,
  { allowBaselineRelease = false } = {},
) {
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) return null;
  const outputs = Object.fromEntries(
    (stack.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]),
  );
  const version = outputs.ServerlessBackendVersion;
  const releaseId = outputs.DeploymentReleaseId;
  const alias = outputs.ServerlessBackendLiveAliasArn?.split(':').at(-1);
  if (
    outputs.ServerlessBackendFunctionName !== marker.functionName ||
    alias !== marker.alias ||
    !/^\d+$/.test(version ?? '') ||
    releaseId !== marker.releaseId ||
    (marker.phase === 'armed' &&
      !allowBaselineRelease &&
      marker.releaseId === marker.deploymentReleaseId) ||
    (marker.phase === 'verified'
      ? version !== marker.verifiedVersion
      : false)
  ) {
    return null;
  }
  try {
    const codeSha256 = aws([
      'lambda', 'get-function',
      '--function-name', marker.functionName,
      '--qualifier', version,
    ]).Configuration?.CodeSha256;
    if (codeSha256 !== marker.codeSha256) return null;
    const currentVersion = aws([
      'lambda', 'get-alias',
      '--function-name', marker.functionName,
      '--name', marker.alias,
    ]).FunctionVersion;
    if (marker.phase === 'verified' && currentVersion !== marker.verifiedVersion) {
      return null;
    }
    return { version, currentVersion };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function activateExactDeployment({
  stack,
  expected,
  aws,
  options,
  mismatchMessage,
}) {
  const forward = forwardDeployment(stack, expected, aws, options);
  if (!forward) throw new Error(mismatchMessage);
  if (forward.currentVersion !== forward.version) {
    aws([
      'lambda', 'update-alias',
      '--function-name', expected.functionName,
      '--name', expected.alias,
      '--function-version', forward.version,
      '--routing-config', '{"AdditionalVersionWeights":{}}',
    ]);
  }
  return forward;
}

async function drainWriters(functionName, aws, wait) {
  aws([
    'lambda', 'put-function-concurrency',
    '--function-name', functionName,
    '--reserved-concurrent-executions', '0',
  ]);
  const timeout = aws([
    'lambda', 'get-function-configuration',
    '--function-name', functionName,
  ]).Timeout;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 900) {
    throw new Error('Lambda timeout is invalid');
  }
  await wait((timeout + 5) * 1000);
}

function assertStableStack(stack, stage) {
  const status = stack?.StackStatus;
  if (!stack || !STABLE_STACK_STATUSES.has(status)) {
    throw new Error(`Backend stack for ${stage} is not stable: ${status ?? 'missing'}`);
  }
}

function isNotFound(error) {
  const details = [error?.name, error?.code, error?.message, error?.stderr]
    .filter(Boolean)
    .join(' ');
  return /ParameterNotFound|ResourceNotFound|does not exist/i.test(details);
}

function deploymentIdentity(aws, env) {
  const account = aws(['sts', 'get-caller-identity']).Account;
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (!/^\d{12}$/.test(account ?? '') || !region) {
    throw new Error('Could not determine deployment account and region');
  }
  return { account, region };
}

function assertDeploymentReleaseId(state, manifest) {
  if (state.deploymentReleaseId !== manifest.releaseId) {
    throw new Error('Published deployment releaseId does not match the release artifact');
  }
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
  } else if (command === 'drain-writers' && location) {
    await drainCapturedWriters({ stage, directory: location });
  } else if (command === 'release-writers' && location) {
    await releaseCapturedWriters({ stage, directory: location });
  } else if (command === 'arm-drain' && location && extraLocation) {
    await armProductionDrain({
      stage,
      directory: location,
      artifact: extraLocation,
    });
  } else if (command === 'release-drain') {
    await releaseProductionDrain({ stage });
  } else if (command === 'activate-drain') {
    await activateProductionRelease({ stage });
  } else if (command === 'finalize-drain') {
    finalizeProductionDrain({ stage });
  } else if (command === 'recover-drain') {
    await recoverProductionDrain({ stage });
  } else if (command === 'mark-drain-verified') {
    markProductionDrainVerified({ stage });
  } else if (command === 'verify' && location) {
    await verifyPublishedRelease({ stage, artifact: location });
  } else if (command === 'activate' && location) {
    await activatePublishedRelease({ stage, artifact: location });
  } else if (command === 'reconcile' && location) {
    await reconcilePublishedRelease({ stage, artifact: location });
  } else if (command === 'record' && location && extraLocation && deploymentSha) {
    await recordPublishedRelease({ stage, artifact: location, directory: extraLocation, deploymentSha });
  } else if (command === 'release' && location && extraLocation && deploymentSha) {
    await restoreRelease({ stage, artifact: location, receipt: extraLocation, deploymentSha });
  } else {
    throw new Error('Usage: deployment-state.mjs <capture|restore|drain-writers|release-writers> <stage> <directory> | arm-drain prod <rollback-directory> <artifact> | <activate-drain|release-drain|recover-drain|mark-drain-verified|finalize-drain> prod | <activate|verify|reconcile> <stage> <artifact> | <record|release> <stage> <artifact> <receipt-path-or-directory> <deployment-sha>');
  }
}
