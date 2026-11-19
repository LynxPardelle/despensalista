'use strict';

const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ACCOUNT = '765932874577';
const REGION = 'us-east-1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COMMANDS = new Set(['issue', 'resume', 'list', 'revoke']);
const OPTIONS = new Set(['stage', 'plan', 'mode', 'months', 'redeem-until', 'reason', 'count', 'email', 'output', 'id', 'limit', 'cursor', 'lifetime', 'apply']);

function parseArgs(args, now = new Date()) {
  if (!args.length || args[0] === '--help') return { command: 'help' };
  const command = args[0];
  assert.ok(COMMANDS.has(command), 'Use issue, resume, list or revoke');
  const values = {};
  for (let index = 1; index < args.length; index++) {
    const name = args[index].replace(/^--/, '');
    assert.ok(args[index].startsWith('--') && OPTIONS.has(name) && !Object.hasOwn(values, name), 'Unknown or duplicate option');
    if (name === 'apply' || name === 'lifetime') values[name] = true;
    else {
      const value = args[++index];
      assert.ok(value && !value.startsWith('--'), `Missing value for --${name}`);
      values[name] = value;
    }
  }
  assert.ok(['dev', 'tst', 'prod'].includes(values.stage), 'Choose --stage dev, tst or prod');
  const common = { command, stage: values.stage, apply: values.apply === true };
  if (command === 'list') {
    const limit = Number(values.limit ?? 25);
    assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Limit must be 1 to 100');
    return { ...common, limit, cursor: values.cursor };
  }
  if (command === 'resume') {
    assert.ok(values.output && path.isAbsolute(values.output), '--output must be an absolute local path');
    return { ...common, output: values.output };
  }
  assert.ok(values.reason && values.reason.trim() === values.reason && Buffer.byteLength(values.reason) <= 256, 'Provide --reason with at most 256 bytes');
  if (command === 'revoke') {
    assert.match(values.id ?? '', UUID, 'Provide the issuance UUID in --id');
    return { ...common, id: values.id, reason: values.reason };
  }
  assert.ok(['plus', 'pro'].includes(values.plan), '--plan must be plus or pro');
  const mode = values.mode ?? 'plan';
  assert.ok(['plan', 'developer'].includes(mode), '--mode must be plan or developer');
  const lifetime = values.lifetime === true;
  const months = lifetime ? undefined : Number(values.months);
  assert.ok(lifetime ? values.months === undefined : Number.isInteger(months) && months >= 1 && months <= 120, 'Choose --months 1..120 or --lifetime');
  assert.ok(mode !== 'developer' || lifetime, 'Developer access must be lifetime');
  const redeemUntil = values['redeem-until'] ? new Date(values['redeem-until']) : new Date(now.getTime() + 30 * 86400000);
  assert.ok(Number.isFinite(redeemUntil.getTime()) && redeemUntil > now, '--redeem-until must be a future date');
  const count = Number(values.count ?? 1);
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 100, '--count must be 1 to 100');
  const recipientEmail = values.email?.trim().toLowerCase();
  assert.ok(!recipientEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) && recipientEmail.length <= 254, 'Invalid --email');
  if (mode === 'developer') assert.ok(recipientEmail, 'Bind developer access with --email');
  if (common.apply) assert.ok(values.output && path.isAbsolute(values.output) && !values.output.startsWith('\\\\'), 'Issuance requires an absolute local --output path');
  return { ...common, plan: values.plan, mode, lifetime, months, redeemUntil: redeemUntil.toISOString(), reason: values.reason, count, recipientEmail, output: values.output };
}

function createBatch(options, actor, now = new Date()) {
  return {
    format: 'despensalista-access-codes-v1', stage: options.stage, batchId: randomUUID(), createdAt: now.toISOString(), actor,
    records: Array.from({ length: options.count }, () => {
      const id = randomUUID();
      const code = `DL1.${id}.${randomBytes(32).toString('base64url')}`;
      return {
        code, publication: 'pending',
        metadata: {
          id, plan: options.plan, mode: options.mode, months: options.months,
          lifetime: options.lifetime, redeemUntil: options.redeemUntil,
          ...(options.recipientEmail ? { recipientEmail: options.recipientEmail } : {}),
          createdAt: now.toISOString(), issuedBy: actor, reason: options.reason, state: 'issued',
        },
      };
    }),
  };
}

function persistPrivate(filename, value, exclusive = false) {
  const target = exclusive ? filename : `${filename}.checkpoint-${randomUUID()}`;
  const handle = fs.openSync(target, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const principal = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
      assert.ok(principal, 'Could not resolve the local account');
      execFileSync('icacls.exe', [target, '/inheritance:r', '/grant:r', `${principal}:(F)`], { stdio: 'pipe', windowsHide: true });
    }
    fs.writeFileSync(handle, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  if (!exclusive) fs.renameSync(target, filename);
}

function validateBatch(batch, stage) {
  assert.ok(batch?.format === 'despensalista-access-codes-v1' && batch.stage === stage && Array.isArray(batch.records) && batch.records.length >= 1 && batch.records.length <= 100, 'Invalid batch or stage');
  for (const record of batch.records) {
    assert.ok(typeof record.code === 'string' && record.metadata && UUID.test(record.metadata.id), 'Invalid batch record');
    assert.match(record.code, /^DL1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(record.code.split('.')[1], record.metadata.id);
    assert.ok(['pending', 'issued', 'failed'].includes(record.publication));
    assert.ok(['plus', 'pro'].includes(record.metadata.plan) && ['plan', 'developer'].includes(record.metadata.mode));
    assert.ok(record.metadata.state === 'issued' && typeof record.metadata.reason === 'string');
    assert.ok(record.metadata.lifetime ? record.metadata.months === undefined : Number.isInteger(record.metadata.months) && record.metadata.months >= 1 && record.metadata.months <= 120);
    assert.ok(record.metadata.mode !== 'developer' || record.metadata.lifetime && record.metadata.recipientEmail);
  }
}

function awsJson(...args) {
  return JSON.parse(execFileSync(process.env.AWS_CLI_PATH ?? 'aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
}

function createStore(stage) {
  assert.ok(!Object.keys(process.env).some((key) => key.toUpperCase().startsWith('AWS_ENDPOINT_URL')), 'Custom AWS endpoints are not allowed');
  process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'true';
  const identity = awsJson('sts', 'get-caller-identity');
  assert.equal(identity.Account, ACCOUNT, 'AWS account mismatch');
  const tableName = `despensalista-${stage}-users`;
  const table = awsJson('dynamodb', 'describe-table', '--table-name', tableName).Table;
  assert.equal(table.TableArn, `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${tableName}`);
  assert.equal(table.TableStatus, 'ACTIVE');
  const { ConfigService } = require('@nestjs/config');
  const { DynamoDbDocumentClientService } = require('../dist/src/infrastructure/database/dynamodb/dynamodb-document-client.service');
  const { AccessCodeStore } = require('../dist/src/infrastructure/access/access-code.store');
  const config = new ConfigService({ PERSISTENCE_PROVIDER: 'dynamodb', DYNAMODB_REGION: REGION, DYNAMODB_USERS_TABLE: tableName });
  config.skipProcessEnv = true;
  const db = new DynamoDbDocumentClientService(config);
  return { store: new AccessCodeStore(config, db), actor: identity.Arn, close: () => db.client.destroy() };
}

async function publishBatch(batch, store, filename) {
  let count = 0;
  for (const record of batch.records) {
    const secretHash = createHash('sha256').update(record.code).digest('hex');
    const existing = await store.readCode(record.metadata.id);
    if (existing) {
      assert.equal(existing.secretHash, secretHash, 'Existing code does not match the batch');
      assert.equal(existing.issuedBy, record.metadata.issuedBy, 'Existing code actor does not match');
    } else {
      assert.ok(await store.issue({ ...record.metadata, secretHash }), 'Issuance conflict; resume the saved batch');
    }
    record.publication = 'issued';
    persistPrivate(filename, batch);
    count++;
  }
  return count;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.command === 'help') {
    console.log('Access-code operator\nissue --stage dev|tst|prod --plan plus|pro (--months N|--lifetime) --reason TEXT [--mode developer --email EMAIL] [--count N] [--output ABSOLUTE_PATH] [--apply]\nlist --stage STAGE [--limit N] [--cursor CURSOR]\nrevoke --stage STAGE --id UUID --reason TEXT [--apply]\nresume --stage STAGE --output ABSOLUTE_PATH [--apply]\nIssue/revoke/resume default to dry-run. Codes are saved once in a private file, never printed.');
    return;
  }
  if (!options.apply && options.command !== 'list') {
    console.log(JSON.stringify({ dryRun: true, ...options, output: options.output ?? null }));
    return;
  }
  const runtime = createStore(options.stage);
  try {
    if (options.command === 'list') {
      console.log(JSON.stringify(await runtime.store.list(options.cursor, options.limit), null, 2));
      return;
    }
    if (options.command === 'revoke') {
      assert.ok(await runtime.store.revoke(options.id, options.reason), 'Code not found or concurrently changed; inspect and retry');
      console.log(JSON.stringify({ stage: options.stage, id: options.id, state: 'revoked' }));
      return;
    }
    const batch = options.command === 'resume'
      ? JSON.parse(fs.readFileSync(options.output, 'utf8'))
      : createBatch(options, runtime.actor);
    validateBatch(batch, options.stage);
    if (options.command === 'issue') persistPrivate(options.output, batch, true);
    const issued = await publishBatch(batch, runtime.store, options.output);
    console.log(JSON.stringify({ stage: options.stage, batchId: batch.batchId, issued, output: options.output }));
  } finally { runtime.close(); }
}

module.exports = { parseArgs, createBatch, validateBatch, publishBatch };
if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ status: 'failed', error: error.name, message: 'The operation could not finish. Check arguments and preserve the private output file. Resume or inspect the issuance IDs before retrying.' }));
    process.exitCode = 1;
  });
}
