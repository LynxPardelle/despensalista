import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const load = () => import(pathToFileURL(path.join(import.meta.dirname, 'deployment-state.mjs')));

test('captures and restores the published alias and frontend together', async () => {
  const { captureDeployment, restoreDeployment } = await load();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pantry-rollback-'));
  const calls = [];
  const aws = args => {
    calls.push(args);
    if (args[0] === 'cloudformation') return { Stacks: [{ Outputs: [
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
    if (args[0] === 'cloudformation') return { Stacks: [{ Outputs: [
      { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-tst-backend' },
      { OutputKey: 'ServerlessBackendLiveAliasArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:despensalista-tst-backend:live' },
      { OutputKey: 'ServerlessBackendVersion', OutputValue: '12' },
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

test('reconcile validates the exact stack version before publishing the frontend', async () => {
  const module = await load();
  assert.equal(typeof module.reconcilePublishedRelease, 'function');
  const artifact = await releaseArtifact();
  const codeSha256 = createHash('sha256').update('zip-bytes').digest('base64');
  const calls = [];
  const aws = deploymentAws({ aliasVersion: '12', stackVersion: '12', codeSha256, calls });

  await module.reconcilePublishedRelease({ stage: 'prod', artifact, aws });

  assert.equal(calls.some(args => args.includes('update-alias')), false);
  assert.ok(calls.some(args => args[0] === 's3' && args.includes('--delete')));
  assert.ok(calls.some(args => args.includes('create-invalidation')));
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

function deploymentAws({ aliasVersion, stackVersion, codeSha256, calls = [] }) {
  return args => {
    calls.push(args);
    if (args[0] === 'sts') return { Account: '765932874577' };
    if (args[0] === 'cloudformation') return { Stacks: [{ Outputs: [
      { OutputKey: 'ServerlessBackendFunctionName', OutputValue: 'despensalista-prod-backend' },
      { OutputKey: 'ServerlessBackendLiveAliasArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:despensalista-prod-backend:live' },
      { OutputKey: 'ServerlessBackendVersion', OutputValue: stackVersion },
      { OutputKey: 'WebBucketName', OutputValue: 'despensalista-prod-web' },
      { OutputKey: 'CloudFrontDistributionId', OutputValue: 'E123' },
    ] }] };
    if (args.includes('get-alias')) return { FunctionVersion: aliasVersion };
    if (args.includes('get-function')) return { Configuration: { CodeSha256: codeSha256 } };
    return {};
  };
}
