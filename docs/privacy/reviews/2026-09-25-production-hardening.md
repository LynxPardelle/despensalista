# Privacy review: production hardening

## Data and purpose

Inventory consumption and purchase completion now retain an operation identifier,
a canonical request hash, the owner identifier, and the original response for
seven days. These receipts prevent duplicate inventory changes after retries.
They contain the same pantry fields already visible to the owner; they do not
contain authentication tokens, passwords, payment details, or email bodies.

Quota records contain entity counts per owner and product type. They enforce the
published pantry limits and are not analytics or marketing profiles.

Household membership remains one per user. A deterministic DynamoDB membership
key and a MongoDB unique index prevent concurrent invitations from assigning
multiple households. Existing DynamoDB membership keys migrate atomically on
read without adding personal fields; invitations and membership commit together.

## Access and retention

Receipt lookup includes the authenticated owner and command. A receipt cannot be
used to retrieve another account's response. DynamoDB TTL removes expired receipts
asynchronously; application checks enforce the seven-day replay window even when
TTL deletion is delayed. MongoDB uses equivalent expiration semantics.
At `expiresAt <= now`, a retained receipt returns HTTP 409 without replaying its
response or executing inventory changes, even for an identical request. This
also applies to transaction collision/retry handling. After TTL has physically
removed a receipt, its key cannot be recognized as an old operation: the seven-day
guarantee has ended. Clients must never reuse an old UUID or automatically replace
an expired key; inspect current inventory before explicitly starting a new action.

Pantry/account deletion removes operation receipts, quota counts, preferences,
known devices and pantry content (legacy products, lots, types, lists, shares and
waste events). A normal pantry reset releases its lock. Account deletion first
raises account and pantry fences, then performs the sweep. Writes for profile
sync, preferences, devices, legacy products, shares and household state check the
same account fence in their database transaction; delayed authorized requests
cannot recreate those records after the sweep starts.

Account deletion retains only 24-hour revocation markers for the local user id
and every linked Cognito subject. DynamoDB keys them as
`ACCOUNT_REVOCATION#<SHA-256(principal)>`; MongoDB stores the equivalent SHA-256
digest with a TTL index. The marker contains expiry metadata, not the raw
principal, email, name, inventory, counter or response. Physical TTL removal is
asynchronous and may occur after the expiry timestamp. Release verification
allows these bounded anonymous markers, never surviving account content. Browser
retry records remain scoped to the signed-in user and cannot be silently replayed
after their seven-day server guarantee expires.

Household deletion is also fenced and reentrant. An owner must first remove all
other members; deleting that owner then removes the household cascade. Deleting a
non-owner removes the membership but preserves only non-PII household history:
matching activity `actorUserId`/`targetUserId` values become the shared
non-reversible `deleted-user` marker, target labels become `Usuario eliminado`,
and matching invitations are revoked and redacted to
`deleted@example.invalid`. Unrelated member history is unchanged. New household,
membership, invite and activity writes involving a fenced account are rejected,
so they cannot race the scrub. MongoDB also has TTL indexes for expired shopping
shares and household invitations.

The database sweep and Cognito identity deletion are not one cross-service
transaction. The use case is a durable retryable saga: the database atomically
stores a bounded deletion-job snapshot with the account fence, and the private
scheduled worker claims and retries unfinished jobs with a lease and backoff.
Fences remain in force if the Cognito administrator call or a later cleanup step
fails; operators still monitor failures rather than assuming an all-or-nothing
cross-service commit.

## Authentication and email

TOTP secrets are managed by Cognito. DespensaLista does not store or log them.
Google-federated users retain their provider's authentication controls.

The SES identity is `despensalista.lynxpardelle.com`; the intended sender is
`DespensaLista <no-reply@despensalista.lynxpardelle.com>`. Its permitted purpose is
transactional account verification and recovery. The production configuration
uses that verified custom From while retaining Cognito-managed
`COGNITO_DEFAULT` delivery and its 50-message daily quota; this does not require
SES production access. It must not switch to direct `DEVELOPER` delivery until
AWS approves production access. No marketing mailing list or third-party email
provider is introduced.

## Logs

API access logs contain request identifiers, method, route, response status, and
latency. Do not include authorization headers, cookies, idempotency payloads,
query-string share tokens, request bodies, or response bodies. Retention is bounded
to at most 30 days. Alarm messages contain aggregate service health rather than
pantry contents.

## Legacy deletion

The owner explicitly approved deleting the two disconnected PantryList Cognito
pools and their six identities without exporting personal data. Deletion was
verified on 2026-09-01. The legacy SSM origin secret and unused EC2 instance
profile/role were also removed. Existing DespensaLista production identities and
pantry data are preserved.

## Test data

Deployment smoke tests may create clearly identified temporary Cognito users and
pantry records. Tests must suppress invitation email, keep credentials out of
repository/log output, and remove the temporary user and all associated records
after verification.
