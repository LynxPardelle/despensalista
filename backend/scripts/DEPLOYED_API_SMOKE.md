# Deployed API smoke: dedicated Cognito + DynamoDB fixture

This is a **manual, mutating release test**, not a scheduled canary. It creates one
temporary Cognito user with suppressed messages and only that user's pantry data.
It never changes pool/client configuration, Lambda, existing users or their data.
Run only after the selected stage deployment and DNS are ready.

## Preparation

Requires Node 22+, AWS CLI, the backend's installed dependencies and a current
`npm run build`. Credentials need read access to the selected CloudFormation stacks,
DescribeTable and DynamoDB reads/writes for the stage's four tables, plus Cognito
DescribeUserPool, DescribeUserPoolClient, GetUserPoolMfaConfig, AdminCreateUser,
AdminSetUserPassword, AdminGetUser and AdminDeleteUser. SRP/MFA are public Cognito
flows. Credentials and generated passwords, TOTP secrets and tokens must never be
printed, committed or supplied as command-line arguments.

Install the supported AWS SRP library as a test-only tool **outside the repository**:

```powershell
$env:NODE_USE_SYSTEM_CA = '1'
$srpToolDir = Join-Path ([IO.Path]::GetTempPath()) 'despensalista-cognito-srp-tool'
New-Item -ItemType Directory -Path $srpToolDir -Force | Out-Null
npm install --prefix $srpToolDir --no-save --package-lock=false --ignore-scripts amazon-cognito-identity-js@6.3.16
$env:COGNITO_TEST_SRP_MODULE_PATH = Join-Path $srpToolDir 'node_modules/amazon-cognito-identity-js'
```

From `backend/`:

```powershell
npm run build
node --test scripts/deployed-api-smoke.test.cjs
node scripts/deployed-api-smoke.cjs --stage dev --run
```

Only exact `dev`, `tst`, `prod` are accepted. The script validates account
`765932874577`, region `us-east-1`, stack/table names and the stage hostname:

| Stage | Hostname |
| --- | --- |
| dev | dev.despensalista.lynxpardelle.com |
| tst | test.despensalista.lynxpardelle.com |
| prod | despensalista.lynxpardelle.com |

Without `--run`, no AWS operation is performed. There is no arbitrary URL, table,
pool, username or cleanup-owner override. Custom AWS endpoint environment variables
are rejected. AWS SDK and CLI use the operator's normal credential chain.

## What it proves

- CloudFront health works; unauthenticated profile returns 401 and direct API
  origin returns 403 without reading or using the origin secret.
- Real Cognito SRP, required TOTP enrollment and a second login requiring TOTP.
  Both JWT types are verified against Cognito JWKS with the application's verifier.
- Profile fixture uses the compiled `CognitoProfileSyncService` and `DynamoDbUserDao`.
  Cookie/XSRF authenticated API calls use the resulting verified identity.
- Product type/lot creation, duplicate-name protection, consume and waste replay,
  payload collision, concurrent consumption and concurrent same-key replay.
- Checkout replay/collision, invalid-line atomic rollback, 50-line rejection,
  seven-day receipt metadata and an expired-but-retained receipt returning 409.
- Owner counters after all mutations; type, lot and saved-list quota boundaries;
  checkout rollback on exhausted quota; pagination without duplicates or omissions;
  archive and restore counter coherence.
- `DELETE /api/profile/account`, followed by an old-token 401 and strong reads
  proving that receipts, counters, pantry/household records, user lookups and Cognito
  identity are gone. Only minimal 24-hour owner and hashed-principal revocation
  markers may remain; exact field allowlists and expiration bounds are checked.

**Not covered:** browser OAuth callback/state/PKCE, browser cookies/redirect behavior,
Google federation, email delivery, UI/accessibility, load/performance or billing.
Those require separate release checks. No password or TOTP secret is retained for
manual login after the test.

Quota boundary fixtures briefly change **only this generated user's counter**
through an exact-key, owner-conditional update and restore it in `finally`. The
expired-receipt test similarly changes its own receipt's `expiresAt` while keeping
the future DynamoDB TTL epoch, modelling delayed TTL removal; it restores the date
after the assertion. These test-only fixtures avoid hundreds of needless API writes
and do not weaken deployed validation.

## Cleanup and result

The script always attempts fallback cleanup in `finally`. Every DynamoDB deletion
uses an exact primary key plus a condition verifying the fixture's ownership and
entity type. Cognito deletion verifies the exact generated email and subject first.
It preserves valid minimal 24-hour revocation markers until their normal TTL cleanup
so already-authorized work cannot resurrect the deleted fixture. It never deletes
tables, pools or another account's data. Normal API account deletion
is asserted **before** fallback cleanup, so fallback cannot hide a product defect.

Strong verification scans stop with an explicit failure after 5,000 evaluated rows
per table; they never report a silently truncated success. Use a small staging dataset
or a reviewed owner-indexed verifier when a table exceeds that ceiling. On an
interrupted process or failed cleanup, inspect the reported generated username/sub
and recover only those exact records; do not run broad prefix/table cleanup commands.

Output contains only check labels/status and, on cleanup failure, the generated
fixture username/sub needed for recovery. Raw API responses, JWTs, passwords, TOTP
secrets and AWS errors are deliberately not logged. Final exit code is nonzero for
test failure or cleanup failure. Each run uses normal low-volume Cognito/API/DynamoDB
usage; it provisions no services or recurring charges, but is not claimed to be free.
