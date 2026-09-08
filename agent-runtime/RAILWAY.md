# Railway deployment preparation

No deployment or remote migration has been performed by this preparation.

Use the AA Console repository with service Root Directory `/agent-runtime` and configuration file `/agent-runtime/railway.json`. The Dockerfile builds with `npm ci` and `npm run build`, then removes development dependencies. The exact production start command is:

```sh
node dist/server.js
```

This existing compiled entrypoint is preferable to `node --import tsx src/server.ts`: tsx is a development dependency and is deliberately absent from the final image. Build output is self-contained within this service.

Railway supplies `PORT`; leave it unset in manually configured variables. The process uses 8787 only when PORT is absent and rejects malformed/empty ports. It explicitly binds `0.0.0.0`. `GET /health` returns HTTP 200 without credentials and reports liveness, including when workers are disabled. It does not test Supabase/provider availability or expose credentials. Railway config already selects this path.

## Variables

Required at startup:

- `SUPABASE_URL`: intended hosted Supabase project HTTPS URL.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only service credential for that project.
- `ANTHROPIC_API_KEY`: provider key (still required when workers are disabled).

Production configuration:

- `NODE_ENV=production` is set by the Dockerfile.
- `PORT` is supplied by Railway.
- `AGENT_RUNTIME_ENABLED=true` runs workers; use `false` for a deliberate liveness-only rollout.
- `AA_MCP_SERVICE_SECRET`: required to enable gateway calls; use the same dedicated >=32-character secret in both services. Missing leaves the MCP endpoint denied.
- `AGENT_RUNTIME_SHARED_SECRET`: set a separate secret to protect `/status`.
- `MASTER_AI_ALLOWED_ORIGINS=https://console.attractacq.com` and `CONSOLE_URL=https://console.attractacq.com` already default to the hosted Console; override for staging.
- Optional capabilities: `OPENAI_API_KEY` for creative rendering/concepts, `RESEND_API_KEY` and `RESEND_FROM` for email. Model, concurrency, timeout and spend overrides remain documented in `.env.example` and `src/config.ts`.

No `.env`, `.env.local`, localhost server, ngrok tunnel or developer filesystem is loaded by the production command. Inject variables in Railway. State/assets live in hosted Supabase; no runtime persistent volume is needed. Provider and Supabase network availability are required for actual jobs, not liveness.

## Before deployment

Preserve/review the existing uncommitted MCP integration work. Verify the intended database schema is current; migrations 63 and 64 must precede this worker version. Migration 64 intentionally refuses existing duplicate original briefs: inspect and resolve deliberately as described in `MCP_INTEGRATION.md`. Provision explicit Bot/client grants and the shared secret before enabling gateway traffic. No remote migration or provider smoke test has been run here.

Run `npm run typecheck`, `npm test`, and `npm run build` in this directory. The database tests refer to sibling `../supabase/migrations` in the Console checkout; those are a test dependency only, not a production image/runtime dependency.
