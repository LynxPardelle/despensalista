# Despensa Lista Serverless Migration

Date: 2026-07-09 Central Time

> **HISTORICAL SNAPSHOT.** This records the original July migration cut. The
> current deployment, promotion, IAM, and rollback procedure is
> `docs/operations/production-runbook.md`.

## Source Pattern

This migration follows the portfolio AWS flow:

- protected promotion path: `dev -> tst -> prod`
- GitHub Environments per stage
- OIDC deploy role per environment through `AWS_ROLE_ARN`
- CDK validation before deploy
- `tst` deploys only from a merge commit whose second parent is `origin/dev`
- `prod` deploys only from a merge commit whose second parent is `origin/tst`

## Current Cut

The first serverless cut is deliberately small:

- Existing Nest/Fastify backend runs behind one Lambda handler.
- API Gateway HTTP API forwards all routes to that Lambda.
- Existing DynamoDB repositories stay in use.
- Existing Cognito CDK stack provides user pool, app client, issuer, and domain.
- The old Dokploy/EC2 runtime for this app has been decommissioned after
  production smoke passed.

This is not yet the final microservice split. Route-family Lambdas, Step
Functions, EventBridge/SQS, and domain-owned observability are now the next P0
architecture improvement.

## Deploy Variables

Each GitHub Environment needs:

- `AWS_ROLE_ARN`
- `AWS_REGION`, usually `us-east-1`
- `COGNITO_DOMAIN_PREFIX`
- `APP_DOMAIN_NAME`

The current production workflow preserves Google as an externally managed
provider. OAuth client secrets are not GitHub deployment variables.

## Local Commands

```bash
cd infra/cognito
npm ci
npm run build
npm run synth
```

Serverless synth commands exist for stage checks:

```bash
npm run synth:dev
npm run synth:tst
npm run synth:prod
```

## Validation Before Cutover

- backend Lambda `/api/healthz` returns `{"status":"ok","service":"despensalista-backend"}`
- Cognito providers endpoint returns expected providers for the stage
- authenticated pantry overview works against DynamoDB
- account deletion and global sign-out still have Cognito IAM permissions
- frontend can call the API with credentials and XSRF headers
- CloudWatch logs show no cold-start bootstrap errors
- production browser smoke passes for authenticated pantry CRUD
