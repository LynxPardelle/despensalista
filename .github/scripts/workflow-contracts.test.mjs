import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const workflowsDirectory = path.join(repositoryRoot, '.github', 'workflows');
const deployWorkflows = [
  'deploy-serverless-dev.yml',
  'deploy-serverless-tst.yml',
  'deploy-serverless-prod.yml',
];

test('pins every GitHub Action to an immutable commit SHA', async () => {
  const workflowNames = (await readdir(workflowsDirectory)).filter((name) =>
    name.endsWith('.yml'),
  );
  for (const workflowName of workflowNames) {
    const workflow = await readWorkflow(workflowName);
    const actionReferences = [...workflow.matchAll(/uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)];
    for (const [, actionReference] of actionReferences) {
      assert.match(
        actionReference,
        /^[^@\s]+@[0-9a-f]{40}$/i,
        `${workflowName} must pin ${actionReference}`,
      );
    }
  }
});

test('gives required promotion and CDK checks unique stable names', async () => {
  const promotion = await readWorkflow('validate-promotion-source.yml');
  const cdk = await readWorkflow('serverless-cdk-validate.yml');

  assert.match(promotion, /^  validate-promotion:\r?$/m);
  assert.match(promotion, /^    name: Validate Promotion Chain\r?$/m);
  assert.match(cdk, /^  validate-cdk:\r?$/m);
  assert.match(cdk, /^    name: Validate Serverless CDK\r?$/m);
});

test('deploy workflows serialize by stage and verify after deployment', async () => {
  for (const workflowName of deployWorkflows) {
    const workflow = await readWorkflow(workflowName);
    const stage = workflowName.match(/deploy-serverless-(dev|tst|prod)\.yml/)[1];
    assert.match(workflow, /^concurrency:/m, `${workflowName} needs concurrency`);
    assert.match(workflow, new RegExp(`test "\\$GITHUB_REF_NAME" = ${stage}`));
    assert.match(workflow, /Post-deploy smoke/);
    assert.match(workflow, /release-artifact\.mjs verify/);
    assert.match(workflow, /releaseId|release-id|release_id/i);
    assert.match(workflow, /deployment-state\.mjs capture/);
    assert.match(workflow, new RegExp(`deployment-state\\.mjs reconcile ${stage} \\.release`));
    assert.match(workflow, /steps\.smoke\.outcome == 'failure'/);
    assert.match(workflow, /steps\.reconcile\.outcome == 'failure'/);
    assert.match(workflow, /deployment-state\.mjs restore/);
    assert.match(workflow, new RegExp(`deployment-state\\.mjs record ${stage} \\.release deployment-receipt`));
    assert.match(workflow, new RegExp(
      `name: despensalista-deployment-${stage}-\\$\\{\\{ github\\.sha \\}\\}[\\s\\S]*?retention-days: 90`,
    ));
    assert.ok(workflow.indexOf('Post-deploy smoke') < workflow.indexOf('Record exact published deployment'));
    assert.ok(workflow.indexOf('deployment-state.mjs reconcile') < workflow.indexOf('Post-deploy smoke'));
    assert.ok(workflow.indexOf('Record exact published deployment') < workflow.indexOf('Upload exact rollback receipt'));
    assert.match(workflow, /--change-set-name despensalista-(dev|tst|prod)-release/);
    assert.doesNotMatch(workflow, /vars\.FRONTEND_BASE_URL/);
    assert.match(workflow, /FRONTEND_BASE_URL="https:\/\/\$APP_DOMAIN_NAME"/);
    assert.match(workflow, /--base-url "https:\/\/\$APP_DOMAIN_NAME"/);
  }
});

test('builds once in dev and promotes the immutable artifact to tst and prod', async () => {
  const dev = await readWorkflow('deploy-serverless-dev.yml');
  const tst = await readWorkflow('deploy-serverless-tst.yml');
  const prod = await readWorkflow('deploy-serverless-prod.yml');
  assert.match(dev, /release-artifact\.mjs create/);
  assert.match(dev, /actions\/upload-artifact@/);
  assert.match(dev, /runs-on: ubuntu-24.04-arm/);
  assert.match(dev, /zip -q -r lambda.zip dist node_modules package.json/);
  assert.match(dev, /MONGOMS_DISABLE_POSTINSTALL: '1'/);
  assert.match(dev, /npm ci --omit=dev/);
  assert.match(dev, /Lambda artifact exceeds 250 MiB/);
  assert.doesNotMatch(dev, /npm prune --omit=dev/);
  assert.match(dev, /npm --prefix infra\/cognito test/);
  assert.doesNotMatch(tst, /npm --prefix .*frontend run build/);
  assert.doesNotMatch(prod, /npm --prefix .*frontend run build/);
  for (const promoted of [tst, prod]) {
    assert.match(promoted, /actions\/download-artifact@/);
    assert.match(promoted, /release-artifact\.mjs apply/);
    assert.match(promoted, /backendArtifactPath=\.\.\/\.\.\/backend\/lambda.zip/);
    assert.match(promoted, /test "\$parent_count" -eq 2/);
    assert.match(promoted, /git diff --quiet "\$source_sha" HEAD -- \./);
    assert.doesNotMatch(promoted, /npm --prefix backend run build/);
  }
});

test('provides scheduled zero-AWS-cost smoke and release rollback workflows', async () => {
  const smoke = await readWorkflow('production-smoke.yml');
  const rollback = await readWorkflow('rollback-serverless.yml');
  assert.match(smoke, /schedule:/);
  assert.match(smoke, /smoke\.mjs/);
  assert.doesNotMatch(smoke, /synthetics|canary/i);
  assert.match(rollback, /release_sha:/);
  assert.match(rollback, /environment:\s*\$\{\{ inputs\.stage \}\}/);
  assert.match(
    rollback,
    /workflow_name="deploy-serverless-\$\{STAGE\}\.yml"/,
  );
  assert.match(
    rollback,
    /name:\s*despensalista-release-\$\{\{ needs\.locate-release\.outputs\.release_sha \}\}/,
  );
  assert.match(
    rollback,
    /run-id:\s*\$\{\{ needs\.locate-release\.outputs\.source_run_id \}\}/,
  );
  assert.match(
    rollback,
    /name:\s*despensalista-deployment-\$\{\{ inputs\.stage \}\}-\$\{\{ needs\.locate-release\.outputs\.release_sha \}\}/,
  );
  assert.match(rollback, /tr '\[:upper:\]' '\[:lower:\]'/);
  assert.match(rollback, /deployment-receipt\/deployment-receipt\.json "\$RELEASE_SHA"/);
  assert.match(rollback, /release-artifact\.mjs apply/);
  assert.match(rollback, /Post-rollback smoke/);
  assert.doesNotMatch(rollback, /vars\.FRONTEND_BASE_URL/);
  assert.match(rollback, /--base-url "https:\/\/\$APP_DOMAIN_NAME"/);
});

test('gates CI and release on authenticated Mongo replica-set transactions', async () => {
  for (const workflowName of ['ci-cd.yml', 'deploy-serverless-dev.yml']) {
    const workflow = await readWorkflow(workflowName);
    assert.match(workflow, /node --test .*docker\/mongodb\/replica-health\.test\.mjs/);
    assert.match(workflow, /node --test .*backend\/scripts\/deployed-api-smoke\.test\.cjs/);
    assert.match(workflow, /bash \.github\/scripts\/mongodb-compose-smoke\.sh/);
  }
  const smoke = await readFile(path.join(repositoryRoot, '.github/scripts/mongodb-compose-smoke.sh'), 'utf8');
  assert.match(smoke, /up --detach --wait --wait-timeout 180 mongodb/);
  assert.match(smoke, /trap cleanup EXIT/);
  assert.match(smoke, /down --volumes --remove-orphans/);
  assert.match(smoke, /exec -T mongodb mongosh --quiet --file \/dev\/stdin/);
});

async function readWorkflow(name) {
  return readFile(path.join(workflowsDirectory, name), 'utf8');
}
