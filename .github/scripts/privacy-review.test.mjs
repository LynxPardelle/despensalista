import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const gate = path.resolve(import.meta.dirname, '../../tools/require-privacy-review.mjs');

test('a new branch reviews its full tree, including sensitive changes in earlier commits', async (t) => {
  const root = await fixture(t);
  const initial = git(root, 'rev-parse', 'HEAD').trim();
  await writeFile(path.join(root, 'README.md'), 'Unrelated second commit');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Second');
  const result = runGate(root, '0'.repeat(40));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /household/);
  assert.equal(runGate(root, initial).status, 0, 'Normal comparison should only inspect its own diff');
  await mkdir(path.join(root, 'docs/privacy/reviews'), { recursive: true });
  await writeFile(path.join(root, 'docs/privacy/reviews/initial.md'), 'Reviewed');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Review');
  assert.equal(runGate(root, '0'.repeat(40)).status, 0);
});

test('an initial root commit cannot silently skip its privacy review', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, '');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /household/);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'despensalista-privacy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Privacy test');
  git(root, 'config', 'user.email', 'privacy-test@example.invalid');
  await writeFile(path.join(root, 'household.ts'), 'sensitive change');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Initial');
  return root;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runGate(cwd, base) {
  return spawnSync(process.execPath, [gate, `--base=${base}`, '--head=HEAD'], {
    cwd, encoding: 'utf8', env: { ...process.env, PRIVACY_REVIEW_BASE: '', PRIVACY_REVIEW_INCLUDE_WORKTREE: '' },
  });
}
