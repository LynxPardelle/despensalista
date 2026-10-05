# Dokploy CI/CD And CloudFront Origin HTTPS Plan

> **ARCHIVO HISTORICO — NO EJECUTAR.** Describe la topologia PantryList del
> 2026-04-29, ya retirada. La instancia EC2, el origen, los stacks y el rol IAM
> citados dejaron de existir. No recrees esos recursos ni uses la seccion de
> rollback; el runbook vigente es `docs/operations/production-runbook.md`.

Date: 2026-04-29 Central Time

## Objective

Make the PantryList production deployment visible and managed in Dokploy, with
GitHub-driven CI/CD for `main`, then harden the CloudFront to EC2 origin leg so
CloudFront connects to Traefik over HTTPS instead of HTTP.

## Current State

- Public application: `https://pantrylist.lynxpardelle.com`
- Dokploy panel: `https://dokploy.lynxpardelle.com/`
- GitHub repository: `LynxPardelle/PantryList`
- Production branch: `main`
- Current runtime: manual SSM-created Docker Compose stack on the Dokploy EC2
  host.
- Current edge: CloudFront terminates HTTPS for viewers and connects to the EC2
  origin over HTTP.

## Planned Rollout

### 1. Preflight

- Confirm Dokploy API access using an expiring API key without storing it in the
  repository.
- Inventory current Dokploy projects and environments.
- Confirm AWS CloudFront, Route53, EC2, Cognito, and DynamoDB state.
- Confirm the repository has a Dokploy-specific compose file that does not
  publish public host ports.

### 2. Dokploy-Managed Service

- Create or reuse a `PantryList` project in Dokploy.
- Create or reuse a `production` environment.
- Create a Docker Compose service for `main`.
- Configure GitHub source:
  - owner: `LynxPardelle`
  - repository: `PantryList`
  - branch: `main`
  - compose path: `docker-compose.dokploy.prod.yml`
  - auto deploy: enabled
- Store runtime environment values in Dokploy, not in git.
- Deploy the service while keeping the existing manual stack available for
  rollback.

### 3. Origin HTTPS Hardening

- Create `origin.pantrylist.lynxpardelle.com` in Route53 pointing to the Dokploy
  EC2 public IP.
- Attach that origin hostname to the Dokploy-managed compose service with HTTPS
  enabled through Dokploy/Traefik.
- Update the CloudFront origin domain from the raw EC2 DNS name to
  `origin.pantrylist.lynxpardelle.com`.
- Change CloudFront origin protocol policy to HTTPS-only.
- Keep the viewer domain as `pantrylist.lynxpardelle.com`.

## Verification

- Dokploy UI shows the PantryList project, production environment, compose
  service, deployment logs, and GitHub auto-deploy settings.
- A deploy from `main` can be triggered from Dokploy.
- The production domain returns:
  - `/healthz` -> `200`
  - `/api/healthz` -> `200`
  - `/login/` -> `200`
  - `/api/auth/cognito/providers` -> `200`
- Cognito Hosted UI starts from the production domain.
- CloudFront reports the distribution as `Deployed`.
- CloudFront origin protocol is HTTPS-only.

## Execution Results

Completed on 2026-04-29 Central Time.

### Dokploy

- Created Dokploy project: `PantryList`.
- Reused automatically created environment: `production`.
- Created compose service: `pantrylist-production`.
- Compose id: `d1eFduaHWwr_-t-cqE_84`.
- GitHub source:
  - provider id: `BTmVH3U1uN2pFLZL5Ygxu`
  - owner/repository: `LynxPardelle/PantryList`
  - branch: `main`
  - compose path: `docker-compose.dokploy.prod.yml`
  - auto deploy: `true`
- Runtime environment was saved in Dokploy through compose configuration.
- Dokploy detected compose services: `backend`, `frontend`.
- Dokploy domain:
  - host: `pantrylist.lynxpardelle.com`
  - service: `frontend`
  - port: `4000`
  - HTTPS: `false`
  - certificate type: `none`

`pantrylist.lynxpardelle.com` is intentionally the visible Dokploy domain. TLS
for the public domain is handled by CloudFront. Dokploy does not issue the
public certificate because the public DNS record points to CloudFront, not
directly to the EC2 host.

### AWS

- Created Route53 A record:
  `origin.pantrylist.lynxpardelle.com -> 54.198.41.242`.
- Updated CloudFront distribution `E244X3QM2RVQYC`:
  - origin domain: `origin.pantrylist.lynxpardelle.com`
  - origin protocol policy: `https-only`
  - origin HTTPS port: `443`
  - origin request policy: `ALL_VIEWER_EXCEPT_HOST_HEADER`
  - custom origin verification header: `X-PantryList-Origin-Verify`
- Disabled CloudFront IPv6 for `pantrylist.lynxpardelle.com` after local
  validation showed intermittent IPv6 connection resets. Route53 now returns A
  records and no application AAAA alias for this hostname.
- Created Secrets Manager secret:
  `/pantrylist/prod/cloudfront-origin-verify-header`.
- Granted EC2 role `EC2TraefikRoute53DNS01Role` read access to that secret.
- Removed the old manual SSM-created Docker Compose stack:
  `pantrylist-prod-backend-1` and `pantrylist-prod-frontend-1`.
- Removed the old manual Traefik file:
  `/etc/dokploy/traefik/dynamic/pantrylist-prod.yml`.
- Added protected Traefik dynamic route:
  `/etc/dokploy/traefik/dynamic/pantrylist-cloudfront-origin.yml`.
- Added direct public-host block route:
  `/etc/dokploy/traefik/dynamic/pantrylist-direct-public-block.yml`.

### Verification Evidence

- `https://origin.pantrylist.lynxpardelle.com/api/healthz` returned `200`.
- Direct access to `https://origin.pantrylist.lynxpardelle.com/api/healthz`
  without the CloudFront verification header returned `404`.
- Direct HTTP access to the EC2 IP with
  `Host: pantrylist.lynxpardelle.com` returned `502`, not the application.
- CloudFront distribution status returned `Deployed`.
- CloudFront origin inspection returned:
  - domain: `origin.pantrylist.lynxpardelle.com`
  - protocol policy: `https-only`
  - IPv6 enabled: `false`
- Ten repeated public checks returned `200` for:
  - `https://pantrylist.lynxpardelle.com/api/healthz`
  - `https://pantrylist.lynxpardelle.com/api/auth/cognito/providers`
- `https://pantrylist.lynxpardelle.com/login/` returned `200`.
- Cognito hosted login launch returned `200` with Cognito-managed cookies after
  the backend/provider flow reached the Hosted UI.
- Final Docker inventory showed only the Dokploy-managed containers:
  - `compose-compress-back-end-port-hiewlq-frontend-1`
  - `compose-compress-back-end-port-hiewlq-backend-1`

## Incident During Rollout

The first HTTPS-origin CloudFront update returned `502` because the distribution
still used `ALL_VIEWER`, which forwarded
`Host: pantrylist.lynxpardelle.com` to the origin. The origin certificate was
issued for `origin.pantrylist.lynxpardelle.com`, so the certificate name and
forwarded host did not match.

Resolution:

- Rolled CloudFront back to the previous HTTP-only EC2 origin.
- Verified production `/healthz` and `/api/healthz` returned `200`.
- Updated CDK to use `ALL_VIEWER_EXCEPT_HOST_HEADER` whenever the origin
  protocol policy is `https-only`.
- Redeployed CloudFront to the HTTPS origin.

A later route-hardening script initially used shell-interpreted backticks in
the Traefik rule and exposed the previous origin verification value in SSM
stderr. That value was immediately rotated in Secrets Manager, CloudFront was
redeployed with the rotated value, and the Traefik route file was rewritten
using escaped double quotes. The rotated value is the active one.

## Current Residual Risk

- CloudFront IP ranges are represented indirectly by the CloudFront-managed
  service and the custom verification header, not by a security group that
  blocks every non-CloudFront source. The EC2 still hosts Dokploy itself, so a
  host-level 443-only CloudFront security group is not safe without moving
  Dokploy behind its own CloudFront or VPN path.
- Two dynamic Traefik files are intentionally managed outside the Dokploy UI:
  one for the CloudFront-only origin route and one to block direct public-host
  HTTP access. Containers are still fully Dokploy-managed and visible in the
  `PantryList` project.
- CloudFront IPv6 is disabled for this distribution because local IPv6 checks
  showed intermittent resets. Re-enable only after validating IPv6 from a known
  stable network.

## Rollback

- If the Dokploy-managed compose service fails, keep CloudFront pointed at the
  existing manual runtime and stop the failed Dokploy service.
- If the HTTPS origin fails, revert CloudFront to the previous EC2 origin and
  HTTP-only origin protocol while preserving the Dokploy service for debugging.
- If CI/CD behaves incorrectly, disable Dokploy auto deploy and continue manual
  deployments from the Dokploy UI until the webhook/source configuration is
  corrected.

## Security Notes

- The Dokploy API key is temporary and must not be written to tracked files,
  shell profile files, `.env` files, or documentation.
- The origin hostname can still be reached directly unless an additional
  CloudFront-only origin access control is implemented at Traefik, firewall, or
  middleware level.
- CloudFront custom-origin HTTPS requires a valid certificate that matches the
  origin hostname used by CloudFront.

## References

- Dokploy API: `https://docs.dokploy.com/docs/api`
- Dokploy Docker Compose API: `https://docs.dokploy.com/docs/api/compose`
- Dokploy Domain API: `https://docs.dokploy.com/docs/api/domain`
- AWS CloudFront custom origin HTTPS:
  `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-https-cloudfront-to-custom-origin.html`
