import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const load = () => import(pathToFileURL(path.join(import.meta.dirname, 'deployment-state.mjs')));
const RELEASE_CODE_SHA256 = createHash('sha256').update('zip-bytes').digest('base64');

test('captures and restores the published alias and frontend together', async () => {
  const { captureDeployment, restoreDeployment } = await load();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-rollback-'));
  const calls = [];
  const aws = args => {
    calls.push(args);
    if (args[0] === 'cloudformation') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [
      { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-tst-backend' },
      { OutputKey: 'ServerlessBackendLiveAliasArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:despensalista-tst-backend:live' },
      { OutputKey: 'WebBucketName', OutputValue: 'despensalista-tst-web' },
      { OutputKey: 'CloudFrontDistributionId', OutputValue: 'E123' },
    ] }] };
    if (args.includes('get-alias')) return { FunctionVersion: '12' };
    return {};
  };
  await captureDeployment({ stage: 'tst', directory, aws });
  await restoreDeployment({ stage: 'tst', directory, aws });
  assert.ok(calls.some(args => args.includes('update-alias') && args.includes('12')));
  assert.ok(calls.some(args => args[0] === 's3' && args.includes('--delete')));
  assert.ok(calls.some(args => args.includes('create-invalidation')));
});

test('restores the frontend when the first alias deployment failed before creating the alias', async () => {
  const { captureDeployment, restoreDeployment } = await load();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-rollback-'));
  const calls = [];
  let reservedConcurrency = 7;
  const aws = args => {
    calls.push(args);
    if (args.includes('despensalista-prod-cognito')) {
      return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [
        { OutputKey: 'DeliveryAssetsBucketName', OutputValue: 'despensalista-prod-assets' },
      ] }] };
    }
    if (args[0] === 'cloudformation') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [
      { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-prod-backend-api' },
      { OutputKey: 'WebBucketName', OutputValue: 'despensalista-prod-web' },
      { OutputKey: 'CloudFrontDistributionId', OutputValue: 'E123' },
    ] }] };
    if (args.includes('publish-version')) return { Version: '7' };
    if (args.includes('get-function-concurrency')) {
      return reservedConcurrency === undefined
        ? {}
        : { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('put-function-concurrency')) {
      reservedConcurrency = Number(
        args[args.indexOf('--reserved-concurrent-executions') + 1],
      );
      return {};
    }
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('create-invalidation')) return { Invalidation: { Id: 'I1' } };
    if (args.includes('get-parameter')) {
      const error = new Error('ParameterNotFound');
      error.name = 'ParameterNotFound';
      throw error;
    }
    if (args.includes('get-alias')) {
      const error = new Error('ResourceNotFoundException: alias does not exist');
      error.name = 'ResourceNotFoundException';
      throw error;
    }
    return {};
  };

  await captureDeployment({ stage: 'prod', directory, aws });
  reservedConcurrency = 0;
  await restoreDeployment({
    stage: 'prod', directory, aws, wait: async () => {},
  });

  assert.equal(calls.some(args => args.includes('update-alias')), false);
  assert.ok(calls.some(args => args.includes('put-function-concurrency') && args.includes('7')));
  assert.ok(calls.some(args => args[0] === 's3' && args.includes('--delete')));
  assert.ok(calls.some(args => args.includes('create-invalidation')));
});

test('reuses the latest published version on consecutive aliasless captures', async () => {
  const { captureDeployment } = await load();
  const firstDirectory = await mkdtemp(path.join(os.tmpdir(), 'pantry-rollback-'));
  const secondDirectory = await mkdtemp(path.join(os.tmpdir(), 'pantry-rollback-'));
  let publishCalls = 0;
  const aws = args => {
    if (args[0] === 'cloudformation') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [
      { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-tst-backend' },
      { OutputKey: 'WebBucketName', OutputValue: 'despensalista-tst-web' },
      { OutputKey: 'CloudFrontDistributionId', OutputValue: 'E123' },
    ] }] };
    if (args.includes('publish-version')) {
      publishCalls += 1;
      if (publishCalls === 1) return { Version: '7' };
      const error = new Error('ResourceConflictException: no changes since version 7');
      error.name = 'ResourceConflictException';
      throw error;
    }
    if (args.includes('list-versions-by-function')) {
      return { Versions: [{ Version: '$LATEST' }, { Version: '6' }, { Version: '7' }] };
    }
    return {};
  };

  await captureDeployment({ stage: 'tst', directory: firstDirectory, aws });
  await captureDeployment({ stage: 'tst', directory: secondDirectory, aws });

  const secondState = JSON.parse(
    await readFile(path.join(secondDirectory, 'state.json'), 'utf8'),
  );
  assert.equal(secondState.version, '7');
  assert.equal(publishCalls, 2);
});

test('refuses to snapshot a backend stack while CloudFormation is still mutating it', async () => {
  const { captureDeployment } = await load();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-rollback-'));
  await assert.rejects(
    captureDeployment({
      stage: 'prod',
      directory,
      aws: args => {
        assert.equal(args[0], 'cloudformation');
        return { Stacks: [{ StackStatus: 'UPDATE_IN_PROGRESS' }] };
      },
    }),
    /not stable|UPDATE_IN_PROGRESS/i,
  );
});

test('persists the intended release and durable frontend before stopping writers', async () => {
  const { armProductionDrain } = await load();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-rollback-'));
  const artifact = await releaseArtifact();
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({
    stage: 'prod',
    functionName: 'despensalista-prod-backend-api',
    alias: 'live',
    aliasExisted: true,
    version: '12',
    deploymentVersion: '12',
    deploymentReleaseId: 'b'.repeat(12),
    reservedConcurrency: 7,
    bucket: 'despensalista-prod-web',
    distribution: 'E123',
  }));
  const calls = [];
  let marker = JSON.stringify(drainMarker({ active: false }));
  const aws = args => {
    calls.push(args);
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return { Version: 1 };
    }
    if (args.includes('get-parameter')) {
      if (marker !== undefined) return { Parameter: { Value: marker } };
      const error = new Error('ParameterNotFound');
      error.name = 'ParameterNotFound';
      throw error;
    }
    if (args[0] === 'cloudformation') {
      return { Stacks: [{
        StackStatus: 'UPDATE_COMPLETE',
        Outputs: [
          { OutputKey: 'DeliveryAssetsBucketName', OutputValue: 'despensalista-prod-assets' },
        ],
      }] };
    }
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    return {};
  };

  await armProductionDrain({
    stage: 'prod', directory, artifact, aws, wait: async () => {},
  });
  const stored = JSON.parse(marker);
  assert.equal(stored.releaseId, 'a'.repeat(12));
  assert.equal(stored.codeSha256, RELEASE_CODE_SHA256);
  assert.equal(stored.webBucket, 'despensalista-prod-web');
  assert.equal(stored.distribution, 'E123');
  assert.equal(stored.recoveryBucket, 'despensalista-prod-assets');
  assert.match(stored.recoveryPrefix, /^deployment-recovery\/a{12}\/[0-9a-f-]+\/frontend$/);
  const snapshot = calls.findIndex(args =>
    args[0] === 's3' && args[1] === 'sync' &&
    args[2] === path.join(directory, 'frontend') &&
    args[3] === `s3://${stored.recoveryBucket}/${stored.recoveryPrefix}/`);
  const markerWrites = calls
    .map((args, index) => args.includes('put-parameter') ? index : -1)
    .filter(index => index >= 0);
  const pending = JSON.parse(
    calls[markerWrites.at(-2)][calls[markerWrites.at(-2)].indexOf('--value') + 1],
  );
  const active = JSON.parse(
    calls[markerWrites.at(-1)][calls[markerWrites.at(-1)].indexOf('--value') + 1],
  );
  const staleCleanup = calls.findIndex(args =>
    args[0] === 's3' && args[1] === 'rm' &&
    args[2] === 's3://despensalista-prod-assets/deployment-recovery/aaaaaaaaaaaa/test/frontend/');
  assert.equal(pending.active, false);
  assert.equal(active.active, true);
  assert.equal(pending.recoveryPrefix, active.recoveryPrefix);
  assert.ok(staleCleanup >= 0 && staleCleanup < markerWrites.at(-2));
  assert.ok(calls[snapshot].includes('--cache-control') && calls[snapshot].includes('no-cache'));
  const drain = calls.findIndex(args => args.includes('put-function-concurrency'));
  assert.ok(
    markerWrites.at(-2) < snapshot && snapshot < markerWrites.at(-1) &&
    markerWrites.at(-1) < drain,
  );
});

test('activates an exact redeploy after manual alias rollback while writers stay drained', async () => {
  const { activateProductionRelease } = await load();
  const calls = [];
  let reservedConcurrency = 0;
  const marker = JSON.stringify(drainMarker({
    deploymentReleaseId: 'a'.repeat(12),
  }));
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args[0] === 'cloudformation') return backendStack('12');
    if (args.includes('get-alias')) return { FunctionVersion: '11' };
    if (args.includes('get-function')) {
      return { Configuration: { CodeSha256: RELEASE_CODE_SHA256 } };
    }
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('get-function-concurrency')) {
      return { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('put-function-concurrency')) {
      reservedConcurrency = Number(args[args.indexOf('--reserved-concurrent-executions') + 1]);
      return {};
    }
    return {};
  };

  assert.equal(await activateProductionRelease({
    stage: 'prod', aws, wait: async () => {},
  }), true);

  const drain = calls.findIndex(args => args.includes('put-function-concurrency'));
  const alias = calls.findIndex(args => args.includes('update-alias'));
  assert.equal(reservedConcurrency, 0);
  assert.ok(drain >= 0 && drain < alias);
  assert.equal(
    calls[alias][calls[alias].indexOf('--function-version') + 1],
    '12',
  );
});

test('reactivates an exact non-production release after manual rollback before reconcile', async () => {
  const { activatePublishedRelease, reconcilePublishedRelease } = await load();
  assert.equal(typeof activatePublishedRelease, 'function');
  const artifact = await releaseArtifact();
  const calls = [];
  let aliasVersion = '11';
  const aws = args => {
    calls.push(args);
    if (args[0] === 'cloudformation') {
      return { Stacks: [{
        StackStatus: 'UPDATE_COMPLETE',
        Outputs: [
          { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-tst-backend-api' },
          { OutputKey: 'ServerlessBackendLiveAliasArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:despensalista-tst-backend-api:live' },
          { OutputKey: 'ServerlessBackendVersion', OutputValue: '12' },
          { OutputKey: 'DeploymentReleaseId', OutputValue: 'a'.repeat(12) },
          { OutputKey: 'WebBucketName', OutputValue: 'despensalista-tst-web' },
          { OutputKey: 'CloudFrontDistributionId', OutputValue: 'E123' },
        ],
      }] };
    }
    if (args.includes('get-alias')) return { FunctionVersion: aliasVersion };
    if (args.includes('get-function')) {
      return { Configuration: { CodeSha256: RELEASE_CODE_SHA256 } };
    }
    if (args.includes('update-alias')) {
      aliasVersion = args[args.indexOf('--function-version') + 1];
      return { FunctionVersion: aliasVersion };
    }
    if (args.includes('create-invalidation')) {
      return { Invalidation: { Id: 'I1' } };
    }
    return {};
  };

  await activatePublishedRelease({ stage: 'tst', artifact, aws });
  await activatePublishedRelease({ stage: 'tst', artifact, aws });
  await reconcilePublishedRelease({ stage: 'tst', artifact, aws });

  assert.equal(aliasVersion, '12');
  assert.equal(calls.filter(args => args.includes('update-alias')).length, 1);
  const activation = calls.findIndex(args => args.includes('update-alias'));
  const frontendPublish = calls.findIndex(args => args[0] === 's3');
  assert.ok(activation >= 0 && activation < frontendPublish);
});

test('non-production activation rejects stack identity or code that is not the artifact', async () => {
  const { activatePublishedRelease } = await load();
  assert.equal(typeof activatePublishedRelease, 'function');
  const artifact = await releaseArtifact();
  const aws = ({ releaseId = 'a'.repeat(12), codeSha256 = RELEASE_CODE_SHA256 }) => args => {
    if (args[0] === 'cloudformation') {
      return { Stacks: [{
        StackStatus: 'UPDATE_COMPLETE',
        Outputs: [
          { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-dev-backend-api' },
          { OutputKey: 'ServerlessBackendLiveAliasArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:despensalista-dev-backend-api:live' },
          { OutputKey: 'ServerlessBackendVersion', OutputValue: '12' },
          { OutputKey: 'DeploymentReleaseId', OutputValue: releaseId },
          { OutputKey: 'WebBucketName', OutputValue: 'despensalista-dev-web' },
          { OutputKey: 'CloudFrontDistributionId', OutputValue: 'E123' },
        ],
      }] };
    }
    if (args.includes('get-function')) return { Configuration: { CodeSha256: codeSha256 } };
    if (args.includes('get-alias')) return { FunctionVersion: '11' };
    if (args.includes('update-alias')) assert.fail('must not activate an unverified release');
    return {};
  };

  await assert.rejects(
    activatePublishedRelease({ stage: 'dev', artifact, aws: aws({ releaseId: 'b'.repeat(12) }) }),
    /releaseId|release artifact/i,
  );
  await assert.rejects(
    activatePublishedRelease({ stage: 'dev', artifact, aws: aws({ codeSha256: 'wrong' }) }),
    /hash|release artifact/i,
  );
});

test('releases a verified drain without rolling back its new alias', async () => {
  const { finalizeProductionDrain, releaseProductionDrain } = await load();
  const calls = [];
  let reservedConcurrency = 0;
  let marker = JSON.stringify(drainMarker({
    phase: 'verified', verifiedVersion: '13', deploymentVersion: null,
    reservedConcurrency: 7,
  }));
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args.includes('get-function-concurrency')) {
      return reservedConcurrency === undefined ? {} : { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('delete-function-concurrency')) {
      reservedConcurrency = undefined;
      return {};
    }
    if (args.includes('put-function-concurrency')) {
      reservedConcurrency = Number(args[args.indexOf('--reserved-concurrent-executions') + 1]);
      return {};
    }
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return {};
    }
    return {};
  };

  assert.equal(await releaseProductionDrain({ stage: 'prod', aws }), true);
  assert.equal(reservedConcurrency, 7);
  assert.equal(calls.some(args => args.includes('update-alias')), false);
  assert.deepEqual(
    { active: JSON.parse(marker).active, phase: JSON.parse(marker).phase },
    { active: true, phase: 'smoke_pending' },
  );
  assert.equal(calls.some(args => args[0] === 's3' && args[1] === 'rm'), false);
  const smokePendingWrite = calls.findIndex(args =>
    args.includes('put-parameter') &&
    JSON.parse(args[args.indexOf('--value') + 1]).phase === 'smoke_pending');
  const concurrencyRestore = calls.findIndex(args =>
    args.includes('put-function-concurrency') && args.includes('7'));
  assert.ok(smokePendingWrite >= 0 && smokePendingWrite < concurrencyRestore);

  assert.equal(finalizeProductionDrain({ stage: 'prod', aws }), true);
  const tombstone = calls.findLastIndex(args => args.includes('put-parameter'));
  const cleanup = calls.findIndex(args => args[0] === 's3' && args[1] === 'rm');
  assert.ok(tombstone >= 0 && tombstone < cleanup);
  assert.deepEqual(calls[cleanup].slice(0, 4), [
    's3', 'rm',
    's3://despensalista-prod-assets/deployment-recovery/aaaaaaaaaaaa/test/frontend/',
    '--recursive',
  ]);
  assert.equal(JSON.parse(marker).active, false);
});

test('smoke-pending hard death rolls back instead of adopting the reconciled release', async () => {
  const { recoverProductionDrain } = await load();
  const calls = [];
  let reservedConcurrency = 7;
  let marker = JSON.stringify(drainMarker({
    phase: 'smoke_pending', verifiedVersion: '13', reservedConcurrency: 7,
  }));
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return {};
    }
    if (args[0] === 'cloudformation') return backendStack('13');
    if (args.includes('get-alias')) return { FunctionVersion: '13' };
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('get-function-concurrency')) {
      return { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('put-function-concurrency')) {
      reservedConcurrency = Number(args[args.indexOf('--reserved-concurrent-executions') + 1]);
      return {};
    }
    if (args.includes('create-invalidation')) return { Invalidation: { Id: 'I1' } };
    return {};
  };

  await recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} });

  const alias = calls.find(args => args.includes('update-alias'));
  assert.equal(alias[alias.indexOf('--function-version') + 1], '12');
  assert.ok(calls.some(args =>
    args[0] === 's3' && args[1] === 'sync' &&
    args[2].startsWith('s3://despensalista-prod-assets/')));
  assert.equal(reservedConcurrency, 7);
  assert.equal(JSON.parse(marker).active, false);
});

test('armed hard-death recovery conservatively restores the durable snapshot without an artifact', async () => {
  const { recoverProductionDrain } = await load();
  const calls = [];
  let reservedConcurrency = 0;
  let marker = JSON.stringify(drainMarker({ deploymentVersion: '12' }));
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return { Version: 2 };
    }
    if (args[0] === 'cloudformation') return backendStack('12');
    if (args.includes('get-alias')) return { FunctionVersion: '12' };
    if (args.includes('get-function')) {
      return { Configuration: { CodeSha256: RELEASE_CODE_SHA256 } };
    }
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('get-function-concurrency')) {
      return reservedConcurrency === undefined ? {} : { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('delete-function-concurrency')) {
      reservedConcurrency = undefined;
      return {};
    }
    if (args.includes('create-invalidation')) return { Invalidation: { Id: 'I1' } };
    return {};
  };

  await recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} });

  assert.equal(reservedConcurrency, undefined);
  assert.ok(calls.some(args => args.includes('update-alias') && args.includes('12')));
  assert.ok(calls.some(args =>
    args[0] === 's3' && args[1] === 'sync' &&
    args[2].startsWith('s3://despensalista-prod-assets/')));
  assert.equal(calls.some(args => args.includes('get-function')), false);
  assert.equal(JSON.parse(marker).active, false);
});

test('armed recovery rejects another releaseId even when its Lambda hash matches', async () => {
  const { recoverProductionDrain } = await load();
  const calls = [];
  let marker = JSON.stringify(drainMarker());
  let reservedConcurrency = 0;
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return {};
    }
    if (args[0] === 'cloudformation') return backendStack('13', 'c'.repeat(12));
    if (args.includes('get-alias')) return { FunctionVersion: '13' };
    if (args.includes('get-function')) {
      return { Configuration: { CodeSha256: RELEASE_CODE_SHA256 } };
    }
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('get-function-concurrency')) {
      return reservedConcurrency === undefined ? {} : { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('put-function-concurrency')) {
      reservedConcurrency = Number(args[args.indexOf('--reserved-concurrent-executions') + 1]);
      return {};
    }
    if (args.includes('delete-function-concurrency')) {
      reservedConcurrency = undefined;
      return {};
    }
    if (args.includes('create-invalidation')) return { Invalidation: { Id: 'I1' } };
    return {};
  };

  await recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} });

  const alias = calls.find(args => args.includes('update-alias'));
  assert.equal(alias[alias.indexOf('--function-version') + 1], '12');
  assert.ok(calls.some(args => args[0] === 's3' && args[1] === 'sync'));
});

test('armed recovery does not adopt a target releaseId already present in the baseline output', async () => {
  const { recoverProductionDrain } = await load();
  const calls = [];
  let marker = JSON.stringify(drainMarker({
    deploymentReleaseId: 'a'.repeat(12),
  }));
  let reservedConcurrency = 0;
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return {};
    }
    if (args[0] === 'cloudformation') return backendStack('12');
    if (args.includes('get-alias')) return { FunctionVersion: '12' };
    if (args.includes('get-function')) {
      return { Configuration: { CodeSha256: RELEASE_CODE_SHA256 } };
    }
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('get-function-concurrency')) {
      return reservedConcurrency === undefined ? {} : { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('put-function-concurrency')) {
      reservedConcurrency = Number(args[args.indexOf('--reserved-concurrent-executions') + 1]);
      return {};
    }
    if (args.includes('delete-function-concurrency')) {
      reservedConcurrency = undefined;
      return {};
    }
    if (args.includes('create-invalidation')) return { Invalidation: { Id: 'I1' } };
    return {};
  };

  await recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} });

  assert.ok(calls.some(args =>
    args[0] === 's3' && args[1] === 'sync' &&
    args[2].startsWith('s3://despensalista-prod-assets/')));
});

test('verified hard-death recovery rolls back despite an exact target and baseline drift', async () => {
  const { markProductionDrainVerified, recoverProductionDrain } = await load();
  const calls = [];
  let reservedConcurrency = 0;
  let marker = JSON.stringify(drainMarker({ deploymentVersion: '14' }));
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return { Version: 2 };
    }
    if (args[0] === 'cloudformation') return backendStack('15');
    if (args.includes('get-alias')) return { FunctionVersion: '15' };
    if (args.includes('get-function')) {
      return { Configuration: { CodeSha256: RELEASE_CODE_SHA256 } };
    }
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('get-function-concurrency')) {
      return reservedConcurrency === undefined ? {} : { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('delete-function-concurrency')) {
      reservedConcurrency = undefined;
      return {};
    }
    if (args.includes('create-invalidation')) return { Invalidation: { Id: 'I1' } };
    return {};
  };

  await markProductionDrainVerified({ stage: 'prod', aws });
  assert.deepEqual(
    { phase: JSON.parse(marker).phase, verifiedVersion: JSON.parse(marker).verifiedVersion },
    { phase: 'verified', verifiedVersion: '15' },
  );
  await recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} });

  assert.equal(reservedConcurrency, undefined);
  const alias = calls.find(args => args.includes('update-alias'));
  assert.equal(alias[alias.indexOf('--function-version') + 1], '12');
  assert.ok(calls.some(args =>
    args[0] === 's3' && args[1] === 'sync' &&
    args[2].startsWith('s3://despensalista-prod-assets/')));
  assert.equal(JSON.parse(marker).active, false);
});

test('verified recovery rolls back when the alias no longer matches verifiedVersion', async () => {
  const { recoverProductionDrain } = await load();
  const calls = [];
  let marker = JSON.stringify(drainMarker({
    phase: 'verified', deploymentVersion: '14', verifiedVersion: '15',
  }));
  let reservedConcurrency = 0;
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return {};
    }
    if (args[0] === 'cloudformation') return backendStack('15');
    if (args.includes('get-alias')) return { FunctionVersion: '16' };
    if (args.includes('get-function')) {
      return { Configuration: { CodeSha256: RELEASE_CODE_SHA256 } };
    }
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('get-function-concurrency')) {
      return reservedConcurrency === undefined ? {} : { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('put-function-concurrency')) {
      reservedConcurrency = Number(args[args.indexOf('--reserved-concurrent-executions') + 1]);
      return {};
    }
    if (args.includes('delete-function-concurrency')) {
      reservedConcurrency = undefined;
      return {};
    }
    if (args.includes('create-invalidation')) return { Invalidation: { Id: 'I1' } };
    return {};
  };

  await recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} });

  const alias = calls.find(args => args.includes('update-alias'));
  assert.equal(alias[alias.indexOf('--function-version') + 1], '12');
  assert.ok(calls.some(args =>
    args[0] === 's3' && args[2].startsWith('s3://despensalista-prod-assets/') &&
    args[3] === 's3://despensalista-prod-web/' && args.includes('--delete')));
  assert.equal(JSON.parse(marker).active, false);
});

test('an interrupted rollback resumes the durable snapshot after deaths at alias and sync', async () => {
  const { recoverProductionDrain } = await load();
  const calls = [];
  let marker = JSON.stringify(drainMarker({ phase: 'rollback' }));
  let reservedConcurrency = 0;
  let death = 'after-alias';
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return { Version: 2 };
    }
    if (args[0] === 'cloudformation') return backendStack('13');
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('get-function-concurrency')) {
      return reservedConcurrency === undefined ? {} : { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('put-function-concurrency')) {
      reservedConcurrency = Number(args[args.indexOf('--reserved-concurrent-executions') + 1]);
      return {};
    }
    if (args.includes('delete-function-concurrency')) {
      reservedConcurrency = undefined;
      return {};
    }
    if (args[0] === 's3' && death === 'after-alias') {
      death = 'after-sync';
      throw new Error('simulated death');
    }
    if (args.includes('create-invalidation')) {
      if (death === 'after-sync') {
        death = 'finish';
        throw new Error('simulated death');
      }
      return { Invalidation: { Id: 'I1' } };
    }
    return {};
  };

  await assert.rejects(
    recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} }),
    /simulated death/,
  );
  await assert.rejects(
    recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} }),
    /simulated death/,
  );
  await recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} });

  const rollbackCalls = calls.filter(args => args.includes('update-alias'));
  const copyCalls = calls.filter(args => args[0] === 's3' && args[1] === 'cp');
  const snapshotCalls = calls.filter(args => args[0] === 's3' && args[1] === 'sync');
  assert.equal(rollbackCalls.length, 3);
  assert.ok(rollbackCalls.every(args =>
    args[args.indexOf('--function-version') + 1] === '12'));
  assert.equal(snapshotCalls.length, 2);
  assert.equal(copyCalls.length, 3);
  assert.ok(copyCalls.every(args =>
    args[2] === 's3://despensalista-prod-assets/deployment-recovery/aaaaaaaaaaaa/test/frontend/' &&
    args[3] === 's3://despensalista-prod-web/' && args.includes('--recursive') &&
    args.includes('--copy-props') && args.includes('metadata-directive')));
  assert.ok(snapshotCalls.every(args =>
    args[2] === 's3://despensalista-prod-assets/deployment-recovery/aaaaaaaaaaaa/test/frontend/' &&
    args[3] === 's3://despensalista-prod-web/' && args.includes('--delete')));
  assert.equal(reservedConcurrency, undefined);
  assert.equal(JSON.parse(marker).active, false);
});

test('a failed CloudFormation rollback restores frontend but keeps writers drained', async () => {
  const { recoverProductionDrain } = await load();
  const calls = [];
  let reservedConcurrency = 0;
  let marker = JSON.stringify(drainMarker({ phase: 'rollback' }));
  const aws = args => {
    calls.push(args);
    if (args.includes('get-parameter')) return { Parameter: { Value: marker } };
    if (args.includes('put-parameter')) {
      marker = args[args.indexOf('--value') + 1];
      return {};
    }
    if (args[0] === 'cloudformation') {
      return { Stacks: [{ StackStatus: 'UPDATE_ROLLBACK_FAILED' }] };
    }
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('get-function-concurrency')) {
      return { ReservedConcurrentExecutions: reservedConcurrency };
    }
    if (args.includes('put-function-concurrency')) {
      reservedConcurrency = Number(args[args.indexOf('--reserved-concurrent-executions') + 1]);
      return {};
    }
    if (args.includes('create-invalidation')) return { Invalidation: { Id: 'I1' } };
    return {};
  };

  await assert.rejects(
    recoverProductionDrain({ stage: 'prod', aws, wait: async () => {} }),
    /UPDATE_ROLLBACK_FAILED|not stable/i,
  );

  assert.ok(calls.some(args => args.includes('update-alias') && args.includes('12')));
  assert.ok(calls.some(args =>
    args[0] === 's3' && args[1] === 'sync' && args.includes('--delete')));
  assert.ok(calls.some(args =>
    args[0] === 'cloudfront' && args.includes('invalidation-completed')));
  assert.equal(reservedConcurrency, 0);
  assert.deepEqual(
    { active: JSON.parse(marker).active, phase: JSON.parse(marker).phase },
    { active: true, phase: 'rollback' },
  );
  assert.equal(calls.some(args => args[0] === 's3' && args[1] === 'rm'), false);
});

test('refuses to restore another environment snapshot', async () => {
  const { restoreDeployment } = await load();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-rollback-'));
  await mkdir(path.join(directory, 'frontend'));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ stage: 'dev', version: '12' }));
  await assert.rejects(restoreDeployment({ stage: 'prod', directory, aws: () => assert.fail('must not mutate AWS') }), /stage/i);
});

test('manual rollback uses the recorded stage version when a newer version has the same code', async () => {
  const { recordPublishedRelease, restoreRelease } = await load();
  const artifact = await mkdtemp(path.join(os.tmpdir(), 'pantry-release-'));
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'pantry-receipt-'));
  const deploymentSha = 'b'.repeat(40);
  const files = [['backend/lambda.zip', 'zip-bytes'], ['frontend/dist/frontend/browser/index.html', 'frontend']];
  for (const [name, contents] of files) {
    await mkdir(path.dirname(path.join(artifact, 'payload', name)), { recursive: true });
    await writeFile(path.join(artifact, 'payload', name), contents);
  }
  await writeFile(path.join(artifact, 'release-manifest.json'), JSON.stringify({
    schemaVersion: 1, sourceSha: 'a'.repeat(40), releaseId: 'a'.repeat(12),
    files: files.map(([name, contents]) => ({ path: name, size: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex') })),
  }));
  const calls = [];
  const codeHash = createHash('sha256').update('zip-bytes').digest('base64');
  let versions = [
    { Version: '12', CodeSha256: 'wrong' },
    { Version: '14', CodeSha256: codeHash },
  ];
  const aws = args => {
    calls.push(args);
    if (args[0] === 'sts') return { Account: '765932874577' };
    if (args[0] === 'cloudformation') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [
      { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-tst-backend' },
      { OutputKey: 'ServerlessBackendLiveAliasArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:despensalista-tst-backend:live' },
      { OutputKey: 'ServerlessBackendVersion', OutputValue: '12' },
      { OutputKey: 'DeploymentReleaseId', OutputValue: 'a'.repeat(12) },
      { OutputKey: 'WebBucketName', OutputValue: 'despensalista-tst-web' },
      { OutputKey: 'CloudFrontDistributionId', OutputValue: 'E123' },
    ] }] };
    if (args.includes('get-alias')) return { FunctionVersion: '12' };
    if (args.includes('get-function')) return { Configuration: { CodeSha256: codeHash } };
    if (args.includes('list-versions-by-function')) return { Versions: versions };
    return {};
  };
  const env = { AWS_REGION: 'us-east-1' };
  await recordPublishedRelease({
    stage: 'tst', artifact, directory: receiptDirectory, deploymentSha, aws, env,
  });
  const receiptPath = path.join(receiptDirectory, 'deployment-receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.account, '765932874577');
  assert.equal(receipt.region, 'us-east-1');
  assert.equal(receipt.stage, 'tst');
  assert.equal(receipt.sourceSha, 'a'.repeat(40));
  assert.equal(receipt.releaseId, 'a'.repeat(12));
  assert.equal(receipt.version, '12');
  assert.match(receipt.frontendManifestSha256, /^[a-f0-9]{64}$/);
  await writeFile(receiptPath, JSON.stringify({
    ...receipt, frontendManifestSha256: '0'.repeat(64),
  }));
  await assert.rejects(restoreRelease({
    stage: 'tst', artifact, receipt: receiptPath, deploymentSha, aws, env,
  }), /frontendManifestSha256/);
  assert.equal(calls.some(args => args.includes('update-alias')), false);
  await writeFile(receiptPath, JSON.stringify(receipt));
  versions = [
    { Version: '12', CodeSha256: 'wrong' },
    { Version: '14', CodeSha256: codeHash },
  ];
  await assert.rejects(restoreRelease({
    stage: 'tst', artifact, receipt: receiptPath, deploymentSha, aws, env,
  }), /unavailable|does not match/);
  assert.equal(calls.some(args => args.includes('update-alias')), false);
  versions = [
    { Version: '12', CodeSha256: codeHash },
    { Version: '14', CodeSha256: codeHash },
  ];
  await restoreRelease({
    stage: 'tst',
    artifact,
    receipt: receiptPath,
    deploymentSha,
    aws,
    env,
  });
  const aliasUpdate = calls.find(args => args.includes('update-alias'));
  assert.equal(aliasUpdate[aliasUpdate.indexOf('--function-version') + 1], '12');
});

test('production rollback releases an orphaned zero-concurrency drain before restoring', async () => {
  const { recordPublishedRelease, restoreRelease } = await load();
  const artifact = await releaseArtifact();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-receipt-'));
  const deploymentSha = 'b'.repeat(40);
  const codeSha256 = createHash('sha256').update('zip-bytes').digest('base64');
  const calls = [];
  const recordAws = deploymentAws({
    aliasVersion: '12', stackVersion: '12', codeSha256, calls,
  });
  const env = { AWS_REGION: 'us-east-1' };

  await recordPublishedRelease({
    stage: 'prod', artifact, directory, deploymentSha, aws: recordAws, env,
  });
  const restoreAws = deploymentAws({
    aliasVersion: '12', stackVersion: '12', codeSha256, calls,
    reservedConcurrency: 0,
  });
  await restoreRelease({
    stage: 'prod', artifact,
    receipt: path.join(directory, 'deployment-receipt.json'),
    deploymentSha, aws: restoreAws, env, wait: async () => {},
  });

  const releaseDrain = calls.findIndex(args => args.includes('delete-function-concurrency'));
  const aliasUpdate = calls.findIndex(args => args.includes('update-alias'));
  const rollbackDrain = calls.findIndex(args =>
    args.includes('put-function-concurrency') && args.includes('0'));
  const frontendRestore = calls.findIndex(args =>
    args[0] === 's3' && args[1] === 'sync' &&
    args[3] === 's3://despensalista-prod-web/' && args.includes('--delete'));
  const frontendCopy = calls.findIndex(args =>
    args[0] === 's3' && args[1] === 'cp' &&
    args[3] === 's3://despensalista-prod-web/' && args.includes('--recursive') &&
    args.includes('--copy-props') && args.includes('metadata-directive'));
  const invalidationWait = calls.findIndex(args =>
    args[0] === 'cloudfront' && args.includes('invalidation-completed'));
  assert.ok(rollbackDrain >= 0 && rollbackDrain < aliasUpdate);
  assert.ok(aliasUpdate < frontendCopy && frontendCopy < frontendRestore);
  assert.ok(frontendRestore < invalidationWait);
  assert.ok(invalidationWait < releaseDrain);
  assert.ok(releaseDrain >= 0);
  assert.ok(aliasUpdate >= 0 && aliasUpdate < releaseDrain);
});

test('production rollback confirms a concurrency restore that succeeds on the fifth write', async () => {
  const { recordPublishedRelease, restoreRelease } = await load();
  const artifact = await releaseArtifact();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-receipt-'));
  const deploymentSha = 'b'.repeat(40);
  const codeSha256 = createHash('sha256').update('zip-bytes').digest('base64');
  const calls = [];
  const env = { AWS_REGION: 'us-east-1' };
  await recordPublishedRelease({
    stage: 'prod', artifact, directory, deploymentSha,
    aws: deploymentAws({ aliasVersion: '12', stackVersion: '12', codeSha256 }),
    env,
  });
  const aws = deploymentAws({
    aliasVersion: '12', stackVersion: '12', codeSha256, calls,
    reservedConcurrency: 0, concurrencyWriteFailures: 4,
  });

  await restoreRelease({
    stage: 'prod', artifact,
    receipt: path.join(directory, 'deployment-receipt.json'),
    deploymentSha, aws, env, wait: async () => {},
  });

  assert.equal(
    calls.filter(args => args.includes('delete-function-concurrency')).length,
    5,
  );
});

test('record refuses an alias that does not serve the stack version', async () => {
  const { recordPublishedRelease } = await load();
  const artifact = await releaseArtifact();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-receipt-'));
  const codeSha256 = createHash('sha256').update('zip-bytes').digest('base64');
  const aws = deploymentAws({ aliasVersion: '11', stackVersion: '12', codeSha256 });

  await assert.rejects(
    recordPublishedRelease({
      stage: 'prod', artifact, directory, deploymentSha: 'b'.repeat(40), aws,
      env: { AWS_REGION: 'us-east-1' },
    }),
    /alias|version|hash|match/i,
  );
});

test('record refuses a stack version whose code hash differs from the artifact', async () => {
  const { recordPublishedRelease } = await load();
  const artifact = await releaseArtifact();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-receipt-'));
  const aws = deploymentAws({ aliasVersion: '12', stackVersion: '12', codeSha256: 'wrong' });

  await assert.rejects(
    recordPublishedRelease({
      stage: 'prod', artifact, directory, deploymentSha: 'b'.repeat(40), aws,
      env: { AWS_REGION: 'us-east-1' },
    }),
    /hash|match/i,
  );
});

test('verifies the exact backend without publishing frontend assets', async () => {
  const { verifyPublishedRelease } = await load();
  const artifact = await releaseArtifact();
  const codeSha256 = createHash('sha256').update('zip-bytes').digest('base64');
  const calls = [];
  const aws = deploymentAws({ aliasVersion: '12', stackVersion: '12', codeSha256, calls });

  await verifyPublishedRelease({ stage: 'prod', artifact, aws });

  assert.equal(calls.some(args => args[0] === 's3'), false);
  assert.equal(calls.some(args => args.includes('create-invalidation')), false);
});

test('reconcile validates the exact stack version before publishing the frontend', async () => {
  const module = await load();
  assert.equal(typeof module.reconcilePublishedRelease, 'function');
  const artifact = await releaseArtifact();
  const codeSha256 = createHash('sha256').update('zip-bytes').digest('base64');
  const calls = [];
  const aws = deploymentAws({ aliasVersion: '12', stackVersion: '12', codeSha256, calls });

  await module.reconcilePublishedRelease({ stage: 'prod', artifact, aws });

  assert.equal(calls.some(args => args.includes('update-alias')), false);
  const frontendCopy = calls.findIndex(args =>
    args[0] === 's3' && args[1] === 'cp' && args.includes('--recursive'));
  const frontendSync = calls.findIndex(args =>
    args[0] === 's3' && args[1] === 'sync' && args.includes('--delete'));
  assert.ok(frontendCopy >= 0 && frontendCopy < frontendSync);
  assert.ok(calls.some(args => args.includes('create-invalidation')));
  assert.ok(calls.some(args =>
    args[0] === 'cloudfront' && args.includes('invalidation-completed')));
});

test('reconcile never publishes frontend or bypasses canary when alias drifted', async () => {
  const module = await load();
  assert.equal(typeof module.reconcilePublishedRelease, 'function');
  const artifact = await releaseArtifact();
  const codeSha256 = createHash('sha256').update('zip-bytes').digest('base64');
  const calls = [];
  const aws = deploymentAws({ aliasVersion: '14', stackVersion: '12', codeSha256, calls });

  await assert.rejects(
    module.reconcilePublishedRelease({ stage: 'prod', artifact, aws }),
    /alias|version|match/i,
  );
  assert.equal(calls.some(args => args[0] === 's3'), false);
  assert.equal(calls.some(args => args.includes('update-alias')), false);
});

test('reconcile validates the stack version hash before publishing the frontend', async () => {
  const module = await load();
  assert.equal(typeof module.reconcilePublishedRelease, 'function');
  const artifact = await releaseArtifact();
  const calls = [];
  const aws = deploymentAws({ aliasVersion: '12', stackVersion: '12', codeSha256: 'wrong', calls });

  await assert.rejects(
    module.reconcilePublishedRelease({ stage: 'prod', artifact, aws }),
    /hash|match/i,
  );
  assert.equal(calls.some(args => args[0] === 's3'), false);
  assert.equal(calls.some(args => args.includes('update-alias')), false);
});

async function releaseArtifact() {
  const artifact = await mkdtemp(path.join(os.tmpdir(), 'pantry-release-'));
  const files = [
    ['backend/lambda.zip', 'zip-bytes'],
    ['frontend/dist/frontend/browser/index.html', 'frontend'],
  ];
  for (const [name, contents] of files) {
    await mkdir(path.dirname(path.join(artifact, 'payload', name)), { recursive: true });
    await writeFile(path.join(artifact, 'payload', name), contents);
  }
  await writeFile(path.join(artifact, 'release-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    sourceSha: 'a'.repeat(40),
    releaseId: 'a'.repeat(12),
    files: files.map(([name, contents]) => ({
      path: name,
      size: Buffer.byteLength(contents),
      sha256: createHash('sha256').update(contents).digest('hex'),
    })),
  }));
  return artifact;
}

function drainMarker(overrides = {}) {
  return {
    schemaVersion: 1,
    active: true,
    phase: 'armed',
    stage: 'prod',
    functionName: 'despensalista-prod-backend-api',
    alias: 'live',
    aliasExisted: true,
    version: '12',
    deploymentVersion: '12',
    deploymentReleaseId: 'b'.repeat(12),
    reservedConcurrency: null,
    releaseId: 'a'.repeat(12),
    codeSha256: RELEASE_CODE_SHA256,
    webBucket: 'despensalista-prod-web',
    distribution: 'E123',
    recoveryBucket: 'despensalista-prod-assets',
    recoveryPrefix: 'deployment-recovery/aaaaaaaaaaaa/test/frontend',
    ...overrides,
  };
}

function backendStack(version, releaseId = 'a'.repeat(12)) {
  return { Stacks: [{
    StackStatus: 'UPDATE_COMPLETE',
    Outputs: [
      { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-prod-backend-api' },
      { OutputKey: 'ServerlessBackendLiveAliasArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:despensalista-prod-backend-api:live' },
      { OutputKey: 'ServerlessBackendVersion', OutputValue: version },
      { OutputKey: 'DeploymentReleaseId', OutputValue: releaseId },
      { OutputKey: 'WebBucketName', OutputValue: 'despensalista-prod-web' },
      { OutputKey: 'CloudFrontDistributionId', OutputValue: 'E123' },
    ],
  }] };
}

function deploymentAws({
  aliasVersion,
  stackVersion,
  codeSha256,
  calls = [],
  reservedConcurrency,
  concurrencyWriteFailures = 0,
}) {
  let currentReservedConcurrency = reservedConcurrency;
  let remainingConcurrencyWriteFailures = concurrencyWriteFailures;
  let drainMarker;
  return args => {
    calls.push(args);
    if (args[0] === 'sts') return { Account: '765932874577' };
    if (args.includes('despensalista-prod-cognito')) {
      return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [
        { OutputKey: 'DeliveryAssetsBucketName', OutputValue: 'despensalista-prod-assets' },
      ] }] };
    }
    if (args[0] === 'cloudformation') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [
      { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-prod-backend-api' },
      { OutputKey: 'ServerlessBackendLiveAliasArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:despensalista-prod-backend-api:live' },
      { OutputKey: 'ServerlessBackendVersion', OutputValue: stackVersion },
      { OutputKey: 'DeploymentReleaseId', OutputValue: 'a'.repeat(12) },
      { OutputKey: 'WebBucketName', OutputValue: 'despensalista-prod-web' },
      { OutputKey: 'CloudFrontDistributionId', OutputValue: 'E123' },
    ] }] };
    if (args.includes('get-alias')) return { FunctionVersion: aliasVersion };
    if (args.includes('get-function')) return { Configuration: { CodeSha256: codeSha256 } };
    if (args.includes('get-function-configuration')) return { Timeout: 1 };
    if (args.includes('list-versions-by-function')) {
      return { Versions: [{ Version: aliasVersion, CodeSha256: codeSha256 }] };
    }
    if (args.includes('get-function-concurrency')) {
      return currentReservedConcurrency === undefined
        ? {}
        : { ReservedConcurrentExecutions: currentReservedConcurrency };
    }
    if (args.includes('get-parameter')) {
      if (drainMarker !== undefined) return { Parameter: { Value: drainMarker } };
      const error = new Error('ParameterNotFound');
      error.name = 'ParameterNotFound';
      throw error;
    }
    if (args.includes('put-parameter')) {
      drainMarker = args[args.indexOf('--value') + 1];
      return { Version: 1 };
    }
    if (args.includes('delete-function-concurrency')) {
      if (remainingConcurrencyWriteFailures > 0) {
        remainingConcurrencyWriteFailures -= 1;
        throw new Error('transient concurrency write failure');
      }
      currentReservedConcurrency = undefined;
      return {};
    }
    if (args.includes('put-function-concurrency')) {
      const requested = Number(
        args[args.indexOf('--reserved-concurrent-executions') + 1],
      );
      if (requested === 0) {
        currentReservedConcurrency = 0;
        return {};
      }
      if (remainingConcurrencyWriteFailures > 0) {
        remainingConcurrencyWriteFailures -= 1;
        throw new Error('transient concurrency write failure');
      }
      currentReservedConcurrency = requested;
      return {};
    }
    if (args.includes('create-invalidation')) {
      return { Invalidation: { Id: 'I1' } };
    }
    return {};
  };
}
