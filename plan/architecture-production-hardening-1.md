---
goal: Production hardening, atomic mutations, and controlled AWS promotion
version: 1.0
date_created: 2026-09-01
last_updated: 2026-09-01
owner: Codex
status: 'In progress'
tags: [architecture, production, migration, security, devops, bug]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

This plan implements and deploys the approved DespensaLista production-hardening design as one coordinated release with explicit validation and rollback gates.

## 1. Requirements & Constraints

- **REQ-001**: Make inventory consumption/waste and checkout all-or-nothing operations.
- **REQ-002**: Require durable seven-day idempotency for consume and checkout, with exact replay and payload-collision rejection.
- **REQ-003**: Set checkout maximum to 49 lines and preserve the current response body/status on first execution and replay.
- **REQ-004**: Enforce active quotas of 500 product types, 1,000 lots, 500 lots per type, 25 lists, and 100 list items per owner.
- **REQ-005**: Implement opaque cursor pagination with default 50 and maximum 100 without post-filter truncation.
- **REQ-006**: Establish a real `dev -> tst -> prod` immutable-artifact promotion path with post-deploy smoke and rollback.
- **REQ-007**: Delete the four explicitly approved legacy IAM/Cognito/SSM targets only after dependency checks.
- **SEC-001**: Enable Cognito TOTP for local users and preserve Google federation.
- **SEC-002**: Protect both CloudFront and the API origin; direct API Gateway access must not bypass origin verification.
- **SEC-003**: Scope GitHub OIDC trust and permissions by repository and environment.
- **OPS-001**: Configure bounded access logs, at most four paid standard alarms, rollback identifiers, retention, and deletion protections.
- **OPS-002**: Create SES/DKIM identity but keep Cognito managed email while SES remains sandboxed.
- **CON-001**: Do not add a feature whose expected recurring cost exceeds USD 1/month.
- **CON-002**: Preserve all pre-existing uncommitted user/audit changes.
- **CON-003**: Do not deploy production unless all automated validation and non-production smoke gates pass.
- **PAT-001**: Follow `docs/plans/2026-09-01-production-hardening-design.md` exactly.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Establish executable specifications and failing regression tests.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add backend tests for partial consume, duplicate waste, partial checkout, replay, key collision, concurrent quantity conflict, and quota overflow under `backend/src/**/*.spec.ts`. |  |  |
| TASK-002 | Add frontend tests for persistent idempotency keys, retry reuse, 409 refresh behavior, checkout limit 49, and paginated loading under `frontend/src/**/*.spec.ts`. |  |  |
| TASK-003 | Add CDK/workflow tests for MFA, IAM transactions, logs, alarms, SES/DKIM, origin verification, immutable releases, smoke, and rollback under `infra/cognito/test/**` and workflow validation scripts. |  |  |

### Implementation Phase 2

- GOAL-002: Implement atomic storage, idempotency, quota, and pagination semantics.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add the application transaction port and seven-day operation receipt model under `backend/src/application` and `backend/src/domain`. |  |  |
| TASK-005 | Implement DynamoDB `TransactWriteItems` consume and checkout adapters with deterministic identifiers, request hashes, conditions, counters, and retry tokens under `backend/src/infrastructure/database/dynamodb`. |  |  |
| TASK-006 | Implement equivalent MongoDB session transactions and replica-set validation under `backend/src/infrastructure/database/mongodb`. |  |  |
| TASK-007 | Add controller/DTO header validation and replay/conflict response headers/status mapping under `backend/src/infrastructure/http`. |  |  |
| TASK-008 | Correct repository pagination loops and add state-aware cursor contracts/index attributes for active, archived, per-type, and waste reads. |  |  |
| TASK-009 | Implement frontend idempotency-key lifecycle and cursor migration under `frontend/src/app`. |  |  |

### Implementation Phase 3

- GOAL-003: Implement production infrastructure, security, promotion, and rollback.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | Update `infra/cognito/lib/despensalista-cognito-stack.ts` for required local TOTP, SES identity/DKIM, safe email switching, tags, and protections. |  |  |
| TASK-011 | Update `infra/cognito/lib/despensalista-serverless-backend-stack.ts` for transaction IAM, GSIs/counters, origin verification, logs, four-or-fewer alarms, Lambda alias/version/canary, retention, and protections. |  |  |
| TASK-012 | Update `.github/workflows/**` for immutable source-SHA releases, stage guards, environment concurrency, OIDC, post-deploy and scheduled smoke, and rollback inputs. |  |  |
| TASK-013 | Create remote GitHub environments, variables, branch/ruleset protections, and stage-scoped AWS OIDC roles without repository secrets. |  |  |
| TASK-014 | Enroll eligible distributions in the CloudFront Free Plan and included WAF without leaving a pay-as-you-go WAF. |  |  |

### Implementation Phase 4

- GOAL-004: Remove approved legacy resources and deploy the coordinated release.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | Prove no active references and then delete Cognito pools `us-east-1_H5nTCoqqg` and `us-east-1_g049euqS7`, SSM parameter `/pantrylist/prod/cloudfront-origin-verify-header`, and the `EC2TraefikRoute53DNS01Role` profile/role. |  |  |
| TASK-016 | Run complete backend, frontend, E2E, CDK synth/diff, workflow, dependency, and security validation suites. |  |  |
| TASK-017 | Deploy dev, then tst, then prod from one release manifest; stop and roll back on any failed gate. |  |  |
| TASK-018 | Verify deployed health, auth, atomic failure, replay, collision, quota, pagination, MFA, logs, alarms, WAF/origin, SES/DKIM, and rollback identifiers. |  |  |
| TASK-019 | Update audit/report documentation with exact resources, costs, evidence, unresolved external decisions, and rollback commands. |  |  |

## 3. Alternatives

- **ALT-001**: DynamoDB native client tokens alone were rejected because their idempotency window is only ten minutes.
- **ALT-002**: An outbox preserving 50 checkout lines was rejected because price/store metadata would be eventually consistent.
- **ALT-003**: An asynchronous saga was rejected because it changes checkout to a `202` workflow and permits visible intermediate states.
- **ALT-004**: CloudWatch Synthetics was rejected because hourly or five-minute operation exceeds the approved USD 1/month boundary.
- **ALT-005**: Pay-as-you-go WAF was rejected because its base Web ACL charge exceeds the cost boundary.

## 4. Dependencies

- **DEP-001**: AWS account `765932874577` in `us-east-1` and authenticated AWS CLI access.
- **DEP-002**: GitHub repository `LynxPardelle/despensalista` and authenticated `gh` CLI access.
- **DEP-003**: DynamoDB transaction support and current single-region tables.
- **DEP-004**: MongoDB replica-set support for local/non-AWS transactional parity.
- **DEP-005**: Existing Route 53 zone `lynxpardelle.com` for DKIM records.
- **DEP-006**: CloudFront distribution eligibility for the USD 0 flat-rate plan.

## 5. Files

- **FILE-001**: `backend/src/application/**` — transaction use cases, ports, quotas, and idempotency.
- **FILE-002**: `backend/src/domain/**` — operation receipt and deterministic mutation semantics.
- **FILE-003**: `backend/src/infrastructure/database/**` — DynamoDB/MongoDB atomic adapters and pagination.
- **FILE-004**: `backend/src/infrastructure/http/**` — headers, DTO limits, response replay/conflict mapping.
- **FILE-005**: `frontend/src/app/**` — idempotency and cursor clients/UI.
- **FILE-006**: `infra/cognito/lib/**` and `infra/cognito/test/**` — AWS resources and assertions.
- **FILE-007**: `.github/workflows/**` — promotion, smoke, and rollback automation.
- **FILE-008**: `docs/plans/**`, `docs/reviews/**`, and `plan/**` — approved design, execution plan, and final evidence.

## 6. Testing

- **TEST-001**: Prove injected failure cannot leave waste without inventory decrement or a partial checkout.
- **TEST-002**: Prove exact request replay produces no writes and returns the original result.
- **TEST-003**: Prove key/payload collision and optimistic concurrency conflict return 409.
- **TEST-004**: Prove quota increments/decrements are atomic and overflow is rejected.
- **TEST-005**: Prove filtered DynamoDB pages continue across empty pages and return stable opaque cursors.
- **TEST-006**: Run backend unit, integration, E2E, lint, build, and dependency/security checks.
- **TEST-007**: Run frontend unit, E2E, lint, build, accessibility, and production smoke checks.
- **TEST-008**: Run CDK tests, synth, diff inspection, workflow validation, and post-deploy AWS assertions.
- **TEST-009**: Execute controlled deployed replay/conflict tests against non-production before production.

## 7. Risks & Assumptions

- **RISK-001**: Legacy Cognito deletion irreversibly removes six identities; deletion is explicitly authorized without export.
- **RISK-002**: Removing the EC2 IAM role can break an undiscovered external caller; exhaustive AWS dependency checks are mandatory immediately before deletion.
- **RISK-003**: SES production access can remain externally blocked after a correct identity/DKIM setup.
- **RISK-004**: CloudFront Free Plan enrollment can impose usage-limit degradation; current traffic is far below its allowance.
- **RISK-005**: GitHub plan limitations can prevent required reviewers; branch/ruleset fallback must remain enforceable.
- **ASSUMPTION-001**: Current low DespensaLista traffic keeps logs, alarms, transactions, and test stages below the USD 1/month per-feature boundary.
- **ASSUMPTION-002**: Checkout does not close a saved shopping list because the current API has no `shoppingListId`.

## 8. Related Specifications / Further Reading

- `docs/plans/2026-09-01-production-hardening-design.md`
- `docs/reviews/2026-08-31-production-readiness-audit.md`
- https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html
- https://aws.amazon.com/cloudfront/pricing/
- https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa-totp.html
