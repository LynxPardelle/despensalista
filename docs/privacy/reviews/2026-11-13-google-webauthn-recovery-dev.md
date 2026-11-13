# WebAuthn backup key and recovery in dev

The dev Google sign-in supports two WebAuthn credentials. Adding a backup
key or generating a replacement recovery code requires a recent WebAuthn
assertion from the same Cognito session. The browser asks the user to keep the
backup key on another device or authenticator and store the recovery code
separately from their Google account.

Recovery requires a recent authenticated Cognito session for the Google
identity and a previously saved, randomly generated recovery code. The
application does not use email, SMS, or support to grant recovery. This pilot
has no manual identity recovery path if both keys and the code are lost.
Before promotion, provide a reliable recovery-event notification to the
verified account address and validate delivery in the target environment.

The 192-bit code is shown once on generation. The application stores its hash
with the credential record and permits five recovery attempts per identity in
each 15-minute window. Entering
the code issues a short-lived WebAuthn registration challenge. Completing it
atomically replaces the old credential set with the newly registered key and
consumes the code. Previously verified Google sessions must prove possession
of a current key again. Recovery itself does not grant application access.

The existing dev DynamoDB table stores credential IDs, public keys, signature
counters, hashes and generation metadata. It does not hold raw recovery codes,
private keys, PINs, or biometric data. The web page holds a displayed code in
memory only. Account deletion removes credential data and the recovery hash.

The dev deployment rejects rollback to the legacy Google MFA implementation,
which cannot validate the current credential generation. Rollback can use a
compatible version or the original native-only client and backend release.
Stage isolation continues to use the exact dev origin and Cognito pool.
