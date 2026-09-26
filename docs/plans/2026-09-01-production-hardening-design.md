# DespensaLista production hardening design

Date: 2026-09-01
Status: Approved for one-shot implementation

## Objective

Make the current application safe to promote to production in one coordinated release. The release must remove confirmed legacy AWS resources, make inventory mutations atomic and idempotent, enforce coherent quotas, expose correct cursor pagination, establish a real `dev -> tst -> prod` promotion path, enable low-cost security and observability controls, and configure the DespensaLista SES/DKIM identity without breaking current Cognito email delivery.

The user approved the recommended design on 2026-09-01 and requested a single integrated implementation, deployment, and verification pass. Features whose expected recurring cost exceeds USD 1/month are excluded.

## Mutation semantics

### Idempotency contract

- `POST /inventory-lots/:id/consume` and `POST /pantry/checkout` require an `Idempotency-Key` after a backward-compatible client migration window.
- The accepted key is a UUID generated once by the frontend for a user action and reused for transport retries.
- A canonical request hash binds the key to the authenticated owner, command name, route target, and normalized payload.
- The first successful execution stores a durable receipt for seven days.
- An exact replay returns the original HTTP status and response body and adds `Idempotency-Replayed: true`.
- Reusing a key with a different request hash returns HTTP 409 and performs no mutation.
- Optimistic concurrency conflicts return HTTP 409 and require the client to refresh state; they never silently overwrite a newer lot.

### Atomic consume and waste

One transaction writes the idempotency receipt, conditionally updates or deletes the active lot, creates a deterministic waste event when applicable, and adjusts quota counters when the lot becomes inactive. Every action commits or none does.

### Atomic checkout

One transaction writes the receipt, creates deterministic lot identifiers, applies grouped price/store metadata updates, and adjusts quota counters. The maximum is 49 purchase lines so the worst-case transaction remains within DynamoDB's 100-action limit. Closing a saved shopping list is not part of this command because the current contract does not supply `shoppingListId`; it remains a separate idempotent command unless a future product decision adds it.

MongoDB must provide equivalent all-or-nothing semantics through a session transaction. Environments using MongoDB must run a replica set; startup/configuration must fail clearly when transactional guarantees cannot be provided.

## Quotas and pagination

The following are hard active-entity quotas per authenticated owner:

| Resource | Quota |
|---|---:|
| Active product types | 500 |
| Active inventory lots | 1,000 |
| Active lots per product type | 500 |
| Saved shopping lists | 25 |
| Items per saved list | 100 |
| Checkout lines | 49 |

Archived entities do not consume active quotas. Counters are maintained conditionally in the same mutation transaction and are backfilled/reconciled before enforcement. Reads use state-aware keys/indexes and continue through `LastEvaluatedKey`; `Limit` is never treated as a post-filter quota. Public collection endpoints gain additive opaque cursors with a default page size of 50 and a maximum of 100. Existing array consumers remain compatible during frontend migration.

## Promotion and rollback

- Preserve the repository's `dev -> tst -> prod` branch sequence.
- CI builds application artifacts once per source SHA, records SHA/checksum in an immutable release manifest, and promotes that release rather than rebuilding it.
- GitHub environments restrict their deployment branches and use separate least-privilege OIDC roles.
- Production requires an environment approval when the GitHub plan/API supports it; otherwise branch protection and an explicit promotion gate provide the enforceable fallback.
- Each deploy uses environment-scoped concurrency and runs a post-deploy smoke test.
- A scheduled GitHub Actions smoke test replaces CloudWatch Synthetics.
- Frontend rollback selects the previous immutable release identifier.
- Backend rollback moves a Lambda alias to the previous published version. CodeDeploy canary traffic shifting is enabled only when its related alarm/hook cost remains at or below USD 1/month.

## AWS cleanup and security

Delete only these confirmed legacy resources:

- Cognito pool `us-east-1_H5nTCoqqg` after disabling deletion protection.
- Cognito pool `us-east-1_g049euqS7`.
- SSM parameter `/pantrylist/prod/cloudfront-origin-verify-header`.
- IAM instance profile and role `EC2TraefikRoute53DNS01Role` only after proving that no EC2 instance, launch template, Auto Scaling group, ECS service/task, Lambda, or active CloudFormation stack references them. Managed policies are detached, not deleted.

Do not export the six legacy Cognito identities. Their deletion is intentionally irreversible.

Enable TOTP MFA as required for Cognito-local users. Federated Google users continue to rely on the identity provider's MFA because Cognito cannot add its TOTP challenge to an external-provider session.

Use the CloudFront USD 0 flat-rate plan and its included WAF when the existing distribution is eligible. Add origin verification so callers cannot bypass CloudFront by invoking the API Gateway URL directly. Do not create a pay-as-you-go WAF as an intermediate steady state.

## Observability and cost boundary

Include API access logs with bounded retention, no more than four standard CloudWatch alarms, an SNS topic without an invented email subscriber, deployment rollback signals, corrected resource tags, log retention, stack termination protection, and DynamoDB deletion protection where these do not block the controlled deployment workflow.

Exclude CloudWatch Synthetics and any dashboard or feature expected to add more than USD 1/month. Every usage-priced resource must use retention, throttling, or quotas appropriate to the current low traffic.

## SES and DKIM

Create and verify the SES identity `despensalista.lynxpardelle.com`, publish Easy DKIM records in the existing `lynxpardelle.com` Route 53 hosted zone, and use the intended sender `DespensaLista <no-reply@despensalista.lynxpardelle.com>`.

Keep Cognito on AWS-managed email until `ProductionAccessEnabled=true`; switching while SES is in the sandbox would prevent mail to unverified recipients. Submit a factual transactional-mail production-access request when AWS accepts a new request. Authentication/account notifications are the only approved use case; marketing mail is out of scope.

## Release verification

Before deployment, all backend, frontend, infrastructure, lint, type, security, and synth tests must pass. Deploy non-production targets before production within the same coordinated execution, run authenticated and unauthenticated smoke checks, verify idempotent replay and transaction failure behavior against the deployed API, verify CloudWatch logs/alarms and either the eligible FREE WAF association or the documented no-WAF fallback plus origin-verification control, and retain exact rollback identifiers. Any failed gate triggers rollback rather than partial continuation.
