# Codex Agent Memory

## Repository Memory Rules

- Keep `Codex.md` for durable agent memory: preferences, project conventions, and decisions future agents should remember.
- Keep changelog or progress-style notes in `changelog/`, not in `Codex.md`.
- Keep research writeups in `docs/research/`. Naming and branding research belongs in `docs/research/naming/`.
- Keep competitor and future-feature research in `docs/research/features/`.
- Keep monetization research in `docs/research/monetization/`.
- When closing any improvement batch, show the full remaining feature backlog with completed items removed, grouped by source/section, and include a short prioritized recommendation for the next batch.
- Use `caveman` communication style by default for this project unless the user explicitly asks for normal mode.
- After validating an improvement batch, use the protected serverless release path:
  merge reviewed work to `main`, release the immutable commit through
  `dev -> tst -> prod`, and verify the matching GitHub/AWS deployment receipts.
  Dokploy/EC2 is historical for this app and must not be used as a fallback.

## Current Project Direction

- Brand decision: use visible product name `Despensa Lista`. Keep technical identifiers such as repo name, cookies, table names, domains, and lowercase `despensalista` storage keys until a separate migration/cutover is planned.
- Before public launch or domain purchase, verify domain availability in a registrar and run a formal trademark search.
- Product adaptation for a Latin American audience is active research. Treat feature ideas in `docs/research/features/` as backlog candidates, not approved implementation scope.
- Monetization exploration is active research. Treat ideas in `docs/research/monetization/` as business hypotheses, not pricing decisions.
- The initial `LatAm Shopping Value + Trust Foundation` package has been implemented: local LatAm units and shopping metadata, budgeted shopping estimates, WhatsApp-friendly export, backend/API persistence, SSR/API hardening, dependency audit cleanup, and CI security checks. Real billing, AI, household sharing, price comparison, and delivery integrations remain out of scope.
- The post-implementation audit pass hardened totals and rate limiting: shopping exports now distinguish full totals, partial totals, and missing prices; optional shopping metadata rejects `null`; SSR/backend rate-limit proxy trust is explicit through env/compose; backend CI uses `lint:check`.
- The next `Household Basics + Visible Savings` package uses existing product-type shopping metadata and derived pantry overview fields instead of adding an event-history table. It adds household staples, staple attention/restock insights, value summaries, and shopping export grouping by store route. Detailed consumption history, collaboration, AI/receipt capture, payments, and retailer integrations remain deferred.
- GitHub Actions owns serverless delivery through isolated `dev`, `tst`, and
  `prod` environments and AWS OIDC roles. A release is built once in `dev` and
  promoted unchanged; production smoke verifies
  `https://despensalista.lynxpardelle.com/healthz`, `/api/healthz`, and no-cache
  HTML headers. Runtime Docker images intentionally remove global `npm/npx`
  because Trivy flagged the base image npm dependency tree; the apps run with
  `node` directly when Docker is used outside the AWS serverless topology.
- The former EC2 instance `i-061f471ff5edea8a9` no longer exists. Its
  `EC2TraefikRoute53DNS01Role` role and instance profile were removed in the
  2026-09 production hardening. Do not recreate or target that path.
- Production authenticated audits should cover stale-session behavior, not only anonymous redirects. Protected frontend services now send credentials explicitly, and lot registration has a timeout so the UI cannot stay on `Registrando lote...` indefinitely when a protected request hangs.
- The next approved improvement direction is a six-block package, in order: privacy controls/data lifecycle, pagination/query limits, observability baseline, shopping mode plus close-purchase flow, offline-capable PWA behavior for shopping, and household sharing lite. The shopping-mode block may include mobile checklist UX, keep-screen-awake support, real paid-price capture, closing purchases into lots, planned-vs-real budget comparison, and robust Web Share/WhatsApp/copy fallback.
- The `Household Savings + PWA Reliability` batch uses derived overview data instead of new product tables: staple catalog groups, waste-at-risk and price coverage summaries, store-route category breakdowns, offline checkout queue, local pantry-data deletion with `ELIMINAR` confirmation, and checkout logs with request IDs. It still does not delete Cognito identities, implement real multi-member households, or add payments/AI/retailer integrations.
- Treat minor audit hardening found during manual production review as part of the next relevant feature batch instead of loose cleanup. Current example: destructive profile actions should keep the action button disabled until the exact confirmation text is present, not only reject the submit handler.
- The active temporary-share management follow-up is implemented: authenticated users can list active shopping-share links, revoke by internal share id without storing the raw token, see created/expires timestamps in Central time, and DynamoDB writes `expiresAtEpochSeconds` for TTL cleanup. This does not implement full household workspaces, change notifications, Cognito identity deletion, or scan-free DynamoDB GSIs for high-volume share lookup.
- P0 architecture backlog: migrate the current one-Lambda serverless backend toward AWS serverless microservices using Lambda, Step Functions where orchestration is needed, and supporting AWS services such as API Gateway, EventBridge/SQS, DynamoDB, CloudWatch, and CDK. The target platform must support three isolated environments: dev, test, and production. Treat this as a deliberate architecture migration, not a small feature batch.
- The household workspace foundation is implemented: default authenticated household creation, owner/editor/viewer role model, email-scoped invite tokens, invite acceptance/revocation, member removal, safe household logs, Mongo/Dynamo persistence, and a profile UI panel. Follow-up household pantry authorization is also implemented: members read the owner's pantry data, owners/editors can mutate it, viewers are read-only, and full pantry deletion is owner-only. The follow-up technical trust batch added recent household activity notifications for household and shared-shopping-list mutations, Cognito-aware account deletion, runtime CI security scanning coverage, and DynamoDB GSI access patterns for household/share lookup. During the GSI transition, destructive cleanup paths must combine indexed records with legacy scan results and deduplicate by `pk` so account deletion does not leave old records behind. Real-time collaboration remains deferred.
- The security lifecycle batch is implemented: profile exposes retention policy and step-up status, archived pantry records can receive Mongo/Dynamo TTL metadata when `ARCHIVED_RECORD_AUTO_DELETE_ENABLED=true`, auto-delete remains off by default, sensitive feature diffs require `docs/privacy/reviews/*.md` in CI, profile can request Cognito global sign-out, and destructive profile actions can require fresh Cognito `auth_time` when `AUTH_STEP_UP_ENABLED=true`. The later production-hardening baseline supersedes optional MFA: every stage uses `mfaConfiguration=ON` for Cognito-local users; federated users rely on their identity provider.
- The LatAm route-and-replenishment batch is implemented: shopping plan groups use a fixed LatAm route order, the pantry form offers starter staple templates, and product-type shopping metadata has `replenishWhenLow` so one-off items can stay visible in inventory without becoming missing/restock candidates after depletion.
- The technical observability and pagination batch is implemented: backend exposes a protected in-memory `/api/metrics` snapshot when `METRICS_ACCESS_TOKEN` is configured, archived pantry reads support cursor pagination with a frontend "Cargar más archivados" flow, export/profile limit metadata includes the archived page size, backend/frontend Docker base images are digest-pinned to `node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920`, and a weekly workflow checks whether the Node base-image digest drifted. Active/legacy cursor pagination remains deferred.
- The productivity/session/waste/observability batch is implemented: profile records and shows hashed known devices from authenticated activity while Cognito global sign-out remains the revocation control, shopping plans can be saved locally as browser snapshots by title/occasion/store, quick capture supports browser speech recognition when available, metrics alerts can be sent to an optional aggregate-only webhook via `METRICS_ALERT_WEBHOOK_URL`, and lot consumption can record waste events with 30-day waste overview. Local saved shopping lists are per-browser, not cross-device sync. Known devices are "seen devices", not a complete Cognito active-session inventory.
- The server-backed shopping savings batch is implemented: saved shopping lists now have authenticated backend persistence, household-scoped read/write controls, export/delete coverage, Mongo/Dynamo repositories, and frontend sync with explicit local fallback. Shopping overview now surfaces possible duplicate-purchase warnings, waste overview shows weekly estimated loss, and the UI includes a disabled Plus preview for future monetization discovery without billing. True per-device Cognito session inventory/revocation remains deferred because the current architecture does not store app-owned refresh sessions per device.
- The Shopping Mode 2.0 LatAm batch is implemented as a frontend workflow layer over existing saved shopping lists and product-type shopping metadata: users can save a "Lista maestra", repeat saved lists even when there are no current restock recommendations, use bulk checklist actions, toggle a shopping item as a household basic, see latest paid price in shopping/plan rows, and use `shoppingNotes` copy as "Notas / pasillo". It does not add retailer integrations, aisle taxonomy tables, payments, or new backend storage.
- The Use-First Waste Reduction batch is implemented as a frontend derived-insight layer over existing overview, waste, and price data: users see "Usar primero" priorities, a "Sobras preparadas" template, expanded storage locations, monthly staple/waste summaries, and a recent purchase/price/waste timeline. It does not add backend storage, new API contracts, OCR, AI, payments, retailer integrations, or destructive one-click consumption.
- The Capture And Portability Foundation batch is implemented as a frontend/local workflow: quick-capture preview, CSV import into editable drafts, active pantry CSV export for Excel, local product-photo preview, local best-effort barcode detection, manual barcode confirmation, and an AI capture credits Plus preview. It does not upload images/CSV/barcodes, add backend storage, add OCR/AI providers, add payments, add retailer/product catalog lookup, or register lots from scan results automatically.
- Payment provider decision: use Stripe for future web/PWA monetization. Future real billing should use Stripe Billing with Checkout Sessions, Products/Prices, verified webhooks, and Customer Portal. Despensa Lista must not store raw card data. The Monetization Discovery With Stripe batch only adds profile UI and local interest events; it does not add Stripe SDK calls, backend billing state, Checkout Sessions, Customers, Subscriptions, Prices, or payment collection.

## 2026-05-29 CT - Origin Verification Header Migrated To SSM (historical)

This whole section describes the retired Dokploy path. The active serverless
origin verification value is now held in stage-scoped Secrets Manager resources;
do not recreate the old SSM parameter or EC2 integration.

- Production CloudFront origin verification header now uses SSM SecureString `/despensalista/prod/cloudfront-origin-verify-header` as the operational source of truth.
- CloudFront does not support SSM SecureString dynamic references for
  `DistributionConfig.Origins`; the retired Dokploy/EC2 deploy used to load the
  value into `DESPENSALISTA_ORIGIN_VERIFY_HEADER_VALUE`. This is historical
  evidence, not an active deployment instruction.
- `despensalista-prod-app` was redeployed with `OriginVerifyHeaderParameterName=/despensalista/prod/cloudfront-origin-verify-header`; EC2 role now has scoped `ssm:GetParameter` for that parameter.
- Remote Traefik route was updated from the same SSM parameter. Public checks returned `200` for `/healthz`, `/api/healthz`, `/login/`, and `/api/auth/cognito/providers`; direct origin without the header returned `404`.
- Old Secrets Manager secret `/despensalista/prod/cloudfront-origin-verify-header` was scheduled for deletion with a 7-day recovery window.
- Superseded at 2026-07-09 13:35 CT: Google/Facebook Cognito provider secrets were moved from Secrets Manager to SSM SecureString parameters.

## 2026-06-09 CT - Dokploy Disk-Full Recovery

- During the Stripe monetization discovery deploy, production health checks hung because the Dokploy EC2 host accepted TCP but returned no HTTP bytes.
- EC2 console output showed `OSError: [Errno 28] No space left on device`; SSM was `ConnectionLost`.
- Root EBS volume `vol-0bd5f763909f1383b` was snapshotted as `snap-0e2ffccfd85932b9f`, expanded from 80 GB to 120 GB, repaired with `e2fsck`, resized with `resize2fs`, and cleaned offline through helper instance `i-0d33f07ef8509f918`.
- Helper instance `i-0d33f07ef8509f918` was terminated and temporary SSH security group rule `sgr-0ddcd029ee29e4d60` for `201.137.54.26/32` was revoked.
- After recovery, SSM returned `Online`, `/healthz` and `/api/healthz` returned `200`, and production-smoke curl calls were hardened with connect/response timeouts.
- Active Dokploy service path is `/etc/dokploy/compose/compose-compress-back-end-port-hiewlq/code`; older `/etc/dokploy/compose/despensalista-prod/code` is not the active routed service. Preserve Dokploy-generated `docker-compose.dokploy.prod.yml` labels when resetting the active worktree.
- The Dokploy host uses `/usr/local/bin/docker-compose` rather than `docker compose`, and the active service uses `.env` rather than `.env.production.local`.
- After manual recovery, the frontend runtime was rebuilt without cache from the Stripe monetization app code, production served `main-6HS7YGRD.js`, and the Stripe panel marker was present in `chunk-6V23M5MG.js`. For docs/workflow-only commits after that, keep the active Dokploy worktree aligned to current `main` while preserving generated labels; a runtime rebuild is only needed when app code changes.
- Temporary SSH security group rule `sgr-0a452c81e8018a820` for `201.137.54.26/32` was revoked after the manual production audit/deploy.

## 2026-07-09 CT - Serverless Migration Foundation And Brand Rename

- Visible product brand is now `Despensa Lista`; technical identifiers should use `despensalista` / `DespensaLista` unless historical docs intentionally describe the old PantryList era.
- Serverless migration should mirror the portfolio AWS flow: protected `dev -> tst -> prod`, GitHub OIDC environment deploys, promotion-source guards, and CDK validation before deploy.
- First migration slice keeps the Nest backend as one Lambda behind API Gateway using the existing DynamoDB repositories and Cognito stack. The current production target is serverless-first, with Dokploy/EC2 left available only for other projects and historical rollback context.
- User confirmed there are no real production users yet, so prod Cognito may run COGNITO-only until social providers are reconnected deliberately.

## 2026-07-09 11:56 CT - Despensa Lista Serverless Production Cutover

- Production is now deployed at `https://despensalista.lynxpardelle.com` through CloudFront distribution `EWXF7S0KL4WVN`, S3 bucket `despensalista-prod-serverless-ba-webbucket12880f5b-wnf5pq5b9mhs`, API Gateway `aoltmu74g9`, Lambda `despensalista-prod-backend-api`, DynamoDB tables `despensalista-prod-users`, `despensalista-prod-products`, `despensalista-prod-product-types`, and `despensalista-prod-inventory-lots`.
- Route53 `A` and `AAAA` records for `despensalista.lynxpardelle.com` alias to CloudFront `dj4i17emyf2p5.cloudfront.net`; CloudFront origins are the S3 bucket and API Gateway only.
- Browser audit loaded `/`, `/login`, and `/pantry`; protected anonymous routes redirected to `/login?redirectTo=%2Fpantry`, `/api/healthz` returned `{"status":"ok","service":"despensalista-backend"}`, and no request URL matched EC2, Dokploy, or PantryList.
- `/healthz`, `/api/healthz`, `/login`, `/pantry`, and `/index.html` returned HTTP 200 after adding the static `index.html` post-build copy for Angular's `index.csr.html` output.
- AWS stack tags were corrected to `Project=despensalista` and `Stage=prod`.
- Security validation after the final deploy: backend `npm audit --omit=dev --audit-level=moderate` returned `0` vulnerabilities; frontend runtime audit returned `0` vulnerabilities. Full frontend audit still has the known dev-only `uuid <11.1.1` path through `webpack-dev-server`/`sockjs` with no fix available.

## 2026-07-09 12:22 CT - GitHub Repository Renamed

- GitHub repository was renamed from `LynxPardelle/PantryList` to `LynxPardelle/despensalista`; local `origin` now points to `https://github.com/LynxPardelle/despensalista.git`.
- Historical Dokploy reports may still mention `LynxPardelle/PantryList`; treat those as evidence from the old EC2/Dokploy era, not current repo identity.

## 2026-07-09 12:22 CT - Remaining PantryList EC2 Decommission Scope

- Old PantryList EC2 path is still live: `https://pantrylist.lynxpardelle.com/healthz` returns `{"status":"ok","service":"pantrylist-frontend"}` and `/api/healthz` returns `{"status":"ok","service":"pantrylist-backend"}`.
- Route53 still has `pantrylist.lynxpardelle.com` aliasing CloudFront `d1p3db27kbt6gj.cloudfront.net` and `origin.pantrylist.lynxpardelle.com` pointing to EC2 IP `32.195.120.158`.
- Old CloudFront distribution `E244X3QM2RVQYC` is enabled with alias `pantrylist.lynxpardelle.com` and origin `origin.pantrylist.lynxpardelle.com`.
- Old stacks still present: `pantrylist-prod-app`, `pantrylist-prod-cognito`, and `pantrylist-dev-cognito`. `pantrylist-prod-app` DynamoDB tables have `DeletionPolicy=Retain` and `UpdateReplacePolicy=Retain`.

## 2026-07-09 12:36 CT - PantryList EC2 Path Decommissioned

- Deleted old CloudFormation stacks `pantrylist-prod-app`, `pantrylist-prod-cognito`, and `pantrylist-dev-cognito`; only `despensalista-prod-cognito` and `despensalista-prod-serverless-backend` remain active for this app.
- Removed all Route53 records containing `pantrylist`; `pantrylist.lynxpardelle.com` no longer resolves. Route53 now only has `despensalista.lynxpardelle.com` plus its ACM validation CNAME.
- Old CloudFront distribution `E244X3QM2RVQYC` is gone from `list-distributions`; active Despensa Lista distribution remains `EWXF7S0KL4WVN`.
- On EC2 `i-061f471ff5edea8a9`, stopped and removed compose containers `compose-compress-back-end-port-hiewlq-frontend-1` and `compose-compress-back-end-port-hiewlq-backend-1`; removed PantryList Traefik dynamic route files; moved old compose/Traefik files to `/etc/dokploy/_decommissioned/despensalista-20260709T183617Z`.
- Superseded at 2026-07-09 13:35 CT: old retained DynamoDB tables `pantrylist-prod-*` were deleted after explicit user approval.
- Superseded at 2026-07-09 13:35 CT: Cognito social providers were restored with SSM SecureString parameters and external IdP upsert script, not Secrets Manager.

## 2026-07-09 13:35 CT - Social Login SSM Migration And Legacy Data Deletion

- User explicitly approved destroying legacy PantryList data. Deleted and waited for removal of `pantrylist-prod-users`, `pantrylist-prod-products`, `pantrylist-prod-product-types`, and `pantrylist-prod-inventory-lots`; only `despensalista-prod-*` DynamoDB tables remain for this app.
- Social provider client secrets moved from old Secrets Manager `/pantrylist/*` names into SSM SecureString parameters `/despensalista/prod/google-client-secret` and `/despensalista/prod/facebook-client-secret`; secret values were not printed.
- AWS CloudFormation rejected direct SSM SecureString dynamic references for Cognito IdP `ProviderDetails.client_secret` with: `SSM Secure reference is not supported in: [AWS::Cognito::UserPoolIdentityProvider/Properties/ProviderDetails/client_secret,AWS::Cognito::UserPoolIdentityProvider/Properties/ProviderDetails/client_secret]`.
- Current pattern: keep Cognito Google/Facebook IdPs externally managed by `infra/cognito/scripts/Set-CognitoSocialProvidersFromSsm.ps1`, then deploy CDK with `externallyManagedSocialProviders=Google,Facebook` so the user pool client and backend Lambda env stay aligned without Secrets Manager.
- Production Cognito `us-east-1_BmNImLALI` now has identity providers `Facebook` and `Google`; app client `7qr67hkrhus4b0bsp62e6rhmej` supports `COGNITO`, `Facebook`, and `Google`; `/api/auth/cognito/providers` returns `{"providers":["COGNITO","Google","Facebook"]}`.
- Old Secrets Manager entries `/pantrylist/dev/google-client-secret`, `/pantrylist/dev/facebook-client-secret`, `/pantrylist/prod/google-client-secret`, and `/pantrylist/prod/facebook-client-secret` were force-deleted without recovery. A follow-up active `list-secrets` query for `pantrylist` and Despensa Lista social secrets returned `[]`.
- Browser audit of `https://despensalista.lynxpardelle.com/login?redirectTo=%2Fpantry` showed title `Despensa Lista`, visible buttons for Cognito, Google, and Facebook, no console warnings/errors, no visible `PantryList` text, and no suspicious PantryList/EC2/Dokploy resource URLs. CloudFront origins remain only API Gateway `aoltmu74g9.execute-api.us-east-1.amazonaws.com` and S3 `despensalista-prod-serverless-ba-webbucket12880f5b-wnf5pq5b9mhs.s3.us-east-1.amazonaws.com`.
- Google click reaches Google but is blocked with `Error 400: redirect_uri_mismatch` until Google Cloud Console authorizes `https://despensalista-prod-765932874577.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` for client ID `830495050505-er7ne3ib3m48rrkjv9n3cj5r9dd5p164.apps.googleusercontent.com`. Facebook click reaches Facebook login using app ID `1663554728118496` with the same Cognito redirect URI.

## 2026-07-09 15:56 CT - Public Privacy Policy For Meta And Google Recheck

- Added and deployed a public prerendered privacy policy at `https://despensalista.lynxpardelle.com/privacidad` for Meta app basic settings. The page includes Google/Facebook login data use, AWS/Cognito processing, retention, user controls, and data deletion instructions.
- CloudFront SPA rewrite now maps `/privacidad` and `/privacidad/` to `/privacidad/index.html`; direct HTTP fetch returned 200 and contained `Politica de privacidad`, `Facebook`, and `Instrucciones de eliminacion de datos` without requiring client-side JS.
- Google OAuth was rechecked after the user updated Google settings: clicking `Entrar con Google` reached `accounts.google.com` login for client `830495050505-er7ne3ib3m48rrkjv9n3cj5r9dd5p164.apps.googleusercontent.com` with no `redirect_uri_mismatch` and no `Error 400`.
- Cognito/API still return allowed providers `COGNITO,Google,Facebook`; SSM parameters `/despensalista/prod/google-client-secret` and `/despensalista/prod/facebook-client-secret` still exist as `SecureString`.
- Avoid running `aws cognito-idp describe-identity-provider` with unmasked provider details in shared logs: Cognito can return provider `client_secret` values. If tool logs are treated as sensitive exposure, rotate both Google and Facebook client secrets and update the SSM parameters before rerunning `Set-CognitoSocialProvidersFromSsm.ps1`.

## 2026-07-09 17:41 CT - Facebook Login Paused

- User decided to continue without Facebook because Meta required business verification and then restricted the account action.
- Production was redeployed with `externallyManagedSocialProviders=Google`; Cognito stack output is now `AllowedProviders = COGNITO,Google`.
- Deleted Cognito identity provider `Facebook` from user pool `us-east-1_BmNImLALI` and deleted SSM SecureString parameter `/despensalista/prod/facebook-client-secret`. Keep `/despensalista/prod/google-client-secret`.
- Verified AWS state: Cognito identity providers list only `Google`, app client `7qr67hkrhus4b0bsp62e6rhmej` supports `COGNITO` and `Google`, and `/api/auth/cognito/providers` returns `{"providers":["COGNITO","Google"]}`.
- Verified public login page shows `Entrar con correo en Cognito` and `Entrar con Google`, with no `Entrar con Facebook`.

## 2026-07-09 17:53 CT - Serverless Migration Status

- Production cutover to serverless is complete for Despensa Lista: active CloudFormation stacks are `despensalista-prod-cognito` and `despensalista-prod-serverless-backend`; CloudFront `EWXF7S0KL4WVN` has only API Gateway `aoltmu74g9.execute-api.us-east-1.amazonaws.com` and S3 `despensalista-prod-serverless-ba-webbucket12880f5b-wnf5pq5b9mhs.s3.us-east-1.amazonaws.com` as origins.
- Route53 records containing the app name only include `despensalista.lynxpardelle.com` A/AAAA aliases and the ACM validation CNAME; `pantrylist.lynxpardelle.com` does not resolve in the current check.
- DynamoDB tables for this app are only `despensalista-prod-users`, `despensalista-prod-products`, `despensalista-prod-product-types`, and `despensalista-prod-inventory-lots`; no `pantrylist-*` tables were returned.
- Current backend architecture is serverless but not split into multiple domain microservices: API Gateway routes `ANY /` and `ANY /{proxy+}` both target the same integration, and the app Lambda is `despensalista-prod-backend-api`.
- Formal remaining validation before calling the migration fully closed is an authenticated CRUD smoke on `/pantry` from a logged-in browser session; unauthenticated health/provider checks are green.

## 2026-07-10 10:55 CT - Production Browser QA And Microservice Priority

- In-app browser QA used the logged-in production session at `https://despensalista.lynxpardelle.com/pantry` for `lnxdrk@gmail.com`.
- Created QA lot `QA Microservicios 1783702396118`, verified active counts changed to `Tipos base 1` and `Lotes 1`, then archived the lot and its empty type.
- After reload, active counts returned to `Tipos base 0` and `Lotes 0`; the QA name was no longer visible, page title was `Despensa Lista`, visible text did not include `PantryList` or `Facebook`, and browser console warning/error logs were empty.
- In-app browser checks for `/profile` and `/privacidad` loaded with title `Despensa Lista`, no console warning/error logs, no visible `PantryList`, and no visible `Facebook`; privacy page still includes `Google y proveedores sociales`.
- Updated improvement backlog to make serverless microservice migration the P0 next architecture priority now that production is serverless but still served by one backend Lambda.

## 2026-07-10 11:22 CT - EC2 Decommission Readiness

- Live AWS check returned only active app stacks `despensalista-prod-cognito` and `despensalista-prod-serverless-backend`; no active `pantrylist` stacks were returned.
- Route53 has only `despensalista.lynxpardelle.com` A/AAAA aliases and the ACM validation CNAME for this app; `pantrylist.lynxpardelle.com` did not resolve in the current DNS check.
- CloudFront distribution `EWXF7S0KL4WVN` has only API Gateway `aoltmu74g9.execute-api.us-east-1.amazonaws.com` and S3 `despensalista-prod-serverless-ba-webbucket12880f5b-wnf5pq5b9mhs.s3.us-east-1.amazonaws.com` as origins.
- DynamoDB check returned only `despensalista-prod-*` tables for this app; no `pantrylist-*` tables were returned.
- Read-only SSM inspection on EC2 `i-061f471ff5edea8a9` showed no matching running Docker containers and no active Traefik files for PantryList/Despensa Lista; only old logs and `_decommissioned/despensalista-20260709T183617Z` copies remain.
- Historical decision at that time: the Despensa Lista/PantryList migration was
  complete, but the shared EC2 was retained for other projects. Superseded in
  2026-09: AWS now reports that instance ID as nonexistent; do not target or
  recreate it.
