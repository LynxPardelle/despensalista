# Production Identity And Deletion Hardening Privacy Review

## Scope And Data

- Account deletion now keeps a durable, short-lived cleanup job containing the
  internal user id, email, username, Cognito subject ids, and the household id
  and role needed to remove the user's data safely.
- The job remains in the existing stage database only until cleanup succeeds.
  Retries use a lease and bounded backoff; successful cleanup deletes the job,
  user record, lookup records, known devices, household data, and Cognito
  identities.
- Account and pantry deletion fences prevent a signed-in or delayed request from
  recreating data while deletion is in progress.
- Archived pantry records remain user-controlled. Automatic archived-record TTL
  deletion stays disabled by default; enabling it requires an explicit positive
  retention period.

## Authentication And Email

- Software-token MFA is required by each stage's Cognito pool. Cognito retains
  the TOTP enrollment material; the application does not receive or store it.
- Cognito remains the email processor for verification and recovery messages.
  The custom-message guard receives the Cognito trigger event, returns it
  unchanged, and stores only atomic daily counters plus a SHA-256 hash of the
  normalized recipient. Raw recipient addresses and verification codes are not
  written to the guard table or application logs.
- The durable deletion job must retain the email until cleanup because household
  membership and invitations can reference it. A failed job therefore extends
  retention until the scheduled worker succeeds and is an operational alert.

## User Control And Access

- Deletion still requires the existing explicit confirmation phrase and normal
  authenticated authorization checks.
- Cognito sessions are globally signed out and every captured subject identity
  is deleted directly. `UserNotFoundException` is treated as an idempotent
  success so retries cannot strand the local cleanup job.
- Only the private scheduled Lambda event can resume deletion jobs. Stage-scoped
  runtime roles can administer users only in their tagged Cognito pool.

## Risks And Decision

- A repeatedly failing external cleanup can retain the job snapshot longer than
  intended. The durable queue avoids silent loss, skips leased/backed-off poison
  jobs, and exposes failures through the production Lambda error alarm.
- The current low-volume worker scans stage tables while deleting an account.
  This is acceptable for launch; partitioned deletion manifests are required
  before table size can exceed one Lambda invocation's bounded cleanup window.
- No new non-AWS processor, advertising identifier, payment data, receipt image,
  or AI/OCR data is introduced.

Decision: approved for the current launch scale with the worker-duration ceiling
tracked as an explicit production follow-up.
