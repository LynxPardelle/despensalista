# Google sign-in with WebAuthn in dev

## Scope

The dev deployment uses a dedicated Cognito app client with Google and native
Cognito sign-in. Google exchanges the authorization code with the dev pool.
The application validates Cognito's signed tokens and binds the second factor
to the Cognito subject and refresh-token family. Native sign-in continues to
use Cognito TOTP. The feature is disabled by default and can only be enabled
for the dev deployment.

## Data and retention

- Enrollment stores a credential ID, public key and signature counter
  associated with a hash of the Cognito subject. The private
  key and any PIN or biometric input stay with the authenticator.
- WebAuthn challenges expire after five minutes and are consumed once. The
  session proof expires after one hour. The server checks expiry on reads and
  DynamoDB TTL removes expired challenge and proof records asynchronously.
- An opaque proof cookie is HTTPS-only, host-only and HttpOnly. DynamoDB stores
  a hash of its secret. Sign-out clears the cookie and invalidates the proof.
  The durable account-deletion workflow removes enrolled credentials.

## Access and rollout

- The first enrollment depends on a Google sign-in through Cognito in the
  last 15 minutes.
  A separate assertion with user verification is required to unlock the
  session. The server verifies the exact dev origin and relying-party ID.
  Subsequent Google sessions must verify the enrolled key again.
- The API enforces the second factor before protected operations and profile
  refresh. The web route guides the user through enrollment or verification.
- The release changes the app client in dev, so existing dev sessions may
  need to sign in again. Restoring the previous frontend and Lambda version
  also restores use of the original Cognito client, which offers only native
  sign-in.
- The dev pilot supports one enrolled credential per Google identity. Before
  promotion, decide how users will recover from key loss and whether they can
  register multiple keys. First enrollment trusts control of the Google
  account at that moment.
