# Cognito Setup For PantryList

> **GUIA HISTORICA — NO EJECUTAR CONTRA AWS.** Conserva el procedimiento inicial
> PantryList/Dokploy. Sus pools, secretos, callback y host EC2 fueron retirados.
> La fuente operativa actual es `infra/cognito/README.md` junto con
> `docs/operations/production-runbook.md`; no recrees nombres `/pantrylist/*`.

PantryList now uses Cognito as the authentication authority. The application
code is ready; this document covers the AWS setup that makes real Google,
Facebook, and Cognito-hosted email sign-in work.

## Source Of Truth

Use the CDK app in `infra/cognito` for repeatable environments. Do not create
production auth resources only by hand in the AWS Console.

## URLs To Understand

PantryList application callback:

```text
https://<your-app-domain>/api/auth/cognito/callback
```

Cognito social provider callback:

```text
https://<your-cognito-domain>/oauth2/idpresponse
```

These are different URLs. Google and Facebook must use the Cognito
`/oauth2/idpresponse` URL. PantryList itself uses `/api/auth/cognito/callback`.

## Safe Setup Order

1. Choose AWS account, region, stage, and a globally unique Cognito domain
   prefix.
2. Run `npm ci`, `npm run build`, and `npm run synth` in `infra/cognito`.
3. Deploy once with Cognito-only if you want outputs before social setup.
4. Configure Google and Facebook apps with the Cognito domain and
   `/oauth2/idpresponse` redirect URL.
5. Store provider secrets in AWS Secrets Manager.
6. Deploy again with `enableGoogle=true` and/or `enableFacebook=true`.
7. Copy CDK outputs into `.env.docker.local`, `.env.production.local`, or
   Dokploy.
8. Smoke-test login through `http://localhost:48673/login`.

## Local Callback Values

For local Docker development:

```env
COGNITO_REDIRECT_URI=http://localhost:48673/api/auth/cognito/callback
COGNITO_LOGOUT_REDIRECT_URI=http://localhost:48673/login
```

AWS Cognito allows HTTP callback URLs for `localhost` testing. Use HTTPS for
Dokploy and any non-local deployment.

## Dokploy Callback Values

For Dokploy:

```env
COGNITO_REDIRECT_URI=https://<your-dokploy-domain>/api/auth/cognito/callback
COGNITO_LOGOUT_REDIRECT_URI=https://<your-dokploy-domain>/login
```

## Provider Secrets

Provider secrets stay in AWS Secrets Manager and are referenced by secret name
from CDK. Example names:

```text
/pantrylist/dev/google-client-secret
/pantrylist/dev/facebook-client-secret
```

Never commit provider client secrets, Cognito client secrets, or local
environment files.

If a provider client secret is ever pasted into chat, issue trackers, shell
history, screenshots, or logs, rotate it in the provider console, update AWS
Secrets Manager, and redeploy CDK.

## Getting Google Credentials

Use Google Cloud Console. Create or select a project, configure the OAuth
consent screen, then create an OAuth client with application type
`Web application`.

Configure:

- Authorized JavaScript origin:
  `https://<your-cognito-domain>`
- Authorized redirect URI:
  `https://<your-cognito-domain>/oauth2/idpresponse`
- Minimum scopes for PantryList:
  `openid`, `email`, and `profile`

Google shows the client ID and client secret after the client is created. Store
the secret in AWS Secrets Manager; do not paste it into source files.

## Getting Facebook Credentials

Use Meta for Developers. Create an app, add the Website platform, add Facebook
Login, and use the app settings to find the App ID and App Secret.

Configure:

- App domain: `<your-cognito-domain>` without the `https://` prefix if the
  Meta UI expects a host name.
- Website URL: your Cognito login URL or app URL for the environment.
- Valid OAuth Redirect URI:
  `https://<your-cognito-domain>/oauth2/idpresponse`

Store the App Secret in AWS Secrets Manager; do not commit it.

## Secret Helper

After you have the provider credentials, use the local helper so real secrets do
not enter shell history or tracked files:

```powershell
cd infra/cognito
.\scripts\Set-SocialProviderSecrets.ps1 `
  -Google `
  -Facebook `
  -Region us-east-1 `
  -Stage dev `
  -WriteDeployScript
```

The script prompts for Google/Facebook IDs and secrets, writes only the secrets
to AWS Secrets Manager, and can write a local deploy script with non-secret CDK
context arguments to `infra/cognito/Deploy-SocialProviders.local.ps1`, which is
ignored by git.

Then redeploy:

```powershell
.\Deploy-SocialProviders.local.ps1
```

Finally set runtime providers:

```env
COGNITO_ALLOWED_PROVIDERS=COGNITO,Google,Facebook
```

## Verification Checklist

- `infra/cognito`: `npm run build`
- `infra/cognito`: `npm run synth`
- `infra/cognito`: social-provider synth with context values
- Backend: `npm run build`
- Frontend: `npm run build`
- Local smoke: Cognito login redirect starts from `/login`
- Provider apps: redirect URI is exactly
  `https://<your-cognito-domain>/oauth2/idpresponse`

## References

- AWS CDK Cognito construct docs:
  <https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito-readme.html>
- AWS CDK app client callback URL requirements:
  <https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito.CfnUserPoolClientProps.html>
- AWS CloudFormation social IdP provider details:
  <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpoolidentityprovider.html>
- AWS Cognito domain prefix and Managed Login:
  <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-assign-domain-prefix.html>
- AWS Cognito social IdP setup:
  <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp.html>
- Google OAuth 2.0 for web server applications:
  <https://developers.google.com/identity/protocols/oauth2/web-server>
- Meta app development:
  <https://developers.facebook.com/docs/development/create-an-app/>
- Meta Facebook Login for web:
  <https://developers.facebook.com/docs/facebook-login/web/>
