import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_NAME = 'release-manifest.json';
const PAYLOAD_DIRECTORY = 'payload';
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/i;

const DEPLOY_ALLOWLIST = [
  ['backend/lambda.zip', 'backend/lambda.zip'],
  ['infra/cognito/bin', 'infra/cognito/bin'],
  ['infra/cognito/lib', 'infra/cognito/lib'],
  ['infra/cognito/cdk.json', 'infra/cognito/cdk.json'],
  ['infra/cognito/delivery-resources.json', 'infra/cognito/delivery-resources.json'],
  ['infra/cognito/package.json', 'infra/cognito/package.json'],
  ['infra/cognito/package-lock.json', 'infra/cognito/package-lock.json'],
  ['infra/cognito/tsconfig.json', 'infra/cognito/tsconfig.json'],
  ['frontend/dist/frontend', 'frontend/dist/frontend'],
];

export async function createReleaseArtifact({ root, output, sourceSha }) {
  assertSourceSha(sourceSha);
  const resolvedRoot = path.resolve(root);
  const resolvedOutput = path.resolve(output);
  assertChildPath(resolvedRoot, resolvedOutput, 'release output');

  await rm(resolvedOutput, { recursive: true, force: true });
  const payload = path.join(resolvedOutput, PAYLOAD_DIRECTORY);
  await mkdir(payload, { recursive: true });

  for (const [sourceRelativePath, targetRelativePath] of DEPLOY_ALLOWLIST) {
    const source = path.join(resolvedRoot, sourceRelativePath);
    const target = path.join(payload, targetRelativePath);
    await stat(source);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }

  const files = await buildFileManifest(payload);
  const manifest = {
    schemaVersion: 1,
    sourceSha: sourceSha.toLowerCase(),
    releaseId: sourceSha.slice(0, 12).toLowerCase(),
    files,
  };
  await writeFile(
    path.join(resolvedOutput, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  return manifest;
}

export async function verifyReleaseArtifact({ artifact, sourceSha }) {
  if (sourceSha !== undefined) {
    assertSourceSha(sourceSha);
  }

  const resolvedArtifact = path.resolve(artifact);
  const manifest = JSON.parse(
    await readFile(path.join(resolvedArtifact, MANIFEST_NAME), 'utf8'),
  );

  if (
    manifest.schemaVersion !== 1 ||
    !SOURCE_SHA_PATTERN.test(manifest.sourceSha ?? '') ||
    manifest.releaseId !== manifest.sourceSha.slice(0, 12).toLowerCase() ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('Invalid release manifest');
  }

  if (
    sourceSha !== undefined &&
    manifest.sourceSha.toLowerCase() !== sourceSha.toLowerCase()
  ) {
    throw new Error(
      `Release source SHA mismatch: expected ${sourceSha}, received ${manifest.sourceSha}`,
    );
  }

  const expectedPaths = manifest.files.map((file) => file.path);
  const sortedExpectedPaths = [...expectedPaths].sort();
  if (
    new Set(expectedPaths).size !== expectedPaths.length ||
    JSON.stringify(expectedPaths) !== JSON.stringify(sortedExpectedPaths)
  ) {
    throw new Error('Release manifest paths must be unique and sorted');
  }

  for (const file of manifest.files) {
    if (
      typeof file.path !== 'string' ||
      file.path.startsWith('/') ||
      file.path.includes('..') ||
      !/^[0-9a-f]{64}$/i.test(file.sha256 ?? '') ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error('Invalid release manifest entry');
    }
  }

  const actualFiles = await buildFileManifest(
    path.join(resolvedArtifact, PAYLOAD_DIRECTORY),
  );
  if (actualFiles.length !== manifest.files.length) {
    throw new Error('Release payload file count does not match the manifest');
  }

  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index];
    const actual = actualFiles[index];
    if (
      expected.path !== actual.path ||
      expected.size !== actual.size ||
      expected.sha256 !== actual.sha256
    ) {
      throw new Error(`Release checksum mismatch for ${expected.path}`);
    }
  }

  return manifest;
}

export async function applyReleaseArtifact({ artifact, workspace, sourceSha }) {
  const manifest = await verifyReleaseArtifact({ artifact, sourceSha });
  const resolvedArtifact = path.resolve(artifact);
  const resolvedWorkspace = path.resolve(workspace);
  if (path.parse(resolvedWorkspace).root === resolvedWorkspace) {
    throw new Error('Refusing to apply a release at a filesystem root');
  }

  const payload = path.join(resolvedArtifact, PAYLOAD_DIRECTORY);
  const replacementPaths = ['backend', 'infra/cognito', 'frontend/dist'];
  for (const relativePath of replacementPaths) {
    const target = path.join(resolvedWorkspace, relativePath);
    const source = path.join(payload, relativePath);
    assertChildPath(resolvedWorkspace, target, `release target ${relativePath}`);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }

  return manifest;
}

async function buildFileManifest(root) {
  const paths = await listFiles(root);
  return Promise.all(
    paths.map(async (relativePath) => {
      const contents = await readFile(path.join(root, relativePath));
      return {
        path: toPosixPath(relativePath),
        size: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      };
    }),
  );
}

async function listFiles(root, directory = '') {
  const absoluteDirectory = path.join(root, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Release payload cannot contain symlinks: ${relativePath}`);
    }

    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported release payload entry: ${relativePath}`);
    }
  }

  return files.sort((left, right) => {
    const a = toPosixPath(left);
    const b = toPosixPath(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function assertSourceSha(sourceSha) {
  if (!SOURCE_SHA_PATTERN.test(sourceSha ?? '')) {
    throw new Error('Source SHA must be a 40-character hexadecimal commit ID');
  }
}

function assertChildPath(parent, child, label) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe ${label}: ${child}`);
  }
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid CLI argument: ${key ?? ''}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  let manifest;
  if (command === 'create') {
    manifest = await createReleaseArtifact({
      root: options.root ?? '.',
      output: options.output ?? '.release',
      sourceSha: options['source-sha'],
    });
  } else if (command === 'verify') {
    manifest = await verifyReleaseArtifact({
      artifact: options.artifact ?? '.release',
      sourceSha: options['source-sha'],
    });
  } else if (command === 'apply') {
    manifest = await applyReleaseArtifact({
      artifact: options.artifact ?? '.release',
      workspace: options.workspace ?? '.',
      sourceSha: options['source-sha'],
    });
  } else {
    throw new Error('Usage: release-artifact.mjs <create|verify|apply> [options]');
  }

  process.stdout.write(`${JSON.stringify({
    sourceSha: manifest.sourceSha,
    releaseId: manifest.releaseId,
    fileCount: manifest.files.length,
  })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
