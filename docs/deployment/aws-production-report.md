# PantryList AWS Production Report

> **REPORTE HISTORICO — NO USAR COMO INVENTARIO ACTUAL.** Esta evidencia
> corresponde al despliegue PantryList/Dokploy del 2026-04-29. La instancia EC2
> y los recursos `pantrylist-*` descritos aqui fueron retirados. No ejecutes sus
> acciones pendientes ni los uses como rollback; consulta el informe final del
> 2026-09-26 y `docs/operations/production-runbook.md`.

Date: 2026-04-29 Central Time

## Scope

Production deployment target:

- Application domain: `https://pantrylist.lynxpardelle.com`
- AWS account: `765932874577`
- AWS region: `us-east-1`
- Dokploy host: EC2 `i-061f471ff5edea8a9` (`LynxServer`)
- Existing Dokploy panel: `https://dokploy.lynxpardelle.com/`

Future environments requested but not created in this pass:

- `https://test.pantrylist.lynxpardelle.com`
- `https://dev.pantrylist.lynxpardelle.com`

## Resources Created Or Updated

### CloudFormation

- Created `pantrylist-prod-cognito`.
- Created `pantrylist-prod-app`.

### Cognito

- Created User Pool `us-east-1_H5nTCoqqg`.
- Created app client `7a870ipka5t77osqoio4a0gto5`.
- Created Hosted UI domain:
  `https://pantrylist-prod-765932874577.auth.us-east-1.amazoncognito.com`
- Enabled providers: `COGNITO`, `Google`, `Facebook`.
- Production app callback:
  `https://pantrylist.lynxpardelle.com/api/auth/cognito/callback`
- Production logout URL:
  `https://pantrylist.lynxpardelle.com/login`
- Social provider redirect to configure in Google/Facebook:
  `https://pantrylist-prod-765932874577.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`

### Secrets Manager

- Created `/pantrylist/prod/google-client-secret`.
- Created `/pantrylist/prod/facebook-client-secret`.
- Values were copied from the existing dev secrets without printing secret
  values to terminal output.
- Created `/pantrylist/prod/cloudfront-origin-verify-header` for CloudFront to
  Traefik origin verification.
- Rotated `/pantrylist/prod/cloudfront-origin-verify-header` after an initial
  Traefik route script used shell-interpreted backticks and exposed the previous
  value in SSM command stderr. The rotated value is the active value.

### DynamoDB

Created on-demand tables with AWS-managed encryption, retention policy, and
point-in-time recovery:

- `pantrylist-prod-users`
- `pantrylist-prod-products`
- `pantrylist-prod-product-types`
- `pantrylist-prod-inventory-lots`

### IAM

- Updated EC2 role `EC2TraefikRoute53DNS01Role`.
- Granted the Dokploy EC2 role read/write access to the four PantryList
  DynamoDB tables.
- Granted `dynamodb:TransactWriteItems` on `pantrylist-prod-users` for Cognito
  identity alias writes.

### ACM, CloudFront, And Route53

- Created ACM certificate for:
  - `pantrylist.lynxpardelle.com`
  - `test.pantrylist.lynxpardelle.com`
  - `dev.pantrylist.lynxpardelle.com`
- Created CloudFront distribution `E244X3QM2RVQYC`.
- CloudFront hostname:
  `d1p3db27kbt6gj.cloudfront.net`
- CloudFront origin:
  `origin.pantrylist.lynxpardelle.com`
- CloudFront origin protocol policy:
  `https-only`
- CloudFront custom origin verification header:
  `X-PantryList-Origin-Verify`
- Created Route53 A alias records for `pantrylist.lynxpardelle.com`.
- Created Route53 A record for
  `origin.pantrylist.lynxpardelle.com -> 54.198.41.242`.
- Later disabled the `pantrylist.lynxpardelle.com` CloudFront IPv6/AAAA path
  after local validation showed intermittent IPv6 connection resets.

### Dokploy EC2 Runtime

- Deployed current `main` commit `276b7a9` to:
  `/etc/dokploy/compose/pantrylist-prod/code`
- Created `.env.production.local` on the EC2 host with production Cognito and
  DynamoDB values.
- Started containers with:
  - `docker-compose.prod.yml`
  - `docker-compose.dokploy.yml`
- Created Traefik dynamic route file:
  `/etc/dokploy/traefik/dynamic/pantrylist-prod.yml`

Runtime containers:

- `pantrylist-prod-backend-1`: healthy
- `pantrylist-prod-frontend-1`: healthy

### Dokploy-Managed Production CI/CD

- Created Dokploy project `PantryList`.
- Created compose service `pantrylist-production`.
- Compose id: `d1eFduaHWwr_-t-cqE_84`.
- Connected service to GitHub `LynxPardelle/PantryList`, branch `main`.
- Configured compose path `docker-compose.dokploy.prod.yml`.
- Enabled Dokploy auto deploy.
- Added Dokploy-visible domain `pantrylist.lynxpardelle.com` for service
  `frontend` on port `4000`. Public TLS remains handled by CloudFront.
- Removed the earlier Dokploy-visible `origin.pantrylist.lynxpardelle.com`
  domain so the UI shows the public application domain.
- Removed the earlier manual SSM-created runtime containers:
  - `pantrylist-prod-backend-1`
  - `pantrylist-prod-frontend-1`
- Removed the earlier manual Traefik route file:
  `/etc/dokploy/traefik/dynamic/pantrylist-prod.yml`.
- Added protected CloudFront-origin Traefik route:
  `/etc/dokploy/traefik/dynamic/pantrylist-cloudfront-origin.yml`.
- Added direct public-host block Traefik route:
  `/etc/dokploy/traefik/dynamic/pantrylist-direct-public-block.yml`.

## Verification

Local verification before deploy:

- Backend unit tests: `30` suites / `95` tests passed.
- Backend e2e: `1` suite / `2` tests passed.
- Frontend unit tests: `31` tests passed.
- Frontend production build passed.
- CDK TypeScript build passed.
- Backend production dependency audit: `total = 0`.
- Frontend production dependency audit: `total = 0`.
- Secret scan: `count = 0`.
- `git diff --check` passed with CRLF normalization warnings only.

AWS/runtime verification after deploy:

- CloudFormation stacks reached `CREATE_COMPLETE`.
- CloudFront status: `Deployed`.
- Route53 resolves `pantrylist.lynxpardelle.com` to CloudFront A records.
- Route53 resolves `origin.pantrylist.lynxpardelle.com` to the Dokploy EC2
  public IP.
- CloudFront origin is `origin.pantrylist.lynxpardelle.com` with
  `https-only`.
- EC2 local Traefik health checks:
  - `Host: pantrylist.lynxpardelle.com /healthz` returned `200`.
  - `Host: pantrylist.lynxpardelle.com /api/healthz` returned `200`.
- External checks:
  - `https://pantrylist.lynxpardelle.com/healthz` returned `200`.
  - `https://pantrylist.lynxpardelle.com/api/healthz` returned `200`.
  - `https://pantrylist.lynxpardelle.com/login/` returned `200`.
  - `https://pantrylist.lynxpardelle.com/api/auth/cognito/providers`
    returned `{"providers":["COGNITO","Google","Facebook"]}`.
  - Cognito Hosted UI rendered through the production callback configuration.
- Post-hardening repeated public checks returned `200` for `/api/healthz` and
  `/api/auth/cognito/providers`.
- Direct access to `https://origin.pantrylist.lynxpardelle.com/api/healthz`
  without the CloudFront verification header returned `404`.
- Direct HTTP access to the EC2 IP with `Host: pantrylist.lynxpardelle.com`
  returned `502`.
- Docker inventory showed only the Dokploy-managed PantryList containers:
  `compose-compress-back-end-port-hiewlq-frontend-1` and
  `compose-compress-back-end-port-hiewlq-backend-1`.

## Cost Notes

These are current pricing notes from official AWS pricing pages. Exact monthly
cost depends on traffic, active users, stored data, and API calls.

- EC2: no new EC2 instance was created. Incremental compute cost is `0` for
  this deployment because it reuses the existing Dokploy EC2 instance.
- CloudFront: the distribution is new. AWS currently lists CloudFront Free as
  `$0/month` with `1M` requests and `100GB` data transfer allowance, and paid
  flat-rate plans starting at `$15/month`. Pay-as-you-go remains available and
  bills by usage. Source:
  [Amazon CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/).
- Route53: no new hosted zone was created. The existing public hosted zone cost
  remains as before. The new A/AAAA records are aliases to CloudFront; AWS says
  Route53 does not charge DNS query fees for alias records mapped to supported
  AWS resources such as CloudFront. Source:
  [Amazon Route53 pricing](https://aws.amazon.com/route53/pricing/).
- ACM: the CloudFront certificate is a non-exportable public certificate used
  with an integrated AWS service, so AWS lists it as no additional cost. Source:
  [AWS Certificate Manager pricing](https://aws.amazon.com/certificate-manager/pricing/).
- Cognito: billing is based on monthly active users. The pricing page separates
  direct/social user-pool users from enterprise SAML/OIDC users and notes
  additional charges for advanced security features, SMS, and email messaging.
  We did not enable advanced security features in this CDK stack. Source:
  [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/).
- DynamoDB: the four tables use on-demand mode, so AWS bills per read/write
  request consumed, plus storage and optional features. PITR is enabled, so
  continuous backup storage can add cost as table data grows. Source:
  [Amazon DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/).
- Secrets Manager: two production secrets were created. AWS pricing examples
  show `$0.40` per secret per month and `$0.05` per 10,000 API calls, so the
  fixed secret storage baseline is about `$0.80/month` before API calls.
  Source:
  [AWS Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/).

## Remaining Production Actions

- Add this production Cognito redirect URI to Google OAuth and Facebook Login:
  `https://pantrylist-prod-765932874577.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`
- Create separate CDK/deploy passes for `testing` and `development` after the
  production path is accepted.
- Add CloudFront invalidation to the deploy process if aggressive browser/CDN
  caching becomes visible after frontend releases.
- Consider moving Dokploy itself behind a more controlled access path later
  before applying EC2 security-group-level restrictions to ports `80`/`443`.
