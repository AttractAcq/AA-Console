# MCP brief generation

The AA runtime owns `POST /internal/mcp/content/generate-brief`. It authenticates
the gateway, calls `enqueue_mcp_brief`, and immediately returns the queued job.
The existing worker runs `runBriefJob`; no prompt, provider call, context loading,
or output persistence has been copied into the gateway or HTTP route.

## Configuration and local run

Required runtime environment: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`ANTHROPIC_API_KEY`. The new endpoint also requires `AA_MCP_SERVICE_SECRET`.
An absent/empty MCP secret denies all requests (401) without disabling the rest
of the runtime. `PORT` defaults to 8787. `AGENT_RUNTIME_ENABLED` must be true for
this process to consume queued jobs. Model configuration is unchanged.

From the repository root, generate a local service secret without printing it:

```sh
export AA_MCP_SERVICE_SECRET="$(openssl rand -hex 32)"
```

Keep that terminal open for the manual request. For a second terminal, securely
supply the same secret there, or store it in the ignored runtime `.env.local`.
Do not put service credentials in Vite variables, commit them, or use shell tracing.
This secret authenticates the gateway service; it is not a Supabase key or a bot's
individual gateway credential.

Create `agent-runtime/.env.local` from `.env.example` if it does not already
exist, then fill in the three existing runtime credentials for the intended test
Supabase project. Do not overwrite an existing environment file. Node loads the
file explicitly; exported environment variables take precedence.

With dependencies installed, run the backend from its directory:

```sh
cd '/Users/alex/Projects/AA Console/agent-runtime'
node --env-file=.env.local --import tsx src/server.ts
```

Alternatively build with `npm run build` and run
`node --env-file=.env.local dist/server.js`. No migration or deployment runs as
part of runtime startup.

## Database setup and client authorization

Apply migrations 63, 64, 65, and 66 to the intended **non-production** test database through the normal
migration process before testing. **Do not apply migrations 65 or 66 to production without Alex approval.**
Migration 65 creates `mcp_internal` Bot registry tables and RPCs. Migration 66 tightens Bot domain RLS
and shared Bot client-grant helpers. Neither inserts live token hashes. See
`aa-mcp-gateway/docs/phase-4-rls-isolation.md`.

AA does not currently have the gateway's live bot/client permission model.
The interim authority is `public.mcp_bot_clients`: an explicit, deny-by-default
allowlist maintained by trusted database administration. No clients are seeded.
The runtime recognizes `bot_production`; adding another identity requires adding
it to `SUPPORTED_BOTS` in `src/mcp/brief-route.ts` and provisioning its grants.
The authenticated gateway is trusted to assert the bot header. Client grants
are checked in the database on every call, including idempotent replays.

Phase 3 Bot token RPCs (service secret required; hash in, never plaintext):

- `POST /internal/mcp/auth/resolve` body `{ "token_hash": "<sha256 hex>" }`
- `POST /internal/mcp/auth/issue` / `rotate` (hard-cut) / `revoke` / `suspend`

Do not log Bearer values or token hashes. Gateway dual-read uses resolve;
`BOT_AUTH_MODE=db` refuses nonempty `BOT_CREDENTIALS_JSON`.

Provision only the client this bot has actually been authorized to operate on,
using the Supabase SQL editor or another trusted admin connection:

```sql
insert into public.mcp_bot_clients (bot_id, client_id)
values ('bot_production', '<authorized-client-uuid>')
on conflict do nothing;
```

Deleting that row revokes access. The gateway cannot manage these grants through
this endpoint. Before wider rollout, connect/synchronize the gateway's current
permission model into this AA-owned check, or explicitly operate this allowlist
as a separately maintained additional restriction. Never replace the check with
trust in the submitted `client_id` alone.

Find a real, eligible idea and its real client together:

```sql
select i.id as idea_id, i.client_id, c.name as client_name, i.title, i.status
from public.client_ideas i
join public.clients c on c.id = i.client_id
join public.mcp_bot_clients m on m.client_id = i.client_id
  and m.bot_id = 'bot_production'
where i.status = 'approved'
order by i.created_at desc;
```

If this returns no rows, there is no eligible idea yet. The existing console's
“Approve & brief” action immediately queues its own job and marks the idea
`briefed`, so it does not leave a test input for this endpoint. A human must
review a real draft and explicitly approve it first. For a deliberately reviewed
test idea, a trusted administrator can perform that approval separately:

```sql
-- Only after human review; use real IDs, never reset a briefed idea to approved.
update public.client_ideas
set status = 'approved'
where id = '<human-reviewed-draft-uuid>'
  and client_id = '<authorized-client-uuid>'
  and status = 'draft'
returning id as idea_id, client_id, status;
```

No approval is performed by the bot endpoint.

## Request, replay and errors

Using IDs returned by the query above, in a terminal containing the service
secret, run:

```sh
export AA_CLIENT_ID='<real-client-uuid>'
export AA_IDEA_ID='<already-approved-idea-uuid>'
export AA_EXECUTION_ID="$(uuidgen)"
export AA_REQUEST_ID="$(uuidgen)"
curl --silent --show-error --include \
  --request POST 'http://127.0.0.1:8787/internal/mcp/content/generate-brief' \
  --header "Authorization: Bearer ${AA_MCP_SERVICE_SECRET}" \
  --header 'x-aa-bot-id: bot_production' \
  --header "x-request-id: ${AA_REQUEST_ID}" \
  --header "idempotency-key: ${AA_EXECUTION_ID}" \
  --header 'Content-Type: application/json' \
  --data "{\"client_id\":\"${AA_CLIENT_ID}\",\"idea_id\":\"${AA_IDEA_ID}\"}"
```

The first success is HTTP 202; identical replay is HTTP 200. Both have exactly:

```json
{"job_id":"<queued-job-uuid>","client_id":"<requested-client-uuid>"}
```

Repeat the curl with the same execution ID to recover the original job after a
lost response or timeout; a new correlation/request ID is allowed. The durable
key is `(bot_id, execution_id)` and is bound to the original client/idea pair.
A different payload under that key returns 409. A different execution key for
an already queued (`briefed`) idea returns 409 rather than creating another job.
The original correlation ID remains in the ledger; replays do not append jobs
or generation events. Failed transactions consume neither a job nor a key.

IDs in headers must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Bot identity is an
exact supported name. The JSON object must contain exactly the two UUID fields.
The route bounds bodies to 4096 bytes, uploads to 10 seconds, and the database
request to 12 seconds. A database timeout can leave an uncertain outcome: retry
with the same execution ID. It is safe even if the first transaction committed.

Errors have the shape:

```json
{"error":{"code":"invalid_idea_status","message":"Idea must already be approved for brief generation."}}
```

| Code | HTTP |
| --- | --- |
| `unauthorized` | 401 |
| `invalid_bot`, `client_forbidden`, `client_mismatch` | 403 |
| `invalid_request` | 400 (405 for non-POST, with `Allow: POST`) |
| `idea_not_found` | 404 |
| `invalid_idea_status`, `idempotency_conflict` | 409 |
| `brief_agent_unavailable` | 503 |
| `queue_failure`, `internal_error` | 500 |

Scope denial takes precedence over idea lookup errors. Unknown database/provider
messages and stack traces are never returned. No request credentials are logged.

## Verify queue and output

Use the job UUID returned by the endpoint:

```sql
select id, agent_key, client_id, input_table, input_id, status, attempts,
       terminal, error, created_by, params, created_at, completed_at
from public.agent_jobs where id = '<queued-job-uuid>';

select bot_id, request_id, execution_id, client_id, idea_id, job_id, created_at
from public.mcp_brief_requests where job_id = '<queued-job-uuid>';

select description, level, payload, created_at
from public.agent_job_events where job_id = '<queued-job-uuid>'
order by created_at;
```

`created_by` is null for bot work. `params` and the queue event contain `source`,
`bot_id`, `request_id`, `execution_id`, `client_id`, and `idea_id`. The ledger and
event's `job_id` link these to the job. The ledger does not expire; its foreign
keys prevent deletion of referenced jobs/ideas/clients until that audit history
is explicitly dealt with.

After `agent_jobs.status = 'completed'`:

```sql
select id, brief_ref, job_id, client_id, source_idea_id, status, title, body,
       hook, premise, argument, proof, proof_asset_id, script, visual_direction,
       shot_requirements, b_roll, call_to_action, channel_intent, created_at
from public.client_briefs
where job_id = '<queued-job-uuid>' and repurpose_format is null;
```

There is at most one original brief per non-null job ID. Its initial status is
`draft`. The idea's `briefed` state denotes queued work, not successful output.
A terminal generation failure stays visible on the job; replay returns that
same job rather than automatically spending again.

## Migration and retry safety

Migration 63 shares queue validation/insertion through a non-callable internal
helper; the human RPC still checks the user and records `auth.uid()`. The new
service-only RPC checks bot scope, locks execution and idea, enqueues, records
attribution, and updates the idea atomically. No new human identity is created.

Migration 64 adds a partial unique index on `client_briefs(job_id)` for original
briefs (`repurpose_format is null`). Repurpose jobs deliberately write multiple
format-specific rows and remain supported. The index still protects original
briefs if their source idea is later detached. The worker first reuses existing
output, then handles a matching concurrent unique-conflict winner without
updating/overwriting its content.

Migration 64 fails rather than deleting historical duplicate briefs. Check for
those before rollout and resolve any duplicates deliberately:

```sql
select job_id, count(*), array_agg(id order by created_at) as brief_ids
from public.client_briefs
where job_id is not null and repurpose_format is null
group by job_id having count(*) > 1;
```

Apply the migrations before deploying the worker change. The worker's safe
conflict handling depends on that database constraint.

## Validation

```sh
npm run typecheck --prefix agent-runtime
npm run build --prefix agent-runtime
npm run test --prefix agent-runtime
npm run build
npm test -- src
```

The root test command is scoped to `src` because an unfiltered Vitest run also
discovers the separate nested gateway checkout and its incompatible Node test
suites. The gateway is outside this change.

The MCP tests run the real relevant schema/queue migrations and both new
migrations in embedded PostgreSQL (PGlite), with only Supabase Auth and unrelated
additive columns supplied as fixtures. They exercise SQL permissions, rollback,
request replay, payload conflicts, scope revocation, the original human RPC, and
the unique index. PGlite serializes SQL execution: overlapping-call tests cover
durable replay, not contention between independent PostgreSQL sessions. HTTP
socket tests bind only an ephemeral loopback port and use a fake database.
Worker tests exercise existing-output retries and concurrent-insert conflicts.

No hosted Supabase migration, live provider generation, full Supabase-stack
replay, or deployment is performed by these tests. Before gateway enablement,
apply the migrations to the intended environment, provision its secret and
explicit client grants, start the runtime, and perform the real approved-idea
smoke test above. The gateway checkout is unchanged.
