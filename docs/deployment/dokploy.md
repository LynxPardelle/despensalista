# Dokploy Deployment Notes

> **ARCHIVO HISTORICO — NO EJECUTAR.** Esta ruta pertenecia al runtime
> PantryList/Dokploy retirado. La instancia EC2 y sus recursos IAM ya no
> existen; estos comandos no son un despliegue ni un rollback valido. Usa
> `docs/operations/production-runbook.md` para la ruta serverless vigente. El
> contenido restante se conserva solo como evidencia de la operacion anterior.

This project can run as a production-like Compose stack with:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production.local up -d --build
```

On the Dokploy EC2 host, include the Dokploy network override so Traefik can
reach the frontend container:

```bash
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.dokploy.yml \
  --env-file .env.production.local \
  up -d --build
```

## Topology

- `frontend`: public Angular SSR server on container port `4000`.
- `backend`: internal NestJS/Fastify API on container port `3000`.
- `DynamoDB`: managed AWS persistence for production.
- Browser API calls use same-origin `/api`; the frontend SSR server proxies
  those requests to `BACKEND_URL`.
- `docker-compose.dokploy.yml` attaches only the frontend to the external
  `dokploy-network` so Traefik can route public traffic without exposing the
  backend directly.

## Required Secrets

Set these in Dokploy or in a local untracked env file:

- `PERSISTENCE_PROVIDER=dynamodb`
- `AWS_REGION=us-east-1`
- `DYNAMODB_REGION=us-east-1`
- `DYNAMODB_USERS_TABLE=pantrylist-prod-users`
- `DYNAMODB_PRODUCTS_TABLE=pantrylist-prod-products`
- `DYNAMODB_PRODUCT_TYPES_TABLE=pantrylist-prod-product-types`
- `DYNAMODB_INVENTORY_LOTS_TABLE=pantrylist-prod-inventory-lots`
- `COGNITO_ENABLED=true`
- `COGNITO_ISSUER`
- `COGNITO_DOMAIN`
- `COGNITO_CLIENT_ID`
- `COGNITO_REDIRECT_URI`
- `COGNITO_LOGOUT_REDIRECT_URI`

`COGNITO_CLIENT_SECRET` is optional. Set it only when the Cognito app client is
configured as confidential.

The production Dokploy containers should use the EC2 instance profile for AWS
credentials. Do not place long-lived AWS access keys in Dokploy variables unless
there is a separate incident-approved reason.

## Cognito URLs

Register these URLs in the Cognito app client for the deployment domain:

- Callback URL:
  `https://pantrylist.lynxpardelle.com/api/auth/cognito/callback`
- Sign-out URL: `https://pantrylist.lynxpardelle.com/login`

The production Cognito social provider redirect URI is:

```text
https://pantrylist-prod-765932874577.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
```

Add that URI to Google OAuth and Facebook Login before expecting social login to
work in production.

For local production-like smoke testing on `FRONTEND_PORT=48674`, the example
callbacks are:

- `http://localhost:48674/api/auth/cognito/callback`
- `http://localhost:48674/login`

The repeatable Cognito infrastructure lives in `infra/cognito`. See
`docs/deployment/cognito.md` for the CDK deploy flow and the separate
Google/Facebook `/oauth2/idpresponse` provider redirect URL.

## Cookie Settings

- Keep `AUTH_COOKIE_SECURE=true` for HTTPS deployments.
- For local HTTP-only smoke tests, temporarily set `AUTH_COOKIE_SECURE=false`.
- Set `AUTH_COOKIE_DOMAIN` only if you need cookies shared across a parent
  domain. Leave it unset for a single Dokploy app domain.
- `AUTH_ACCESS_COOKIE_TTL_SECONDS` and `AUTH_REFRESH_COOKIE_TTL_SECONDS` only
  control PantryList cookie max age. Cognito token validity is configured in
  the Cognito app client.

## Local Smoke

Use a high port so this stack can coexist with the development stack:

```bash
FRONTEND_PORT=48674 docker compose -f docker-compose.prod.yml --env-file .env.production.local up -d --build
```

Then validate:

```bash
curl http://localhost:48674/healthz
curl http://localhost:48674/api/healthz
```

Full social-login smoke testing requires a real Cognito User Pool and provider
configuration. Without those env vars, auth endpoints fail closed instead of
falling back to local passwords.
