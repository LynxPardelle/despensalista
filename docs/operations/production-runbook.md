# DespensaLista production runbook

Updated: 2026-09-26. AWS account `765932874577`, region `us-east-1`.
Production: <https://despensalista.lynxpardelle.com>.

This runbook describes the implemented release controls. A successful synthesis
does not prove deployment: record the actual Actions run, manifest source SHA,
CloudFormation status, Lambda version, and public smoke result for each release.

## Environments and authentication

Create GitHub environments named exactly `dev`, `tst`, and `prod`. Restrict each
environment to its matching branch and require the configured production review.
All environment variables below are non-secret; no AWS access keys are needed.

| Environment | `APP_DOMAIN_NAME` | `COGNITO_DOMAIN_PREFIX` |
| --- | --- | --- |
| dev | `dev.despensalista.lynxpardelle.com` | `despensalista-dev-765932874577` |
| tst | `test.despensalista.lynxpardelle.com` | `despensalista-tst-765932874577` |
| prod | `despensalista.lynxpardelle.com` | `despensalista-prod-765932874577` |

Set `AWS_REGION=us-east-1` and
`AWS_ROLE_ARN=arn:aws:iam::765932874577:role/despensalista-<environment>-github-deploy`.
The workflows derive the only frontend base URL as `https://<APP_DOMAIN_NAME>`;
do not configure a second URL variable that could point smoke at another stage.
The existing OIDC provider is
`arn:aws:iam::765932874577:oidc-provider/token.actions.githubusercontent.com`.
Trust requires audience `sts.amazonaws.com` and subject
`repo:LynxPardelle/despensalista:environment:<environment>` without wildcards.
Workflow jobs need `id-token: write`; untrusted PR validation jobs have no AWS role.

The Cognito stack outputs the pool/client IDs and deployment role ARN. All pools
require software-token TOTP for local Cognito users. Google users authenticate
through Google and rely on Google's MFA; Cognito does not add TOTP to federated
sessions. Production retains the existing Google provider and user pool.

Each stage has a `despensalista-<stage>-cfn-execution` role, a dedicated
`despensalista-<stage>-cdk-assets-765932874577-us-east-1` bucket, and a protected
`despensalista-<stage>-runtime-boundary` managed policy. GitHub publishes directly
to its stage bucket and explicitly cannot assume any role. It can pass only its
own CF executor. Change-set creation must explicitly select that executor, so it
cannot inherit a former administrator role saved on an existing stack.

The CF executor can create/change `despensalista-<stage>-runtime-*` IAM roles
and, in non-production, CDK's `despensalista-<stage>-serverl-CustomS3AutoDeleteObjects-*`
provider role, all with the mandatory boundary. It cannot remove that boundary
or alter deployment roles or the boundary policy. Application data and origin-verification secret
access are stage-scoped. DNS changes are restricted to stage record names/types
in the existing zone.
Global resource identifiers are allowlisted in `infra/cognito/delivery-resources.json`.
Changing that file cannot enlarge a GitHub session's effective privileges: the
associated executor policy update is itself administrator-only.

An initial administrator bootstrap creates untaggable/global resources, captures
their exact IDs, and updates the protected controls. It uses
`--context controlPlaneBootstrap=true`; ordinary deployment fails closed without
an inventory. Auth-only bootstrap creates the dedicated asset bucket first, then
backend bootstrap publishes assets to that bucket. The shared administrative
bootstrap is never assumable/passable by GitHub, and its policies are not modified.
New CloudFront OAC/response policies, ACM certificates, optional pricing-plan
enrollments require this deliberate administrative path because AWS cannot
adequately scope their creation/mutation for CI. CloudWatch Logs resource-policy
APIs do not support resource ARNs, so the protected CloudFormation executor has
documented wildcard exceptions: `PutResourcePolicy`/`DeleteResourcePolicy` and
`CreateLogDelivery`/`UpdateLogDelivery`/`DeleteLogDelivery`/`GetLogDelivery`/
`ListLogDeliveries` for API access logs, and `CreateCloudFormationDeployment`/
`StopDeployment` for the Lambda alias cutover. Runtime and GitHub roles do not
receive them. Do not add further wildcard writes to work around a failed release. Same-account
controls are not an Organizations/SCP or separate-account isolation boundary;
deployment changes remain trusted and reviewed.

For the current production cutover, run the administrative bootstrap for
`despensalista-prod-cognito` only (`includeServerlessBackend=false`). Never
bootstrap the existing production backend administratively: it does not yet have
the live alias or quota-schema output, and bypassing the production workflow
would update writers without its drain. The first production backend update must
come from `Deploy Serverless Prod` after the effective deployment-role policy has
been verified.

Run these auth-only bootstraps from `infra/cognito`; the explicit URL/provider
contexts are mandatory because the defaults do not preserve the production Google
callback configuration:

```powershell
$env:NODE_USE_SYSTEM_CA = '1'
npx cdk deploy despensalista-dev-cognito --require-approval never `
  --context projectName=despensalista --context stage=dev --context awsRegion=us-east-1 `
  --context controlPlaneBootstrap=true --context includeServerlessBackend=false `
  --context removalPolicy=destroy --context deletionProtection=false `
  --context domainPrefix=despensalista-dev-765932874577 `
  --context appDomainName=dev.despensalista.lynxpardelle.com `
  --context productionFrontendBaseUrl=https://dev.despensalista.lynxpardelle.com `
  --context serverlessFrontendBaseUrl=https://dev.despensalista.lynxpardelle.com
npx cdk deploy despensalista-tst-cognito --require-approval never `
  --context projectName=despensalista --context stage=tst --context awsRegion=us-east-1 `
  --context controlPlaneBootstrap=true --context includeServerlessBackend=false `
  --context removalPolicy=destroy --context deletionProtection=false `
  --context domainPrefix=despensalista-tst-765932874577 `
  --context appDomainName=test.despensalista.lynxpardelle.com `
  --context productionFrontendBaseUrl=https://test.despensalista.lynxpardelle.com `
  --context serverlessFrontendBaseUrl=https://test.despensalista.lynxpardelle.com
npx cdk deploy despensalista-prod-cognito --require-approval never `
  --context projectName=despensalista --context stage=prod --context awsRegion=us-east-1 `
  --context controlPlaneBootstrap=true --context includeServerlessBackend=false `
  --context removalPolicy=retain --context deletionProtection=true `
  --context domainPrefix=despensalista-prod-765932874577 `
  --context appDomainName=despensalista.lynxpardelle.com `
  --context productionFrontendBaseUrl=https://despensalista.lynxpardelle.com `
  --context serverlessFrontendBaseUrl=https://despensalista.lynxpardelle.com `
  --context externallyManagedSocialProviders=Google
```

After each command, inspect the effective
`arn:aws:iam::765932874577:policy/despensalista-<stage>-runtime-boundary` default
version and require `cognito-idp:ListUsers` to be allowed only for that stage's
user-pool ARN. Also require each GitHub delivery role's concurrency actions to
name only `despensalista-<stage>-backend-api`. Confirm the production client still
has the three DespensaLista callback/logout URLs and `SupportedIdentityProviders`
still contains `Google` before starting a release.

## Build once and promote

1. Merge reviewed application changes into `dev`. `Deploy Serverless Dev` packages
   the backend once on `ubuntu-24.04-arm` with Node 22, producing `backend/lambda.zip`.
   Frontend/backend tests, E2E, infrastructure assertions, and production dependency
   audits must pass before the deployment job receives credentials.
2. The release manifest stores the full original dev commit as `sourceSha`, its
   first 12 characters as `releaseId`, and every payload file's SHA-256 and length.
   The payload includes the Lambda ZIP, built frontend, and corresponding CDK
   source/lockfile. Artifact `despensalista-release-<dev SHA>` is retained 90 days.
3. After a successful dev deploy, create a PR from `dev` into `tst` and use a merge
   commit. Do not squash, rebase, or fast-forward this promotion: the guard checks
   its second parent against a successful upstream deployment. `tst` downloads
   and verifies the dev artifact rather than rebuilding application code.
4. After successful tst checks, merge a PR from `tst` into `prod` with a merge
   commit. Approve the production environment when prompted. Prod consumes the
   artifact from the successful tst run. Its manifest still names the original
   dev source SHA even though its artifact alias uses the tst promotion SHA.
5. Every deployment captures the prior frontend and Lambda alias, applies the
   verified artifact, and deploys CDK. Before smoke or receipt creation, it requires
   the live alias to equal the stack's exact `ServerlessBackendVersion`, verifies
   that version's `CodeSha256` against the release ZIP, synchronizes the exact
   frontend payload, and invalidates CloudFront. It then checks `/healthz`,
   `/api/healthz`, and `/login/`. The summary records the original
   releaseId/sourceSha. Also perform authenticated purchase/consume replay and
   conflict checks when these paths change.

Stage concurrency groups are `serverless-<stage>` with cancellation disabled.
Use changeset name `despensalista-<stage>-release`; IAM intentionally excludes the
shared default `cdk-deploy-change-set`. Pass `backendArtifactPath=../../backend/lambda.zip`
to CDK so promotion never repackages the backend. Keep the explicit Cognito domain
prefix; changing it can replace the hosted-login domain.

The origin secret migration replaces the dev resource with
`despensalista/dev/cloudfront-origin-verification` and creates
`despensalista/tst/cloudfront-origin-verification`. The former
`despensalista/nonprod/cloudfront-origin-verification` secret is retained rather
than deleted. Before an ordinary release, rerun the administrator control-plane
bootstrap for dev and tst so each CF executor receives `CreateSecret` and update
access only to its new stage ARN. Then deploy both stages normally, verify that
their CloudFront URLs work and their direct API Gateway URLs return 403; only
then may an operator remove the unreferenced legacy secret manually.

For a local diagnostic synthesis after a successful `npm --prefix infra/cognito
run build`, `TS_NODE_TRANSPILE_ONLY=1` avoids repeating TypeScript compilation.
On this Windows host, Node AWS connections require `NODE_USE_SYSTEM_CA=1`.
Never disable TLS verification. Do not apply a release artifact to a working
checkout containing edits: the apply script intentionally replaces deploy paths.

## Rollback frontend and backend together

CloudFormation handles failed stack deployments; production CodeDeploy moves the
`live` alias all at once and retains rollback on deployment failure or its
configured Lambda-error alarm. Every production deployment first journals the
target `releaseId` and Lambda `CodeSha256`, copies the prior frontend to a unique
prefix in the production CDK-assets bucket, then sets reserved concurrency to zero
and waits the configured Lambda timeout plus five seconds. The previous version
therefore has no in-flight writer while backend and frontend are reconciled.

Dev and tst also capture their prior concurrency, set the backend to zero, wait
for in-flight requests, deploy/activate/reconcile, and only then restore that exact
concurrency before smoke. This prevents CloudFormation rollback from briefly
serving a new persisted-data contract and then returning to an incompatible one.

After CDK completes, the workflow validates the stack's exact `DeploymentReleaseId`
and version hash and explicitly activates that version, including when a prior
manual rollback left the alias behind an otherwise unchanged stack. It verifies
the immutable artifact, overwrites and synchronizes the frontend, waits for the
CloudFront invalidation, and only then marks the release verified. Before restoring
the exact prior concurrency setting it persists an active `reopening` journal;
after AWS confirms writers are open it advances to `smoke_pending`. A successful
smoke tombstones the SSM marker and deletes only its recorded recovery prefix. The
marker itself is retained as an inactive cooldown record.

At the start of either deployment or manual rollback, an active `armed`, `verified`,
`reopening`, `smoke_pending`, or `rollback` journal is recovered conservatively:
writers are
drained, the recorded old alias and durable frontend snapshot are restored, the
invalidation is awaited, and the captured concurrency is reinstated. Recovery is
idempotent after interruption. An inactive prefix is cleaned before the next
transaction; the journal is written before snapshot upload so an interrupted upload
also remains discoverable.

The stack publishes `PantryQuotaSchemaVersion=2`. Only when the deployed output is
older does the workflow scan `pk`, `entityType`, and `deleting` in the `users` table
and conditionally delete `PANTRY_QUOTA` rows whose deletion fence is absent or false.
A row with `deleting=true` is never selected or deleted. Matching schema versions
skip this purge, but not the transaction drain. Increment the output/contract for
the next incompatible quota change. API 5xx remains an operational/SNS alarm but is
not attached to CodeDeploy because the intentional concurrency-zero window can
produce 5xx responses. Initial deployments have no previous release to restore.

For a manual rollback, use GitHub Actions **Rollback Serverless Release**. Select
the branch matching `stage` and supply the complete 40-character commit SHA of a
previously successful deployment **in that stage**. For prod/tst this is the stage's
promotion merge SHA, not necessarily the manifest's original dev `sourceSha`.
The workflow finds that successful run and its stage-specific deployment receipt,
verifies both against the selected stage, account, region, deployment SHA,
releaseId, resource identifiers and exact retained Lambda version/hash, updates
`live`, restores the matching frontend, invalidates CloudFront, and runs smoke
again. A different Lambda version with the same ZIP is not accepted.

Equivalent GitHub CLI invocation (replace the placeholder with a verified SHA):

```powershell
gh workflow run rollback-serverless.yml --repo LynxPardelle/despensalista --ref prod -f stage=prod -f release_sha=<40-character-successful-prod-commit>
```

For an incident with a verified downloaded artifact and authorized AWS session:

```powershell
node .github/scripts/release-artifact.mjs verify --artifact .release
node .github/scripts/deployment-state.mjs recover-drain prod
node .github/scripts/deployment-state.mjs capture prod .incident-before-rollback
node .github/scripts/deployment-state.mjs release prod .release .\deployment-receipt\deployment-receipt.json <40-character-successful-prod-commit>
node .github/scripts/smoke.mjs --base-url https://despensalista.lynxpardelle.com --attempts 18 --delay-ms 10000
```

The emergency commands read exact bucket/function/distribution identifiers from
the stage stack. Preserve the captured snapshot outside a public repository.
Rollback changes serving artifacts and the alias; it does not revert DynamoDB
data, IAM, API configuration, or a database schema change. Do not roll back across
an incompatible data contract. S3 noncurrent versions expire after 30 days;
GitHub release artifacts expire after 90 days; Lambda published versions are
retained in every stage. Choose only a release whose artifact and Lambda version
are both still available. Rerunning the same deployment SHA after an out-of-band
rollback validates the unchanged stack output/hash and explicitly reactivates its
exact alias version before reconciling the frontend. To roll forward to another
already successful release, run the rollback workflow with that release's exact
stage receipt; for a failed unpublished release, ship a reviewed release.

The release manifest, backend stack, and deployment receipt carry
`BackendDataContractVersion=1`. A manual rollback requires all three values to
equal the currently deployed contract; a legacy manifest/receipt with no value is
version `0` and is rejected after this cutover. Version 1 introduces durable
account-deletion identity state and device-cap reservations. Once writers have
opened on it, never restore a pre-version-1 Lambda: fix forward instead. The
automatic restore captured by a failed publish remains valid only because writers
stay drained until verification. Increment both the manifest constant and stack
output before any future incompatible persisted-data change.

If smoke fails after writers were confirmed open on a newer contract, automatic
rollback intentionally refuses the downgrade and leaves the `reopening` or
`smoke_pending` marker active. Inspect the new alias and logs, then accept the only
safe recovery direction and clear the obsolete snapshot before dispatching the
reviewed fix-forward release:

```powershell
node .github/scripts/deployment-state.mjs finalize-drain prod
```

`finalize-drain` refuses a `reopening` marker while reserved concurrency is still
zero; in that case `recover-drain prod` can safely restore the drained baseline.

## Data recovery

The [2026-09-25 recovery rehearsal](../reviews/2026-09-25-recovery-rehearsal.md)
restored all four production tables at one common timestamp. Consistent scans
matched item counts, content digests, primary/index keys, and all six GSIs.
Temporary recovery tables were designated for deletion after verification.
The rehearsal verifies recoverability, not a measured full-application RTO.

During an actual incident, pause writers, choose a common point in the 35-day
PITR window, restore all related tables under new names, and verify them with
`tools/verify-dynamodb-recovery.mjs`. Reapply TTL, PITR, deletion protection, tags,
IAM, and alarms explicitly. Then update the Lambda table configuration and
smoke-test before reopening writes. Restore users/operation receipts/quota
counters alongside product types and inventory; inconsistent recovery timestamps
can duplicate accepted purchases or invalidate quotas. Do not delete the original
tables during validation.

## Observability and log privacy

API access logs contain request ID, API ID, route template, method, protocol,
status, latency, source IP, and integration status. They do not contain query
strings, cookies, authorization headers, request bodies, or origin secrets.
Lambda logs have 30-day retention in prod and seven days in dev/tst; API logs use
the same retention. Exception logs use the registered route template (or a
query-free path with share tokens masked), error class, request ID, and stack
frames without the exception message. The regression test explicitly checks
OAuth code/state, share-token, cookie, and upstream-error redaction.

CloudFront access logging is disabled. AWS rejected the `FREE` CloudFront-plan
enrollment for both nonproduction distributions as ineligible, so no WAF web ACL
or pricing-plan subscription is retained. Pay-as-you-go WAF was not substituted:
its fixed web-ACL and rule charges exceed the approved USD 1/month ceiling. API
limits remain 10 requests/second with a burst of 30, and the origin-verification
secret prevents direct API Gateway bypass. Do not enable verbose request/response
logging while debugging.

Four production alarms cover Lambda errors, Lambda throttling, API 5xx, and
CloudFront 5xx rate. Their SNS topic has no invented email subscriber: an operator
must subscribe and confirm an actual notification destination to receive SNS
alerts. A fifth, no-action alarm records managed-email guard rejections/errors;
it has no invented SNS or email destination. The Lambda-error alarm feeds
CodeDeploy rollback; API 5xx remains operational so the intentional quota-schema
drain cannot abort its own deployment. The hourly **Production Smoke** GitHub workflow
checks public availability without a paid Synthetics canary; ensure relevant
operators receive GitHub failure notices.

Production invokes the `live` backend alias every 15 minutes to resume durable
account deletions. EventBridge retries are disabled; a failed run remains durable
and is picked up by the next scheduled invocation. Dev and tst are manual only.

Origin verification uses one Secrets Manager secret per stage. CloudFront
injects its stage's secret header; the backend rejects direct API Gateway
requests without it. Never copy the header into browser code or logs.
When revisiting WAF enrollment, first re-check distribution eligibility and the
current CloudFront plan terms. The template may request only `FREE`; never
substitute a paid WAF or paid CloudFront plan without a new cost approval.

## Cost envelope

The approved threshold is an estimated recurring **USD 1/month per feature**, not
a total account cap. AWS usage prices are variable; retention and throttling do
not impose a hard spending cap. Recheck cost when traffic or release volume grows.
The shared account already exceeded its free standard alarm allowance.

| Feature | Incremental estimate at current low traffic | Bound/control |
| --- | ---: | --- |
| GitHub public-repo Actions/OIDC/environments | USD 0 AWS fixed | Public standard runners; artifact retention 90 days |
| CloudFront pay-as-you-go for dev/tst | Expected below USD 1/month at present test traffic | No flat-rate subscription; stop/delete unused nonproduction stages if traffic changes |
| CloudFront FREE + included WAF | Not deployed | AWS returned distribution-ineligible validation errors; no orphan subscription/WebACL remains |
| Standalone WAF | Excluded; at least USD 6/month before requests for one ACL + one rule | Above the approved USD 1/month ceiling |
| Origin secrets | USD 1.20/month + negligible API calls | Exactly three active stage secrets at USD 0.40 each; the retained legacy secret adds USD 0.40 until post-migration cleanup |
| Five standard alarms | About USD 0.50/month | Prod only: four operational alarms plus the no-action managed-email guard alarm |
| Cognito managed-email guard | At the 35 admitted messages/day ceiling: DynamoDB at most USD 0.0041/month and Lambda below USD 0.01/month if shared free tiers are exhausted | On-demand atomic counters; denied/attack traffic is usage-based and not a spending cap |
| API/Lambda logs | Expected below USD 1/month | 7/30-day retention; standard ingestion about USD 0.50/GB beyond shared allowance; no bodies/queries |
| Lambda versions/alias and CodeDeploy all-at-once rollback | No fixed service fee | Existing runtime usage plus the Lambda-error deployment alarm; every prod release drains for the Lambda timeout plus five seconds until backend, frontend, and invalidation are verified |
| Account-deletion resume schedule | Below USD 0.30/month at the current 512 MB/15 s limits even if every run times out | Prod only; about 2,880 invocations/month, 15-minute rate, no EventBridge retries |
| S3 rollback version storage | Usage-based, expected below USD 1/month | Noncurrent versions expire after 30 days |
| Three isolated CDK asset buckets + stage IAM/SSM | Expected pennies/month; IAM/standard SSM no fixed fee | Dev/tst assets expire after 90 days; prod assets are retained for CloudFormation rollback, while transaction snapshots are deleted after safe smoke/rollback finalization |
| Dev/tst Lambda/API/DynamoDB | Usage-based, expected below USD 1/month at current testing | No EC2/NAT/provisioned capacity; throttle and retain bounded logs |
| DynamoDB transactions | Roughly double write units for affected items | No activation fee; current write volume adds a fraction of a cent |
| Existing DynamoDB PITR | Storage-based | 35 days; restore is one-time about USD 0.15/GB in this region |
| Cognito TOTP | No separate TOTP message charge | No SMS MFA; ordinary MAU pricing remains applicable |
| SES identity + DKIM records | No fixed identity/DKIM fee | Existing hosted zone, no new hosted zone |
| SES sending after approval | AWS currently lists USD 0.16/1,000 on Essentials or USD 0.10/1,000 à la carte, plus data | Transactional auth only; verify the account plan before switching; currently Cognito-managed |
| CloudWatch Synthetics and paid CloudFront/WAF plans | Excluded | Expected cost exceeds the approved feature threshold |

Price references: [CloudFront](https://aws.amazon.com/cloudfront/pricing/),
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/),
[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/),
[DynamoDB](https://aws.amazon.com/dynamodb/pricing/on-demand/),
[SES](https://aws.amazon.com/ses/pricing/), and
[CodeDeploy](https://aws.amazon.com/codedeploy/pricing/).

## SES approval blocker

On 2026-09-25 the domain `despensalista.lynxpardelle.com` and RSA-2048 Easy DKIM
were verified `SUCCESS`. Future intended SES sender:
`DespensaLista <no-reply@despensalista.lynxpardelle.com>`.

The account remains in the SES sandbox. Its prior Moyra production-access case
`178199358800446` is `DENIED`. A new API request describing DespensaLista while
preserving the existing contacts returned `ConflictException`; the account's
previous request was not overwritten. Reading the case through the Support API
requires a paid support subscription, which was not purchased. Open that case
in the AWS Support console to read the explanation and request reconsideration
for the verified transactional-auth domain.

All stages keep Cognito `EmailSendingAccount=COGNITO_DEFAULT` without `From` or
`SourceArn`, so signup and recovery continue through Cognito's managed sender.
AWS rejected the production bootstrap on 2026-09-27 when those custom fields were
combined with `COGNITO_DEFAULT`; the stack was corrected rather than switching a
sandboxed account to `DEVELOPER`. Do not configure the custom sender until SES
reports `ProductionAccessEnabled=true`. The exact future production-pool sending
authorization is versioned in
`infra/cognito/ses-cognito-sender-policy.json`. Its one-time administrator bootstrap
(from that directory) is:

```powershell
aws ses put-identity-policy --identity despensalista.lynxpardelle.com --policy-name DespensaListaProdCognito --policy file://ses-cognito-sender-policy.json
aws ses get-identity-policies --identity despensalista.lynxpardelle.com --policy-names DespensaListaProdCognito
aws cognito-idp describe-user-pool --user-pool-id us-east-1_BmNImLALI --query UserPool.EmailConfiguration
```

The staged policy allows only the Cognito email service, account `765932874577`,
the exact production pool, the DespensaLista SES identity, and the approved
no-reply address. It does not modify the shared SES account or Moyra's identity,
and it is not used while the pool remains on the managed sender. If the pool is
ever replaced, update that explicit ARN before enabling SES. Verify a real
signup/recovery message after deployment without logging its code or link.

The managed-mail limit is approximately 50 messages/day for the AWS account and
Region. DespensaLista's atomic guard admits at most 2 dev, 3 tst, and 30 prod
messages in the same 09:00 UTC quota window, leaving at least 15 for other pools.
Production admits at most 20 non-recovery messages so 10 remain available for
forgot-password recovery; recipient caps are 1 dev, 2 tst, and 5 prod. Recipient
keys are normalized SHA-256 hashes. There is deliberately no reserved Lambda
concurrency: a one-slot reservation lets one slow anonymous request block every
recovery request before any daily limit is reached.

This is a circuit breaker, not full abuse prevention. `SignUp` accepts arbitrary
recipient addresses; `ResendConfirmationCode` can target known unconfirmed users;
and `ForgotPassword` can target known users. All three are unauthenticated public
Cognito APIs. Distinct signup addresses can exhaust the 20-message production
non-recovery budget, and enough known users can exhaust its 30-message total even
with the per-recipient cap. The CustomMessage event has no trustworthy source IP,
and a browser CAPTCHA can be bypassed by calling the public Cognito client API
directly. A user-pool WAF/IP control starts at about USD 6/month before requests
and CAPTCHA charges, above the approved USD 1/month feature ceiling. Intentional
quota rejection and DynamoDB failure both increment the fifth alarm, but the alarm
has no subscriber until an operator supplies and confirms a real destination.
Lambda/DynamoDB work from denied attack traffic remains usage-based and is not
hard-capped by the 35 admitted-message budget.

The account-level SES suppression list already covers `BOUNCE` and `COMPLAINT`
(read-only verification, 2026-09-25). Before switching to SES, configure
bounce/complaint suppression, choose a real support/reply-to address if replies
are expected, grant the Cognito sender identity permissions, and test signup and
recovery delivery to an unverified recipient. An SES domain identity does not
create an inbound mailbox. Do not send marketing mail under this transactional
approval request.
