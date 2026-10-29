# Repository architecture

This page maps the code at this revision. It describes boundaries visible in the repository; it does not assert that every component or route is deployed or that the live database matches the local migrations.

## Components and ownership

| Component | Entry points | Responsibility | Deployment boundary |
| --- | --- | --- | --- |
| Browser console | [`src/App.tsx`](../src/App.tsx), [`src/context/auth.tsx`](../src/context/auth.tsx), [`src/lib/supabase.ts`](../src/lib/supabase.ts) | Role-specific UI, Supabase session and profile loading, job enqueueing, and result subscriptions | Vite build published by the [Pages workflow](../.github/workflows/deploy.yml) on `main` |
| Supabase | [`supabase/migrations/`](../supabase/migrations/), [database notes](../supabase/README.md) | Authentication, data, row-level access, RPCs, and the agent job queue | Managed separately from the frontend build |
| Agent runtime | [`agent-runtime/src/server.ts`](../agent-runtime/src/server.ts), [`worker.ts`](../agent-runtime/src/worker.ts), [`dispatch.ts`](../agent-runtime/src/orchestration/dispatch.ts) | HTTP APIs and leased background workers; dispatches only registered agent runners | Separate Node service; see [runtime deployment notes](../agent-runtime/RAILWAY.md) |
| MCP gateway | [`aa-mcp-gateway/src/server/main.ts`](../aa-mcp-gateway/src/server/main.ts), [`http.ts`](../aa-mcp-gateway/src/server/http.ts), [`policy/engine.ts`](../aa-mcp-gateway/src/policy/engine.ts) | Bot authentication, scoped tool discovery, action policy, approvals, idempotency, and audit | Separate service; see [gateway deployment notes](../aa-mcp-gateway/docs/railway.md) |

### Browser access

[`src/App.tsx`](../src/App.tsx) defines public login and marketing routes and distinct admin, client, and employee consoles. [`AuthProvider`](../src/context/auth.tsx) gets the Supabase session, loads the user's profile, and resolves client or team-member linkage. [`RequireRole`](../src/components/RequireRole.tsx) routes users to the appropriate console.

That browser gate controls navigation. Data access still depends on Supabase policies and RPC checks. [`src/lib/supabase.ts`](../src/lib/supabase.ts) constructs the browser client with the publishable key, enqueues jobs through `enqueue_agent_job`, and subscribes to job updates. It does not contain a service-role key.

### Background work

A user action can call [`enqueueAgentJob`](../src/lib/supabase.ts). Supabase holds the job; the runtime's [claim loop](../agent-runtime/src/worker.ts) asks [`claimNextJob`](../agent-runtime/src/queue.ts) for work the installed runner can execute. The worker marks the job running, renews its lease, dispatches via the [runner registry](../agent-runtime/src/orchestration/dispatch.ts), then records completion, hold, or failure. The lease allows a later claim after a worker stops mid-job.

The runtime is also an HTTP service. [`src/lib/callRuntime.ts`](../src/lib/callRuntime.ts) sends the signed-in user's access token for admin actions, and the runtime exposes separate routes from [`server.ts`](../agent-runtime/src/server.ts). The `AGENT_RUNTIME_ENABLED=false` switch stops worker loops; the health server and heartbeat still start. Do not assume that switch makes every runtime side effect disappear.

### Bot actions

Bot clients call the gateway's authenticated `/mcp` endpoint. [`http.ts`](../aa-mcp-gateway/src/server/http.ts) handles authentication and tool requests; the [policy engine](../aa-mcp-gateway/src/policy/engine.ts) checks permission and client scope before an action. When an AA connection is configured, the [adapter](../aa-mcp-gateway/src/adapters/aa-api.ts) calls fixed internal runtime routes. The gateway does not give Bots raw database, shell, or filesystem access. Its own [README](../aa-mcp-gateway/README.md) distinguishes implemented tools from stubs and describes live integration as a separate gate.

## Credential and data boundaries

| Boundary | Configuration | Rule |
| --- | --- | --- |
| Browser | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, optional `VITE_AGENT_RUNTIME_URL` | `VITE_*` values enter the client bundle. Use only values intended for browsers. |
| Agent runtime | `SUPABASE_SERVICE_ROLE_KEY`, provider keys, runtime service secrets | Set on the server. Do not copy into frontend environment files. |
| MCP gateway | Bot and reviewer credentials, AA service secret, local control-store path | Set on the gateway host; its audit/approval store is private and persistent. |
| Database | Supabase roles, RLS, migrations, and RPC guards | Confirm the target environment and applied migration state before any schema operation. |

The examples in [`.env.example`](../.env.example), [`agent-runtime/.env.example`](../agent-runtime/.env.example), and [`aa-mcp-gateway/.env.example`](../aa-mcp-gateway/.env.example) document variable names. Real values belong in untracked local files or the relevant host's secret manager.

## Verification and release

The [CI workflow](../.github/workflows/ci.yml) independently checks frontend lint, typecheck, tests and build; runtime typecheck, tests and build; and gateway check, tests and build. CI installs FFmpeg for runtime render tests. The [Pages workflow](../.github/workflows/deploy.yml) checks and publishes the frontend after a push to `main`. Runtime and gateway deployment are separate.

For a source-only change, review the diff and run the affected package's CI commands in an isolated checkout. For database, authentication, or integration changes, add the relevant focused tests and verify the target environment before release. [`AGENTS.md`](../AGENTS.md) defines the PR and production release boundary.

## What this map does not prove

A local source tree cannot establish live feature availability, current service health, applied production migrations, or the contents of host-managed secrets. Consult deployment logs and service health checks for those questions. The repository can also contain plans or stubs beside executable features; use the relevant code and tests before describing a feature as operational.
