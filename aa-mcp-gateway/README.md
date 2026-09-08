# aa-mcp-gateway

AA's standalone business-action and authorization boundary for the ten Grok employee Bots. It is not an agent runtime or chatbot. Bots never receive raw Supabase, SQL, shell, filesystem or unrestricted integration tools.

The foundation implements authenticated Streamable HTTP MCP, filtered discovery, explicit permissions and client scope, strict input validation, a central Action Engine, durable idempotency/approval/audit storage, and a fixed content service adapter. All requested domain tools are catalogued; most are explicitly unimplemented. Default `tools/list` and `call` expose only real (executable) tools the Bot is permitted for; stub contracts remain in the internal registry. Set `MCP_DISCOVER_STUBS=true` locally to surface stubs for testing. The brief adapter connects to the AA endpoint proven live by the AA-side smoke test. Gateway tests use a local mock AA server; no gateway deployment or live gateway smoke test is claimed.

See [architecture](docs/architecture.md), [tool registry](docs/tool-registry.md), [Bot permissions](docs/bot-permissions.md), [AA integration contract](docs/aa-integration.md), and [Phase 3–4 Bot auth / domain RLS design](docs/phase-3-4-bot-auth-rls.md) (Sec decisions locked 2026-09-08; do not apply registry migrations to production without Alex approval).

## Local setup

Use Node 22.13+ (Node 22 image supplied; SQLite is experimental in this Node line).

```sh
npm ci
cp .env.example .env
# Edit .env with your credentials and authorized client UUIDs.
node --env-file=.env --import tsx src/server/main.ts
```

Generate independent tokens using `openssl rand -hex 32`. `BOT_CREDENTIALS_JSON` is an array of `{ "bot": "bot_production", "token": "<unique secret>", "clients": ["<AA client UUID>"] }`. Provision only needed identities; each identity occurs once and has explicit clients. All ten canonical identities are in `src/shared/types.ts`. `REVIEWER_CREDENTIALS_JSON` is an array of `{ "id": "<individual human ID>", "token": "<different unique secret>" }`. Empty/malformed credentials prevent startup in `env`/`dual` modes. `BOT_AUTH_MODE=db` refuses a nonempty `BOT_CREDENTIALS_JSON` (fail closed) and authorizes discover/call from AA-resolved permission patterns (default deny). `workflow.record_decision` stays hard-denied in code in every mode. Tokens, Bearer values, and token hashes are never returned in errors or logs. Revoke/suspend takes effect at AA immediately; the gateway positive cache is 30s unless you bounce the process. Do not set `BOT_AUTH_MODE=db` in deployed/prod config until the locked cutover runbook.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `BOT_AUTH_MODE` | `env` \| `dual` \| `db`. Default `dual`. `db` refuses nonempty `BOT_CREDENTIALS_JSON` and uses AA permissions. |
| `BOT_CREDENTIALS_JSON` | Required Bot tokens and client allowlists except in `db` mode (must be empty) |
| `REVIEWER_CREDENTIALS_JSON` | Required separate human reviewer identities/tokens |
| `HOST` / `PORT` | Bind address; defaults `127.0.0.1:3100` |
| `PUBLIC_ORIGIN` | Exact public origin/Host; default `http://localhost:3100` |
| `DATABASE_PATH` | SQLite control store; default `./data/gateway.sqlite` |
| `AA_INTERNAL_API_URL` / `AA_MCP_SERVICE_SECRET` | Optional pair enabling the fixed AA brief endpoint and Bot token resolve; HTTPS except loopback or host-exact `aa-console.railway.internal` |
| `MCP_DISCOVER_STUBS` | Optional; `true` includes stub contracts in discovery and allows `call` by name. Default off. Local/dev testing only; does not change `/mcp` auth |

`npm run dev` uses already exported environment variables. `npm run build`, `npm run check`, and `npm test` build, typecheck, and run security/domain/HTTP tests. `npm start` runs compiled code with injected environment variables.

## Connecting a Grok Bot

Configure the Bot's MCP client for Streamable HTTP at `https://<gateway>/mcp`, with `Authorization: Bearer <that Bot's token>`. Use an MCP client supporting custom authentication headers; OAuth enrollment is not provided in v1. The official [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server) supplies the transport. Discovery reveals only permitted, implemented tools. Stub names are rejected on `call` unless `MCP_DISCOVER_STUBS=true`. Do not put reviewer or AA service credentials in Bot configuration.

Example `tools/call` arguments for Production Manager:

```json
{"name":"content.generate_brief","arguments":{"client_id":"11111111-1111-4111-8111-111111111111","idea_id":"22222222-2222-4222-8222-222222222222","idempotency_key":"production-brief-001"}}
```

The call passes authentication, authorization, client scope, validation, policy, ContentService, adapter and audit. Without AA connected it returns `not_implemented`; with the required endpoint it returns `accepted` and a job ID. Reuse the same idempotency key and identical input when retrying. A changed input conflicts. Failed/indeterminate actions require operator reconciliation before using another key; remote exactly-once effects require AA-side deduplication too.

The test suite also uses a hypothetical `finance.execute_payment` tool to verify mandatory CRITICAL approval even when metadata sets approval false. That tool and its grant are test-only and absent from the production registry.

## Deployment and operations

Build the Dockerfile and run one replica with a persistent writable volume at `/data`. Inject secrets through the platform secret manager. Terminate TLS at a reverse proxy, preserve the configured Host, restrict ingress to that proxy and configure `PUBLIC_ORIGIN` to the actual HTTPS address. `/health` is a public liveness endpoint. MCP requests are JSON-only, capped at 64 KiB, and rate-limited to 120 requests/minute per socket IP; the proxy should additionally enforce per-credential/global limits. Forwarded IP headers are intentionally not trusted. No browser CORS headers are emitted; Console approval integration is server-side.

SQLite uses WAL/FULL synchronization, private process permissions and transactional reservations. Back up the volume with SQLite-aware backups. Approval payloads contain private business data: restrict volume access, encrypt storage at the platform layer and define retention/archival before launch. Rotate/revoke credentials by updating configuration and restarting. Single-replica deployment is required; migrate the control store and rate limiter before scaling horizontally.

A crash during an external write leaves a durable reservation; do not delete it to retry blindly. Reconcile the upstream execution ID and job state first. A crash after approval execution begins may leave `execution_status=executing`; this intentionally blocks replay and needs operator reconciliation. No background re-executor is included. Audit is durable local storage, not a tamper-proof external ledger. Monitor disk space and ship protected audit backups. A gateway-to-live-AA smoke test and infrastructure deployment remain prerequisites for connecting Grok remotely.

## Local MCP smoke test

After starting the gateway, use the bundled SDK test client (replace all placeholders):

```sh
MCP_BOT_TOKEN='<gateway Production Manager token>' node --import tsx scripts/mcp-test-client.ts '<client UUID>' '<approved idea UUID>' 'production-brief-001'
```

It connects to `http://localhost:3100/mcp`, prints filtered discovery, calls `content.generate_brief`, and calls `workflow.get_activity` for the same client. Repeating the command with identical arguments returns the durable gateway receipt. An AA 202 or 200 both yield `structuredContent` containing `status: "accepted"`, `capability: "content.generate_brief"`, `request_id`, and `data: { job_id, client_id }`. Find the matching request ID with `execution_result: "accepted"` in activity. The SQLite `audit` table also stores this record at `DATABASE_PATH`.

AA failures return `status: "failed"` and `error: { code, upstream_status }`; transport failures use `upstream_timeout` or `upstream_unavailable` without an HTTP status. Invalid successful response bodies use `malformed_response`. Raw AA error messages are never forwarded. Failures remain durable receipts and are not automatically retried. The configured timeout is 15 seconds, including response reading, with a 16 KiB response limit.

## Railway preparation

See [Railway deployment notes](docs/railway.md) for the compiled start command, required public origin, `/data` persistent volume, volume permissions and live AA integration prerequisites. No deployment was performed.
