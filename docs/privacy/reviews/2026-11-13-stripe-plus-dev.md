# Stripe Plus Hogar in dev

## Scope and consent

Plus Hogar uses Stripe Checkout and Customer Portal in an isolated sandbox. The
owner opts in from the household profile, which shows the test amount
(MXN 59 per month) and identifies the checkout as a simulation. Cancellation is
available in the portal at the end of the test billing period. The amount
validates the recurring flow and carries no launch pricing decision.

## Data and access

- The API sends Stripe internal billing identifiers for reconciliation.
  Checkout collects billing details directly on Stripe's hosted page. The
  application does not send profile details, inventory, receipts, or household
  member data to Stripe, and it does not receive or store card numbers or CVCs.
- DynamoDB in dev stores the billing record for the household, Stripe object
  identifiers, status, and event identifiers for deduplication. Stripe is the
  external payment processor for this pilot. Use synthetic billing details.
- Only the owner can open the checkout or customer portal. Signed webhook
  events update server-side status. The API verifies the signature against the
  raw body and rejects live payment configuration. Replayed events and repeated
  clicks must converge on the same subscription state.
- Only the dev backend role may read the runtime secret parameter through its
  execution permissions. The parameter is encrypted and server-side.

## Retention and deletion

Stripe's temporary sandbox and its data expire after seven days unless claimed.
The dev DynamoDB table is retained through stack changes. Event markers expire
through the table TTL. Household billing records remain for reconciliation
until removed by an authorized dev operator. The pilot uses synthetic billing
data and does not enable Plus entitlements. Before taking real payments,
integrate subscription cancellation and billing-data handling with account
deletion, define retention for invoices and exportable billing data, and update
the privacy notice and cancellation terms.

## Rollback

The DynamoDB table and parameter are isolated to dev. Roll back the dev API and
frontend to their previous releases to remove access to the test flow. Disable
the dev event destination when retiring the sandbox. Preserve billing data
until test evidence and cleanup have been confirmed.
