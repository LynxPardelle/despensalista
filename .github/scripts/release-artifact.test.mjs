import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const sourceSha = '0123456789abcdef0123456789abcdef01234567';

async function loadReleaseModule() {
  return import(pathToFileURL(path.join(import.meta.dirname, 'release-artifact.mjs')));
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'despensalista-release-test-'));
  await mkdir(path.join(root, 'backend', 'src'), { recursive: true });
  await mkdir(path.join(root, 'backend', 'node_modules', 'ignored'), {
    recursive: true,
  });
  await mkdir(path.join(root, 'infra', 'cognito', 'bin'), { recursive: true });
  await mkdir(path.join(root, 'infra', 'cognito', 'lib'), { recursive: true });
  await mkdir(path.join(root, 'infra', 'cognito', 'lambda', 'cognito-email-quota'), {
    recursive: true,
  });
  await mkdir(path.join(root, 'frontend', 'dist', 'frontend', 'browser'), {
    recursive: true,
  });
  await writeFile(path.join(root, 'backend', 'src', 'main.ts'), 'main');
  await writeFile(path.join(root, 'backend', 'lambda.zip'), 'prebuilt-lambda');
  await writeFile(path.join(root, 'backend', 'package.json'), '{}');
  await writeFile(path.join(root, 'backend', 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'backend', 'nest-cli.json'), '{}');
  await writeFile(path.join(root, 'backend', 'tsconfig.json'), '{}');
  await writeFile(path.join(root, 'backend', 'tsconfig.build.json'), '{}');
  await writeFile(path.join(root, 'backend', '.env'), 'SECRET=do-not-package');
  await writeFile(
    path.join(root, 'backend', 'node_modules', 'ignored', 'index.js'),
    'ignored',
  );
  await writeFile(path.join(root, 'infra', 'cognito', 'bin', 'app.ts'), 'app');
  await writeFile(path.join(root, 'infra', 'cognito', 'lib', 'stack.ts'), 'stack');
  await writeFile(
    path.join(root, 'infra', 'cognito', 'lambda', 'cognito-email-quota', 'index.js'),
    'exports.handler = async event => event;',
  );
  await writeFile(path.join(root, 'infra', 'cognito', 'package.json'), '{}');
  await writeFile(path.join(root, 'infra', 'cognito', 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'infra', 'cognito', 'cdk.json'), '{}');
  await writeFile(path.join(root, 'infra', 'cognito', 'tsconfig.json'), '{}');
  await writeFile(path.join(root, 'infra', 'cognito', 'delivery-resources.json'), '{"dev":{"bucket":"stage-assets"}}');
  await writeFile(
    path.join(root, 'frontend', 'dist', 'frontend', 'browser', 'index.html'),
    '<main>release</main>',
  );
  for (const name of ['main-Z.js', 'main_a.js', 'main-A.js', 'main.z.js']) {
    await writeFile(path.join(root, 'frontend', 'dist', 'frontend', 'browser', name), name);
  }
  return root;
}

test('creates a source-SHA manifest from a strict deploy allowlist', async () => {
  const { createReleaseArtifact, verifyReleaseArtifact } =
    await loadReleaseModule();
  const root = await createFixture();
  const output = path.join(root, '.release');

  const manifest = await createReleaseArtifact({ root, output, sourceSha });
  const verified = await verifyReleaseArtifact({ artifact: output, sourceSha });

  assert.equal(manifest.sourceSha, sourceSha);
  assert.equal(manifest.releaseId, sourceSha.slice(0, 12));
  assert.equal(manifest.backendDataContractVersion, 1);
  assert.equal(verified.releaseId, manifest.releaseId);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    [...manifest.files.map((file) => file.path)].sort(),
  );
  assert.ok(
    manifest.files.some(
      (file) => file.path === 'backend/lambda.zip' && file.sha256.length === 64,
    ),
  );
  assert.ok(!manifest.files.some((file) => file.path.includes('.env')));
  assert.ok(!manifest.files.some((file) => file.path.includes('node_modules')));
  assert.ok(!manifest.files.some((file) => file.path.startsWith('backend/src')));
  assert.ok(manifest.files.some((file) => file.path === 'infra/cognito/delivery-resources.json'));
  assert.ok(manifest.files.some(
    (file) => file.path === 'infra/cognito/lambda/cognito-email-quota/index.js',
  ));
});

test('rejects a release whose payload changed after manifest creation', async () => {
  const { createReleaseArtifact, verifyReleaseArtifact } =
    await loadReleaseModule();
  const root = await createFixture();
  const output = path.join(root, '.release');
  await createReleaseArtifact({ root, output, sourceSha });
  await writeFile(path.join(output, 'payload', 'backend', 'lambda.zip'), 'tampered');

  await assert.rejects(
    verifyReleaseArtifact({ artifact: output, sourceSha }),
    /checksum/i,
  );
});

test('applies the verified release and removes stale deploy files only', async () => {
  const { applyReleaseArtifact, createReleaseArtifact } =
    await loadReleaseModule();
  const root = await createFixture();
  const output = path.join(root, '.release');
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), 'despensalista-release-workspace-'),
  );
  await createReleaseArtifact({ root, output, sourceSha });
  await mkdir(path.join(workspace, 'backend'), { recursive: true });
  await writeFile(path.join(workspace, 'backend', 'stale.txt'), 'stale');
  await writeFile(path.join(workspace, 'keep.txt'), 'keep');

  await applyReleaseArtifact({ artifact: output, workspace, sourceSha });

  assert.equal(
    await readFile(path.join(workspace, 'backend', 'lambda.zip'), 'utf8'),
    'prebuilt-lambda',
  );
  await assert.rejects(readFile(path.join(workspace, 'backend', 'stale.txt')));
  assert.equal(await readFile(path.join(workspace, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(workspace, 'infra/cognito/delivery-resources.json'), 'utf8'), '{"dev":{"bucket":"stage-assets"}}');
  assert.equal(
    await readFile(
      path.join(workspace, 'infra/cognito/lambda/cognito-email-quota/index.js'),
      'utf8',
    ),
    'exports.handler = async event => event;',
  );
});
