# SF81 — Stale claims and the five-attempt ceiling

**Where.** `held_jobs`, `agent_stats`, the reaper crons
**Owner.** Whoever is debugging. **Reviewed.** 25 October 2026. **Part of** MF09.

## What a stale claim is
A worker claims a job, then dies — the runtime restarts, a deploy lands, the process is
killed. The job is left marked as claimed by a worker that no longer exists, and without
intervention it would sit there forever.

## What happens automatically
Reapers run on a schedule and release stale claims back to the queue:

| Reaper | Releases |
|---|---|
| `reap-stale-campaign-action-claims` | Campaign actions |
| `reap-stale-proof-placement-claims` | Proof placements |
| `reap-stale-lead-magnet-deliveries` | Magnet deliveries |

So a job stuck after a deploy usually fixes itself within the hour. Wait before intervening.

## The five-attempt ceiling
Nothing retries forever. After five attempts a job stops and waits for a person.

**A job that has exhausted its attempts needs someone to read why, not another retry.** Five
failures is the system telling you the input is wrong, not that it was unlucky.

## Do it
1. Read the attempt count and the recorded error.
2. Fix the cause — usually a credential (SF05), a rights problem (SF25), or a bad input.
3. Re-request the action rather than re-running the failed job.

## Gotcha
Resetting attempts to get another try, without changing anything, produces a sixth identical
failure and wastes the quota.
