# B001 system readiness inventory

The agency Admin → System readiness tab collects one read-only snapshot of the
environment that serves the signed-in console. Its JSON export includes the
browser bundle commit, runtime and gateway commits, heartbeat observations,
database migration head and object counts, cron names/schedules/active flags,
global, per-client and per-destination switches, per-action executor support,
message-channel support, credential **presence**,
integration state and schema-backed account identifiers. It never returns a credential value, a Vault secret ID,
cron command text or a database connection string. An unknown, stale or failed
source remains visibly unknown or failed; `/health` does not prove readiness.

Migration 261 also replaces the correlated heartbeat status view with a
`DISTINCT ON (worker_id)` latest-row query and an ordered worker/time/index key.
This addresses the production timeout seen with roughly 147,761 heartbeat
rows. A fresh heartbeat is checked again by the runtime against wall time;
the view's `is_live` flag alone is not accepted as proof.
Each runtime process writes under a per-start UUID identity as well as its PID,
so replicas that both run as PID 1 remain separate fleet observations.
Migration 262 adds bounded heartbeat retention; see
`docs/runtime-heartbeat-retention.md` for its schedule and verification.

The browser calls `GET /admin/system-readiness` with its Supabase access token.
The runtime verifies the live user and `profiles.role = admin` before using its
service client. The gateway's separate `GET /internal/readiness` accepts only
the existing `AA_MCP_SERVICE_SECRET` after host/origin checks. Set
`AA_MCP_GATEWAY_URL` on the runtime to the gateway's HTTPS public origin to
enable that probe; without either setting, the gateway section is Unknown.
The browser bundle gets `VITE_BUILD_SHA` from the Pages workflow; Railway must
provide the full `RAILWAY_GIT_COMMIT_SHA` to the runtime and gateway. A missing
or shortened SHA is Unknown, even when a process responds.

## Deployment order and environment evidence

1. Google Ads migration **260** is a separate, unmerged/unapplied prerequisite
   as of this branch. Migrations **261** and **262** in this change are review
   only until 260 has merged and been applied through the Alex/Chief-of-Staff
   release path. The CI and Pages guards fail if 260 is missing or ordered
   after them. Never apply 261 or 262 ahead of 260.
2. After 260, apply 261 then 262 through the same release path and deploy the matching
   runtime and gateway builds. Deploy the browser build through the existing
   Pages workflow. Configure `AA_MCP_GATEWAY_URL` and the shared service secret
   in the platform secret manager. Do not put them in browser variables.
3. Sign in to the **production** console with an admin account, open Admin →
   System readiness, refresh, and export the JSON. Record the deployed SHAs,
   migration head, fresh heartbeat and evidence time in the B001/R000 ledger.
4. Repeat against a separately deployed **staging** console and staging
   Supabase project using that environment's admin session. A production JWT
   is not assumed valid for staging. Label and retain the two exports
   separately. If staging is not deployed or authenticated, its evidence is
   missing and B001 remains open; the production panel does not infer it.

The inventory proves configuration and observed dependency state at the
capture time. B002 verifies migration object parity; provider receipts,
read-back, spend, leads and bookings belong to their later build gates. A
successful local test or HTTP 200 does not close B001 or R000.

## Evidence coverage in schema version 2

The admin route and downloaded JSON include `evidenceCoverage`. Each named
check has a state (`observed`, `unknown`, or `error`), collection time, source,
source evidence time when there is one, and a reason when evidence is missing.
`observed` means that the named source returned the narrow fact; it does not
mean that the whole business capability is ready. A worker fleet is recorded
only when at least one heartbeat is fresh and every fresh worker is enabled and
reports the runtime's full commit. A switch inventory is recorded only when
the global engine switch and every returned client switch have boolean values.
The cron catalog is separate from cron execution, and object counts are
separate from schema parity.

Every client integration has `providerHealth.state = unknown` until a separate
live provider account check is implemented and captured. A stored `connected`
status, account ID, credential-presence flag, or old `lastCheckedAt` value is
metadata, not proof that the provider accepts the credential today. The export
also keeps credential validity, the other environment, and external effects
explicitly unknown. Capture production and staging separately with an admin
session in each environment; a single export never asserts parity between them.
The JSON export remains a repeatable download of the same captured facts until
Refresh is clicked. The file should be retained as controlled operational
evidence because it contains client and account identifiers, even though it
contains no secret values.
