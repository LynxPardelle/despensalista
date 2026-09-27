# Despensa Lista Cognito CDK

This CDK app creates the AWS Cognito side of Despensa Lista authentication:

- Cognito User Pool with email sign-in and email recovery.
- Cognito Managed Login v2 prefix domain.
- OAuth app client with Authorization Code flow.
- Local callback/logout URLs for `http://localhost:48673`.
- Stage-specific HTTPS callback/logout URLs.
- Optional Google and Facebook social login, with client secrets stored in SSM
  SecureString parameters and Cognito IdPs updated by helper script.

When `includeServerlessBackend=true`, it also creates the staged Lambda/API Gateway
backend using the existing DynamoDB repositories and Cognito stack.

The serverless stack defines the staged application resources:

- DynamoDB tables for users, products, product types, and inventory lots.
- ACM certificate for `despensalista.lynxpardelle.com` plus the planned
  `test.` and `dev.` subdomains.
- CloudFront distribution with private S3 frontend and API Gateway origin.
- Route53 A/AAAA aliases for the production domain.
- An attempted CloudFront FREE subscription and five included WAF rules; if AWS
  rejects eligibility, neither the subscription nor Web ACL is retained.
- Required local-user TOTP MFA. Every stage uses Cognito's managed sender under
  `COGNITO_DEFAULT`; the verified SES/DKIM identity stays inactive until SES
  production access permits the custom sender.
- Stage-specific GitHub OIDC deployment roles, immutable Lambda versions and `live` alias.
- Five production alarms (about USD 0.50/month), bounded API/Lambda logs, and
  production all-at-once deployment with alarm-backed rollback. When the
  deployed `PantryQuotaSchemaVersion` is older than the release contract, the
  production workflow briefly sets reserved concurrency to zero, waits the
  Lambda timeout plus five seconds, conditionally removes only inactive
  `PANTRY_QUOTA` rows, deploys, and restores the prior concurrency.

The retired Dokploy/EC2 stack has been removed. Dev, tst, and prod each have an
isolated origin-verification secret, totaling about USD 1.20/month. The first
deployment of this contract retains the former shared `nonprod` secret for safe
migration; remove it manually only after both dev and tst pass their smoke tests.
CloudWatch Synthetics is deliberately excluded. SES/DKIM is provisioned only in
prod, but the verified custom From remains inactive while the account is in the
SES sandbox. Cognito's managed sender stays active until direct `DEVELOPER`
sending is approved for production access.

The CustomMessage guard atomically applies hashed-recipient and daily counters
without reserving Lambda concurrency. Daily limits are dev 2, tst 3, and prod 30;
prod caps non-recovery mail at 20 to retain 10 recovery sends, leaving 15 of the
account's approximate 50-message managed quota for other pools. Anonymous direct
`SignUp`, `ResendConfirmationCode`, and `ForgotPassword` calls can still consume
those budgets. CustomMessage has no source IP, browser CAPTCHA is bypassable via
the public Cognito API, and a user-pool WAF starts above the approved USD 1/month
threshold. See the production runbook for the explicit residual risk and costs.

Administrator bootstrap attempts the CloudFront `FREE` plan. If AWS rejects the
account or distribution as ineligible, redeploy that bootstrap with
`--context enableFlatRateWaf=false`; an inventory without `subscriptionArn`
keeps later stage deployments on low-traffic CloudFront PAYG without AWS WAF.
This avoids the WAF PAYG base charge while preserving the private API-origin
header check.

Release workflows pass `backendArtifactPath` pointing to the once-built ARM64
Lambda ZIP and optionally `frontendArtifactPath` for the matching static assets.
CDK must not rebuild the Lambda ZIP during stage promotion. For source-only local
validation, omitting the path retains the normal bundle/build behavior.

No Google/Facebook client secret belongs in this repository.

## Why CDK

The application code already expects Cognito Hosted UI redirects, Cognito token
verification, and HttpOnly app cookies. CDK keeps the User Pool, app client,
domain, callbacks, and supported-provider list reproducible.

## Prerequisites

- AWS CLI authenticated to the target account.
- A unique Cognito domain prefix, for example `despensalista-dev-alec`.
- Optional Google OAuth client ID and secret.
- Optional Facebook app ID and secret.
- Stage public URL, for example `https://despensalista.example.com`.

Release infrastructure does not use the account-wide default CDK bootstrap.
Administrator setup creates the stage-specific asset bucket, CloudFormation role,
OIDC role and permissions boundary described in the production runbook. Use a
standard bootstrap only for a separate disposable account/local experiment:

```powershell
npx cdk bootstrap aws://<account-id>/<region>
```

## Social Provider Redirects

Social provider apps must redirect back to Cognito, not directly to Despensa Lista.

For a Cognito domain like:

```text
https://despensalista-dev-alec.auth.us-east-1.amazoncognito.com
```

configure the social provider redirect URI as:

```text
https://despensalista-dev-alec.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
```

For Google, also set the authorized JavaScript origin to the Cognito domain:

```text
https://despensalista-dev-alec.auth.us-east-1.amazoncognito.com
```

## Store Provider Secrets

Create provider secrets in SSM Parameter Store SecureString parameters:

```powershell
aws ssm put-parameter `
  --name /despensalista/dev/google-client-secret `
  --type SecureString `
  --value "<google-client-secret>"

aws ssm put-parameter `
  --name /despensalista/dev/facebook-client-secret `
  --type SecureString `
  --value "<facebook-client-secret>"
```

If a parameter already exists, update it with:

```powershell
aws ssm put-parameter `
  --name /despensalista/dev/google-client-secret `
  --type SecureString `
  --value "<new-google-client-secret>" `
  --overwrite
```

Prefer entering real secret values outside shell history when possible, for
example through the AWS Console or an approved secret-management workflow.

You can also use the bundled helper. It prompts for secrets securely and writes
them to SSM SecureString parameters:

```powershell
.\scripts\Set-SocialProviderSecrets.ps1 `
  -Google `
  -Facebook `
  -Region us-east-1 `
  -Stage dev `
  -WriteDeployScript
```

`Deploy-SocialProviders.local.ps1` is ignored by git. It can contain provider
names and parameter names, but it must never contain provider client secrets.

## Configure Cognito Social Providers From SSM

Cognito social IdP `client_secret` values cannot be sourced from SSM
SecureString dynamic references in CloudFormation. Deploy the Cognito pool and
client first, then upsert the social IdPs from SSM:

```powershell
.\scripts\Set-CognitoSocialProvidersFromSsm.ps1 `
  -UserPoolId <user-pool-id> `
  -UserPoolClientId <user-pool-client-id> `
  -GoogleClientId <google-oauth-client-id> `
  -Region us-east-1
```

Pass `-FacebookClientId <facebook-app-id>` only after the Meta app can be made
active.

Then deploy CDK with:

```powershell
--context externallyManagedSocialProviders=Google
```

This keeps the Cognito app client and backend Lambda environment aligned with
the externally managed IdPs without storing provider secrets in CloudFormation.

## Install And Validate

```powershell
cd infra/cognito
npm ci
npm run build
npm run synth
```

Validate the social-provider template shape without real secrets:

```powershell
npx cdk synth `
  --context domainPrefix=despensalista-dev-example `
  --context productionFrontendBaseUrl=https://despensalista.example.com `
  --context externallyManagedSocialProviders=Google
```

## Deployment safety

Do not run an ad-hoc `cdk deploy` from this application against `dev`, `tst`, or
`prod`: those names resolve to the real staged stacks and a different domain
prefix can replace the hosted-login domain. Use the administrator bootstrap and
immutable promotion procedure in `docs/operations/production-runbook.md`.

## Deploy: Staged Serverless App

Do not deploy production with an ad-hoc administrator command. The supported
path is the immutable `dev -> tst -> prod` GitHub workflow with stage-scoped
OIDC and CloudFormation roles. Follow
`docs/operations/production-runbook.md`; it also documents the one-time
administrator bootstrap and the exact rollback receipt.

Do not put OAuth client secrets in command-line context. Store them in SSM
SecureString parameters and pass only non-secret provider IDs to
`Set-CognitoSocialProvidersFromSsm.ps1`.

## Apply Outputs To Despensa Lista

After deploy, get stack outputs:

```powershell
aws cloudformation describe-stacks `
  --stack-name despensalista-dev-cognito `
  --query "Stacks[0].Outputs"
```

For local development, set these in `.env.docker.local`:

```env
COGNITO_ENABLED=true
COGNITO_ISSUER=<CognitoIssuer output>
COGNITO_DOMAIN=<CognitoDomain output>
COGNITO_CLIENT_ID=<UserPoolClientId output>
COGNITO_CLIENT_SECRET=
COGNITO_REDIRECT_URI=http://localhost:48673/api/auth/cognito/callback
COGNITO_LOGOUT_REDIRECT_URI=http://localhost:48673/login
COGNITO_SCOPES=openid email profile
COGNITO_ALLOWED_PROVIDERS=COGNITO,Google
```

The CDK serverless stack supplies the deployed stage URLs automatically:

```env
COGNITO_REDIRECT_URI=https://<stage-domain>/api/auth/cognito/callback
COGNITO_LOGOUT_REDIRECT_URI=https://<stage-domain>/login
```

## Useful Outputs

- `UserPoolId`: Cognito User Pool ID.
- `UserPoolClientId`: value for `COGNITO_CLIENT_ID`.
- `CognitoIssuer`: value for `COGNITO_ISSUER`.
- `CognitoDomain`: value for `COGNITO_DOMAIN`.
- `SocialProviderRedirectUri`: URL to configure in Google/Facebook.
- `AllowedProviders`: value for `COGNITO_ALLOWED_PROVIDERS`.
- `DynamoDbUsersTable`: value for `DYNAMODB_USERS_TABLE`.
- `DynamoDbProductsTable`: value for `DYNAMODB_PRODUCTS_TABLE`.
- `DynamoDbProductTypesTable`: value for `DYNAMODB_PRODUCT_TYPES_TABLE`.
- `DynamoDbInventoryLotsTable`: value for
  `DYNAMODB_INVENTORY_LOTS_TABLE`.
- `CloudFrontDistributionId`: distribution to invalidate after production
  redeploys when needed.
- `CloudFrontDomainName`: generated CloudFront hostname backing the Route53
  alias.
