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
    assert.match(workflow, /RELEASE_ID=.*\.release\/release-manifest\.json/);
    assert.match(workflow, /--context releaseId="\$RELEASE_ID"/);
    assert.match(workflow, /releaseId|release-id|release_id/i);
    assert.match(workflow, /deployment-state\.mjs capture/);
    assert.match(workflow, new RegExp(`deployment-state\\.mjs reconcile ${stage} \\.release`));
    assert.match(workflow, /steps\.smoke\.outcome == 'failure'/);
    assert.match(workflow, /steps\.reconcile\.outcome == 'failure'/);
    assert.match(workflow, /steps\.deploy\.outcome == 'failure'/);
    assert.match(workflow, /deployment-state\.mjs restore/);
    assert.match(workflow, new RegExp(`deployment-state\\.mjs record ${stage} \\.release deployment-receipt`));
    assert.match(workflow, new RegExp(
      `name: despensalista-deployment-${stage}-\\$\\{\\{ github\\.sha \\}\\}[\\s\\S]*?retention-days: 90`,
    ));
    assert.ok(workflow.indexOf('Post-deploy smoke') < workflow.indexOf('Record exact published deployment'));
    assert.ok(workflow.indexOf('deployment-state.mjs reconcile') < workflow.indexOf('Post-deploy smoke'));
    if (stage !== 'prod') {
      assert.match(workflow, new RegExp(`deployment-state\\.mjs activate ${stage} \\.release`));
      assert.match(workflow, new RegExp(`deployment-state\\.mjs drain-writers ${stage} \\.rollback`));
      assert.match(workflow, new RegExp(`deployment-state\\.mjs release-writers ${stage} \\.rollback`));
      assert.ok(
        workflow.indexOf(`deployment-state.mjs drain-writers ${stage} .rollback`) <
          workflow.indexOf('npx cdk deploy') &&
        workflow.indexOf(`deployment-state.mjs activate ${stage} .release`) <
          workflow.indexOf(`deployment-state.mjs reconcile ${stage} .release`) &&
          workflow.indexOf(`deployment-state.mjs reconcile ${stage} .release`) <
          workflow.indexOf(`deployment-state.mjs release-writers ${stage} .rollback`) &&
          workflow.indexOf(`deployment-state.mjs release-writers ${stage} .rollback`) <
          workflow.indexOf('Post-deploy smoke'),
      );
      assert.match(workflow, /steps\.activate\.outcome == 'failure'/);
      assert.match(workflow, /steps\.drain\.outcome == 'failure'/);
      assert.match(workflow, /steps\.release_writers\.outcome == 'failure'/);
    }
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

test('durably drains the old production Lambda before an all-at-once schema cutover', async () => {
  const prod = await readWorkflow('deploy-serverless-prod.yml');
  const deploymentState = await readFile(
    path.join(repositoryRoot, '.github', 'scripts', 'deployment-state.mjs'),
    'utf8',
  );
  const armDrain = deploymentState.slice(
    deploymentState.indexOf('export async function armProductionDrain'),
    deploymentState.indexOf('export async function releaseProductionDrain'),
  );
  assert.ok(
    armDrain.indexOf('createPendingProductionDrainMarker') <
      armDrain.indexOf("'s3', 'sync'"),
  );
  assert.ok(
    armDrain.indexOf("'s3', 'sync'") <
      armDrain.indexOf('transitionProductionDrainMarker'),
  );
  assert.ok(
    armDrain.indexOf('transitionProductionDrainMarker') <
      armDrain.indexOf('drainWriters'),
  );
  assert.match(deploymentState, /\/despensalista\/prod\/deployment-drain/);
  assert.match(prod, /deployment-state\.mjs recover-drain prod(?:\r?\n|$)/);
  assert.doesNotMatch(prod, /deployment-state\.mjs recover-drain prod \.release/);
  assert.ok(
    prod.indexOf('deployment-state.mjs recover-drain prod') <
      prod.indexOf('deployment-state.mjs capture prod .rollback'),
  );
  assert.match(prod, /deployment-state\.mjs arm-drain prod \.rollback \.release/);
  assert.ok(
    prod.indexOf('deployment-state.mjs capture prod .rollback') <
      prod.indexOf('deployment-state.mjs arm-drain prod .rollback .release'),
  );
  assert.ok(
    prod.indexOf('deployment-state.mjs arm-drain prod .rollback .release') <
      prod.indexOf('test "$quota_schema_version" = "2"'),
  );
  const quotaStep = prod.slice(
    prod.indexOf('- name: Drain old Lambda writers and invalidate legacy pantry quotas'),
    prod.indexOf('- name: Deploy prod releaseId'),
  );
  assert.ok(
    quotaStep.indexOf('if test -z "$function_name"') <
      quotaStep.indexOf('aws cloudformation describe-stacks'),
  );
  assert.match(deploymentState, /await wait\(\(timeout \+ 5\) \* 1000\)/);
  assert.match(
    prod,
    /if: always\(\) && steps\.drain\.outcome == 'success' && steps\.deploy\.outcome == 'success' && steps\.activate\.outcome == 'success' && steps\.verify\.outcome == 'success' && steps\.reconcile\.outcome == 'success' && steps\.mark_drain\.outcome == 'success'/,
  );
  assert.match(prod, /deployment-state\.mjs release-drain prod/);
  assert.match(prod, /steps\.drain\.outcome == 'failure'/);
  assert.match(prod, /steps\.activate\.outcome == 'failure'/);
  assert.match(prod, /steps\.mark_drain\.outcome == 'failure'/);
  assert.match(prod, /steps\.release_drain\.outcome == 'failure'/);
  assert.ok(
    prod.indexOf('Deploy prod releaseId') <
      prod.indexOf('deployment-state.mjs activate-drain prod'),
  );
  assert.ok(
    prod.indexOf('deployment-state.mjs activate-drain prod') <
      prod.indexOf('deployment-state.mjs verify prod .release'),
  );
  assert.ok(
    prod.indexOf('deployment-state.mjs verify prod .release') <
      prod.indexOf('deployment-state.mjs reconcile prod .release'),
  );
  assert.ok(
    prod.indexOf('deployment-state.mjs reconcile prod .release') <
      prod.indexOf('deployment-state.mjs mark-drain-verified prod'),
  );
  assert.ok(
    prod.indexOf('deployment-state.mjs mark-drain-verified prod') <
      prod.indexOf('deployment-state.mjs release-drain prod'),
  );
  assert.ok(
    prod.indexOf('deployment-state.mjs release-drain prod') <
      prod.indexOf('Post-deploy smoke'),
  );
  assert.ok(
    prod.indexOf('Post-deploy smoke') <
      prod.indexOf('deployment-state.mjs finalize-drain prod'),
  );
  assert.doesNotMatch(prod, /aws lambda delete-function-concurrency/);
  assert.match(prod, /OutputKey=='PantryQuotaSchemaVersion'/);
  assert.match(prod, /test "\$quota_schema_version" = "2"/);
  assert.match(prod, /test "\$live_version" = "\$published_version"/);
  assert.equal(
    (
      prod.match(
        /attribute_not_exists\(#deleting\) OR #deleting = :notDeleting/g,
      ) ?? []
    ).length,
    2,
  );
  assert.match(prod, /":notDeleting":\{"BOOL":false\}/);
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
  assert.match(rollback, /deployment-state\.mjs recover-drain prod/);
  assert.ok(
    rollback.indexOf('aws-actions/configure-aws-credentials@') <
      rollback.indexOf('deployment-state.mjs recover-drain prod'),
  );
  assert.ok(
    rollback.indexOf('deployment-state.mjs recover-drain prod') <
      rollback.indexOf('deployment-state.mjs release "$STAGE"'),
  );
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
  const transaction = await readFile(path.join(repositoryRoot, '.github/scripts/mongodb-transaction-smoke.js'), 'utf8');
  assert.doesNotMatch(transaction, /\bassert(?:\.|\()/);
  assert.match(transaction, /function expectEqual\(actual, expected, message\)/);
});

test('installs Playwright media support before browser journeys', async () => {
  for (const workflowName of ['ci-cd.yml', 'deploy-serverless-dev.yml']) {
    const workflow = await readWorkflow(workflowName);
    const mediaInstall = workflow.indexOf('playwright install ffmpeg');
    const browserJourneys = workflow.indexOf('test:e2e');
    assert.ok(
      mediaInstall >= 0 && mediaInstall < browserJourneys,
      `${workflowName} must install ffmpeg before browser journeys`,
    );
  }
});

async function readWorkflow(name) {
  return readFile(path.join(workflowsDirectory, name), 'utf8');
}
