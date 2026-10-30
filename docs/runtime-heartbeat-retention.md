# Runtime heartbeat status and retention

`agent_runtime_heartbeats` is liveness telemetry, written by each runtime
process every 30 seconds. It is distinct from `agent_tool_calls` and external
action audit records. Historical heartbeat rows need a finite retention period
so the runtime status query and readiness inventory remain usable.

Migration `20261029120000_261_system_readiness_inventory.sql` adds the
`(worker_id, reported_at DESC, id DESC)` index and replaces the correlated
latest-beat view with `DISTINCT ON (worker_id)`. That view change addresses
the observed production timeout immediately without waiting for pruning.

Migration `20261029130000_262_runtime_heartbeat_retention.sql` schedules
`prune-runtime-heartbeats` every 15 minutes. Each execution deletes at most
5,000 rows older than seven days, oldest first, using `SKIP LOCKED`. Only the
service role may call the function directly. It does not delete tool calls,
approval records, campaign actions, or other audit data. The procedure is
idempotent on migration replay: one active named cron job remains.

At the reported 147,761-row baseline, if every row were older than seven
days, clearing that starting backlog would require at most 30 successful
scheduled batches, about 7.5 hours, assuming no lock contention. The actual
drain time depends on the age distribution and cron health. The admin page
must report observed freshness independently of retention progress; a fresh
worker heartbeat does not prove the historical backlog has drained.

## Release sequence and verification

1. Confirm the Google Ads migration 260 has been merged and applied through
   the authorized release path. Apply 261, then 262; do not skip a version.
2. Check that the status view returns quickly for an admin and that a fresh
   worker is marked live. Check the new index with a query plan on a suitably
   populated staging or production table.
3. Confirm exactly one active `prune-runtime-heartbeats` cron job and verify
   its latest run result. Query `count(*)` and oldest `reported_at` before and
   after at least one schedule interval. Confirm rows newer than seven days
   remain.
4. Confirm `anon` and `authenticated` cannot execute the prune function and
   that `agent_tool_calls` and approval/audit row counts are unchanged by it.
5. Record the deployed migration IDs and evidence in
   `docs/100-build-progress.json` only after the actual environment is read.

Rollback is an authorized release decision. The view can be restored from
the previous migration if its new plan regresses. The retention job can be
unscheduled without restoring already deleted liveness rows. Those rows are
intentionally ephemeral; audit and action records are outside its scope.
