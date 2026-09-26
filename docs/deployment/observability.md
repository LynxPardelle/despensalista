# Observability Baseline

Date: 2026-06-09 CT

## Protected Metrics Endpoint

- Path: `GET /api/metrics`
- Access: disabled with `404` until `METRICS_ACCESS_TOKEN` is configured.
- Header options:
  - `X-Metrics-Token: <token>`
  - `Authorization: Bearer <token>`
- Scope: in-memory process metrics only. Values reset when the backend process restarts.

The snapshot includes request counts, error counts, slow-request counts, average/max duration, status-code counts, route-level aggregates, and threshold alerts. It does not include user IDs, emails, pantry item names, shopping notes, tokens, cookies, request bodies, or query-string values.

## Configuration

- `METRICS_ACCESS_TOKEN`: enables the endpoint and protects it.
- `METRICS_SLOW_REQUEST_THRESHOLD_MS`: default `1000`.
- `METRICS_ERROR_RATE_ALERT_THRESHOLD`: default `0.05`.
- `METRICS_MAX_ROUTES`: default `50`.

## Current Limitations

- This optional `/api/metrics` snapshot has no external exporter or durable
  backend; its route aggregates are process-local and reset with Lambda.
- It is not the production alert path. The versioned serverless stack uses
  bounded CloudWatch API/Lambda logs and four standard production alarms; SNS
  delivery still requires an operator to confirm a real subscription.
- Public availability is checked by the hourly GitHub smoke instead of paid
  CloudWatch Synthetics. See `docs/operations/production-runbook.md` for the
  current controls and cost boundary.
