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
- `AGENT_RUNTIME_SHARED_SECRET`: required at production startup. Generate 32 or more random bytes as hex or base64url; `/status` refuses access without its exact value.
- `PUBLIC_SALES_IP_SALT`: required at production startup, generated independently from the runtime secret. Public IP evidence and quota handles are salted; neither value is logged.
- `PUBLIC_TRUSTED_PROXY_CIDRS`: leave unset. Production startup refuses a value because Railway does not publish a stable, ingress-exclusive proxy CIDR. An observed socket peer or X-Forwarded-For chain cannot establish that trust boundary.
- `PUBLIC_INGRESS_HMAC_REQUIRED`: `false` during schema/runtime rollout. Set `true` only after deploying the isolated facade described in [`ingress/README.md`](ingress/README.md), proving its topology and configuring its separate signing key. With `true`, every anonymous `/public/proof`, `/public/lead`, `/public/book/v1/` and `/public/sales/v1/` request must have a valid signed envelope and a one-use nonce in migration 283's shared store. Direct requests to the core runtime are refused.
- `PUBLIC_INGRESS_HMAC_KEY`: a third, independently generated random 32-byte-or-longer hex/base64url key shared only with the isolated ingress facade. It must differ from `AGENT_RUNTIME_SHARED_SECRET` and `PUBLIC_SALES_IP_SALT`. Never reuse the MCP or Supabase credentials.
- `MASTER_AI_ALLOWED_ORIGINS=https://console.attractacq.com` and `CONSOLE_URL=https://console.attractacq.com` already default to the hosted Console; override for staging.
- Optional capabilities: `OPENAI_API_KEY` for creative rendering/concepts, `RESEND_API_KEY` and `RESEND_FROM` for email. Model, concurrency, timeout and spend overrides remain documented in `.env.example` and `src/config.ts`.

No `.env`, `.env.local`, localhost server, ngrok tunnel or developer filesystem is loaded by the production command. Inject variables in Railway. State/assets live in hosted Supabase; no runtime persistent volume is needed. Provider and Supabase network availability are required for actual jobs, not liveness.

Public database-backed traffic requires migrations 283–285 before this runtime code. Migration 283 supplies the shared caller/subject quota for public writes, widget config reads, booking slot reads and browser preflights that resolve a deployment; 284 reserves both the paid widget's daily message and dollar capacity in one database transaction before model work; 285 exposes bounded, IP-free aggregate status to the admin inventory. A missing or failing quota/budget store refuses the public request. The old `sales_runtime_allow` allowance is revoked in 284, so a schema-first rollout makes old runtime instances refuse paid widget calls. Before applying 284, count enabled deployments, disable or drain any paid widget traffic, and confirm no old paid-widget replica remains serving requests. Keep it disabled until the new runtime is deployed and its reserve/settle probe passes. The first reservation seeds its UTC-day budget from pre-281 successful telemetry, so old writers must be stopped before that first reservation. Once a deployment has budget evidence, its deletion is blocked; disable it to preserve the reservation and provider-spend audit trail.

Keep public lead capture, proof capture and paid widget switches off until migration ancestry, secret quality, isolated ingress topology and negative route probes are verified. The admin-only System Readiness page reports the direct socket peer and bounded canonical X-Forwarded-For chain as diagnostics only; neither is an authorization source. When signed ingress is required, the quota identity comes from the authenticated envelope, never from those headers or the socket peer. Inspect only variable names/presence when checking Railway; never print their values. The runtime's existing `/health` remains public for Railway. Railway's [public networking specifications](https://docs.railway.com/networking/public-networking/specs-and-limits) describe `X-Real-IP` for public ingress; [Railway staff confirms](https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86) that public edge overwrites it but neither socket-peer CIDRs nor XFF hop count is stable. Private-network callers bypass that edge, hence the isolated facade and signed core boundary.

The paid widget's reserve uses a conservative token bound and the runtime's configured model prices. Its Anthropic client disables automatic retries so one reserve covers one provider attempt. If actual reported cost exceeds the reserve, settlement disables that deployment; the already-incurred overage cannot be undone. Keep pricing current before activation. A model timeout or ambiguous settlement leaves the reserve charged and appears in `sales_runtime_budget_status_v6` as `uncertain_count`; the cron marks stale reservations uncertain after ten minutes without releasing their holds. Reconcile a row only after checking provider usage: call `settle_sales_runtime_v6(reservation_id, verified_actual_usd, conversation_id)` through the service-role operator path, using zero only when no charge is confirmed. The function is idempotent for an exact retry. Do not clear holds based on elapsed time alone.

## Before deployment

Preserve/review the existing uncommitted MCP integration work. Verify the intended database schema is current; migrations 63 and 64 must precede this worker version. Migration 64 intentionally refuses existing duplicate original briefs: inspect and resolve deliberately as described in `MCP_INTEGRATION.md`. Provision explicit Bot/client grants and the shared secret before enabling gateway traffic. No remote migration or provider smoke test has been run here.

Run `npm run typecheck`, `npm test`, and `npm run build` in this directory. The database tests refer to sibling `../supabase/migrations` in the Console checkout; those are a test dependency only, not a production image/runtime dependency.
