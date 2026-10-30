# B009 live release probe: first phase

`GET https://runtime.attractacq.com/release/readiness` is a minimal, read-only
production deployment identity endpoint. It exists so the later Pages release
gate can compare the commit it is about to publish with the **actually deployed**
runtime and gateway, and compare its schema marker with the **live** production
migration head. A source marker and a successful CI build alone cannot prove
those three live facts.

The endpoint returns HTTP 200 only when all three identities can be observed:

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-10-30T00:00:00.000Z",
  "ready": true,
  "runtimeSha": "<full 40-character commit>",
  "gatewaySha": "<full 40-character commit>",
  "migrationHead": "<14-digit Supabase migration version>",
  "reason": null
}
```

This `ready` field means **identity observations are available**, not that the
three versions are compatible or that a particular release is approved. It is
intentionally separate from the admin System readiness export. The route uses
`system_readiness_catalog` through the runtime's service role and calls the
gateway's service-secret `/internal/readiness` endpoint. It exposes no token,
client inventory, Bot mode, account identifier, SQL definition, or raw error.
Only full commit SHAs are accepted. The gateway observation must be fresh, and
responses are cached for ten seconds to bound public traffic against the two
internal probes. All responses have `Cache-Control: no-store`.

HTTP 503 returns the same shape with `ready:false` and one fixed reason:
`runtime_sha_unknown`, `schema_unavailable`, `gateway_unconfigured`, or
`gateway_unavailable`. A 503 must block any eventual release comparison; a
caller must never treat an absent field or timeout as compatible. Non-GET
requests return 405.

## Release sequence for the second phase

1. Merge this read-only endpoint only after all four protected jobs pass.
2. Confirm Railway has deployed that exact runtime SHA and that the live
   endpoint returns a full runtime SHA, a full gateway SHA and a migration head.
   Compare the two SHAs with the actual Railway deployments and the migration
   head with a separate production read. A 503 is a blocker, not a reason to
   skip the gate.
3. In a separate PR, make the privileged Pages job fetch this endpoint with a
   bounded retry immediately before publication. Compare the runtime and
   gateway SHAs against the CI-tested main commit and the migration head
   against the reviewed release marker. A mismatch, timeout, stale response,
   missing field, or 503 must fail publication without using Pages credentials.
   Test an older runtime, older gateway, pending migration and unreachable
   endpoint. Keep the already released current-main and four-job CI checks.
4. Add the exact PR/SHA/migration/deployment decision and final read-back to
   the unified Approval Inbox. This depends on B008 operational release-class
   coverage; this probe by itself does not close B009 or satisfy that approval.

The browser, worker, and gateway can deploy at different times after a main
merge. The later gate will wait only for a bounded interval, then stop. The
operator must repair the lagging deployment or rerun an authorized CI-gated
release; no failed probe is converted into a green Pages deployment.
