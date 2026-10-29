# SF53 — Hold a job and resume it

**Where.** Agent job controls, and `held_jobs`
**Owner.** SMM or client manager. **Reviewed.** 25 October 2026. **Part of** MF09, every production flow.

## Why hold rather than cancel
A held job resumes. A cancelled one has to be re-created, losing its place and its inputs.
Hold when work should pause — a client on holiday, a pending decision, a run of bad output
you want to stop before it fills the queue.

## Reading a held state
**Held — waiting on a cap or a paused agent** is not a failure. It means one of:
- A spend cap has been reached for the client
- The agent itself is paused
- A concurrency cap (max jobs in flight) is full

Read `held_jobs` for everything currently held, and why.

## Resume
Resuming releases the job back to the queue. It then goes
`queued` → `claimed` → `running` → `completed`.

## Stale claims
A job claimed by a worker that then died is reaped automatically on a schedule, and there is
a **five-attempt ceiling** so nothing retries forever (SF81). A job that has exhausted its
attempts needs a person to look at why, not another retry.

## Gotcha
If many jobs are held at once, the cause is almost always a cap or a paused agent, not the
jobs themselves. Fix the cause and they all release.
