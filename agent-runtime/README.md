# AA Console — Agent Runtime

Durable external worker for AA Console's agents. Claims jobs from
`agent_jobs`, runs the agent, writes results back to Supabase. Deployed as a
long-running Node service on Railway — **not** a Supabase Edge Function, and
never driven from the browser.

## Why it exists

The v5 Cockpit ran its agents inside Edge Functions with the browser polling.
19 of its 45 intelligence runs ended `cancelled` because someone closed a tab.
This service exists so that closing a tab is irrelevant: work is claimed under
a lease and survives the client, the browser, and this process restarting.

## Architecture

One process. A health/status HTTP server plus `AGENT_RUNTIME_CONCURRENCY`
worker loops, all in the same process — there is no cross-process
coordination to do, and one process is simpler to deploy and health-check.

```
claim   claim_agent_job(lease_owner, lease_seconds)
        SELECT ... FOR UPDATE SKIP LOCKED
        picks queued | failed-under-cap | lease-expired-and-stuck
        skips agents where paused = true
  |
guard   hasRunner(agent_key)? no -> fail NO_RUNTIME_IMPLEMENTATION
  |
run     status -> running, append job_started event
        lease renewed every leaseSeconds/3
        dispatchJob(agent_key)
  |
finish  markJobCompleted | markJobFailed(retryable?)
        every write asserts count === 1, or the lease was lost
```

Crash safety comes from the lease, not from a reconciler. If this process
dies mid-job, `lease_until` passes and the next claim picks the job back up.

## Three things that will bite you

**1. The `ws` transport in `db.ts` is load-bearing.** `@supabase/supabase-js`
constructs a Realtime client unconditionally, even though this service only
calls `.from()` and `.rpc()`, and that throws *at construction time* without
a native WebSocket global. In v5 this crashed every container start
regardless of `engines.node`, because platforms do not reliably honour it.
Do not "clean it up".

**2. A NULL job comes back as an all-null object, not `null`.** When the
queue is empty, `claim_agent_job` returns SQL NULL, which arrives as
`{id: null, agent_key: null, ...}`. `data ?? null` does not catch it.
Check `row?.id`. This was reproduced in this project's own migration test,
not taken on faith.

**3. Every state transition asserts `count === 1`.** That is how a worker
discovers its lease was stolen instead of silently overwriting another
worker's job.

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SUPABASE_URL` | yes | — | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | The claim RPCs are service-role only |
| `ANTHROPIC_API_KEY` | yes | — | |
| `ANTHROPIC_API_KEY_<AGENT>` | no | — | Per-agent override, e.g. `..._COMPETITOR` |
| `AGENT_RUNTIME_ENABLED` | no | `true` | `false` = health server up, no workers. The rollback switch |
| `AGENT_RUNTIME_CONCURRENCY` | no | `2` | |
| `AGENT_RUNTIME_LEASE_SECONDS` | no | `900` | Must be 30–3600; `claim_agent_job` rejects anything else |
| `AGENT_RUNTIME_EMPTY_QUEUE_BACKOFF_MS` | no | `5000` | |
| `AGENT_RUNTIME_MODEL` | no | `claude-opus-5` | |
| `AGENT_RUNTIME_SHARED_SECRET` | no | — | Required in `X-Runtime-Secret` on `/status` when set |
| `PORT` | no | `8787` | Railway sets this |

Config fails closed: a missing required variable throws at startup rather
than surfacing as undefined behaviour later.

## Endpoints

- `GET /health` — unauthenticated, no secrets. Railway's health check.
- `GET /status` — config summary and registered agent keys. Gated by
  `AGENT_RUNTIME_SHARED_SECRET` when set.

## Local development

```bash
cp .env.example .env      # fill in the three required values
npm install
npm run dev
```

To run against the real database without processing anything, set
`AGENT_RUNTIME_ENABLED=false` — the health server and heartbeat still run.

## Deploying to Railway

New **service** in the existing Railway project (the v5 runtime is still
live against the old database; keeping them separate means retiring v5 is a
decision rather than a side effect).

1. New service → deploy from this repo, root directory `agent-runtime`.
2. Railway reads `railway.json`: Dockerfile build, health check on `/health`
   with a 300s timeout, restart on failure up to 10 times.
3. Set the environment variables above.
4. Confirm: `agent_runtime_heartbeats` gains a row every 30s, and
   `select * from agent_runtime_status` shows `is_live = true`.

## Adding an agent

`src/orchestration/dispatch.ts` holds the `RUNNERS` map. That map, not the
`agents` table, decides what can execute — a registered agent with no entry
here fails loudly rather than being claimed and left to stall.

A runner reads its input (`client_agent_inputs` via the job's
`input_table`/`input_id`), does the work, writes one `client_agent_records`
row per `record_templates` item for its domain, and returns
`{ok, retryable, usage}`.
