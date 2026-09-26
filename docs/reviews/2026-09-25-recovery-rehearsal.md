# DynamoDB recovery rehearsal

Restored the four production tables into isolated, on-demand temporary tables
`despensalista-tst-recovery-20260926-{users,products,product-types,inventory-lots}`
in the same account and region. Production was not modified. All four restores
used the same point: **2026-09-26 01:48:00 UTC**. All tables and their six GSIs
reached ACTIVE; a consistent scan found identical item counts, canonical SHA-256
content digests, primary keys, index keys, and index projections.

| Table | Items | Content digest |
| --- | ---: | --- |
| users | 15 | `90d0b4d62819113c96ac1dd2dad2ca525b7acdc8209e6b6ace2a15ed066dd48e` |
| products | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| product-types | 2 | `580b7335ad1b9322aaa6f56446f3db46a840a0cb07e161303d1503fea7a21471` |
| inventory-lots | 2 | `3a149cdd954664bf4bc8194e73b479a062de6ba4d2e40e78fac6f44ef7328941` |

Reproducible read-only check:

```powershell
node tools/verify-dynamodb-recovery.mjs despensalista-tst-recovery-20260926
```

Run against an unchanged source, or compare a separately recorded point-in-time
snapshot when normal traffic has continued. The check never prints item bodies.
The temporary tables are removed after verification; the source PITR recovery
window remains 35 days.

This verifies data recovery, not a timed full application failover. For an actual
incident, pause writers, select a common recovery timestamp, restore all related
tables, restore TTL/PITR/deletion protection/tags/IAM/alarms explicitly, then point
the application configuration at the verified recovered tables and smoke-test
before reopening writes. Do not copy only inventory while leaving operation
receipts and quota counters at a different recovery point.

AWS charges restoration at USD 0.15/GB in us-east-1; these source tables total
6,749 bytes plus small indexes, far below USD 1 for this one-time exercise.
See [AWS recovery pricing](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamodbDisasterRecoveryStrategy.html)
and [settings not restored automatically](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_RestoreTableToPointInTime.html).
