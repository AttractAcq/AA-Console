# SF80 — Confirm which runtime build is live

**Where.** `agent_runtime_status`, and `runtime.attractacq.com/health`
**Owner.** Anyone debugging. **Reviewed.** 25 October 2026.

## Why
When something behaves unlike the memo, the first question is whether the code implementing
the memo is actually deployed.

## The two checks
1. **Health** — `GET https://runtime.attractacq.com/health` is unauthenticated and returns
   `{"ok":true,"enabled":true,"workers":N,...}`.
2. **Version** — read `agent_runtime_status`:

```sql
select worker_id, version, reported_at
from agent_runtime_status
where reported_at > now() - interval '30 minutes';
```

Compare `version` to the commit on `main`. Rows older than that window are stale local runs
with `version = 'local'`.

**Always include the where clause.** The table is big enough that an unbounded
`order by reported_at desc` times out through the MCP.

## There is no deploy step
The runtime redeploys itself when `main` moves. The console ships to GitHub Pages the same
way. So a change that is merged should be live within minutes, and if the version does not
match, the deploy failed rather than not having been run.

## Proving a change is really live
Trust a behaviour, not a version string: call a route the change added and check it answers
in that change's own words.

## Jobs not running at all
Check `workers` in the health response, then `held_jobs` (SF53), then `agent_stats`.
