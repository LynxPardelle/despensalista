#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ''] = arg.split('=');
    return [key.replace(/^--/, ''), value];
  }),
);

const base = args.get('base') || process.env.PRIVACY_REVIEW_BASE || '';
const head = args.get('head') || process.env.PRIVACY_REVIEW_HEAD || 'HEAD';
const includeWorkingTree =
  args.get('include-working-tree') === 'true' ||
  process.env.PRIVACY_REVIEW_INCLUDE_WORKTREE === 'true';
const changedFiles = getChangedFiles(base, head, includeWorkingTree);
const privacyReviewTouched = changedFiles.some((file) =>
  /^docs\/privacy\/reviews\/.+\.md$/i.test(normalizePath(file)),
);
const sensitiveFiles = changedFiles.filter((file) =>
  requiresPrivacyReview(normalizePath(file)),
);

if (sensitiveFiles.length === 0) {
  console.log('Privacy review gate: no sensitive feature files changed.');
  process.exit(0);
}

if (privacyReviewTouched) {
  console.log('Privacy review gate: review file present.');
  process.exit(0);
}

console.error('Privacy review gate failed.');
console.error(
  'Add a markdown review under docs/privacy/reviews/ for changes touching AI, receipt/photo capture, sharing, sessions/devices, waste tracking, payments, subscriptions, or retailer handoff.',
);
console.error('Sensitive files:');
sensitiveFiles.forEach((file) => console.error(`- ${file}`));
process.exit(1);

function getChangedFiles(baseRef, headRef, includeWorktree) {
  const diffArgs = /^0{40}$/.test(baseRef)
    // A newly pushed branch has no before commit: compare its whole tree with
    // the empty tree, not only its most recent (possibly unrelated) commit.
    ? ['ls-tree', '-r', '--name-only', headRef]
    : baseRef && gitCommitExists(baseRef)
      ? ['diff', '--name-only', `${baseRef}...${headRef}`]
      : getFallbackDiffArgs(headRef);

  try {
    const files = readGitLines(diffArgs);

    if (includeWorktree) {
      files.push(...readGitLines(['diff', '--name-only']));
      files.push(...readGitLines(['ls-files', '--others', '--exclude-standard']));
    }

    return [...new Set(files)];
  } catch (error) {
    console.error('Privacy review gate could not read git diff.');
    console.error(error.stderr?.toString() || error.message);
    process.exit(1);
  }
}

function readGitLines(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitCommitExists(ref) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function getFallbackDiffArgs(headRef) {
  const parentRef = `${headRef}^`;

  if (gitCommitExists(parentRef)) {
    return ['diff', '--name-only', parentRef, headRef];
  }

  return ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', headRef];
}

function requiresPrivacyReview(file) {
  if (
    file.startsWith('docs/privacy/') ||
    file.startsWith('docs/research/') ||
    file === 'tools/require-privacy-review.mjs'
  ) {
    return false;
  }

  const sensitivePatterns = [
    /(^|\/)(ai|ocr)(\/|\.|-)/i,
    /(receipt|receipts|photo|photos|image-capture|shelf-scan|barcode)/i,
    /(household|invite|shopping-share|shopping-list|shared-shopping-list|temporary-share)/i,
    /(session|sessions|device|devices|mfa|step-up|auth_time|retention|delete-account|delete-pantry-data)/i,
    /(waste|merma|loss|losses|consumption-history|depletion-history)/i,
    /(payment|billing|subscription|stripe|mercadopago|sponsored|affiliate|retailer)/i,
  ];

  return sensitivePatterns.some((pattern) => pattern.test(file));
}

function normalizePath(file) {
  return file.replace(/\\/g, '/');
}
