# Railway deployment preparation

No service, domain, variable, volume or deployment has been created remotely.

Use the standalone gateway repository with Root Directory `/` and config `/railway.json`. If deploying its current nested path from a source archive instead, the build context must be `aa-mcp-gateway`; the parent Git repository does not automatically include a nested repository's files. Ensure the actual gateway source and lockfile are available to Railway.

The Dockerfile performs `npm ci`, `npm run build` and production dependency pruning. Exact production start command:

```sh
node dist/src/server/main.js
```

Compiled output already exists and avoids requiring tsx, which is a pruned development dependency. Do not use `node --import tsx src/server/main.ts` in this production image.

`PORT` comes from Railway and defaults to 3100 only when absent; empty/invalid values fail validation. Hosted mode (`NODE_ENV=production` or `RAILWAY_ENVIRONMENT_ID`) defaults to `0.0.0.0` and rejects a loopback HOST, missing public origin, or relative database path. Local mode retains its local defaults.

`GET /health` returns 200 `{ "status": "ok" }` without any credential. It runs before Host/origin enforcement and thus accepts Railway's `healthcheck.railway.app` hostname. Other routes retain Host/origin checks. This proves server liveness, not downstream AA availability. See [Railway healthchecks](https://docs.railway.com/deployments/healthchecks).

## Required Railway variables

| Variable | Value |
| --- | --- |
| `BOT_CREDENTIALS_JSON` | Nonempty array of `{ "bot": "bot_production", "token": "<unique >=32-character secret>", "clients": ["<authorized AA client UUID>"] }` |
| `REVIEWER_CREDENTIALS_JSON` | Nonempty array of `{ "id": "<individual human ID>", "token": "<distinct >=32-character secret>" }` |
| `PUBLIC_ORIGIN` | `https://<actual-gateway-public-domain>`; origin only, no route |
| `DATABASE_PATH` | `/data/gateway.sqlite` (Docker default) |
| `HOST` | `0.0.0.0` (Docker and hosted defaults) |
| `NODE_ENV` | `production` (Docker default) |
| `RAILWAY_RUN_UID` | `0` for Railway's root-owned volume with this Docker image |
| `PORT` | Railway supplies this; do not copy the local port override |

To enable the live AA adapter, set BOTH `AA_INTERNAL_API_URL=https://<runtime-public-domain>` and `AA_MCP_SERVICE_SECRET=<same dedicated secret configured on runtime>`. The adapter permits HTTPS origins (HTTP only for loopback development); do not configure a plain HTTP `railway.internal` URL. Without the pair, tools remain available with the configured unimplemented response. Do not use Bot or reviewer tokens for the service secret.

## Mandatory persistence

Attach one Railway persistent volume to this service at exactly **`/data`**. Set **`DATABASE_PATH=/data/gateway.sqlite`**. Run **one replica**. `railway.json` specifies one replica but cannot attach the volume for you.

The default local path `./data/gateway.sqlite` resolves to `/app/data/gateway.sqlite` in the container; that directory is ephemeral unless mounted. The Railway configuration uses `/data` consistently instead. SQLite contains audit, approvals and idempotency receipts; losing it loses the protection against duplicate writes. Keep SQLite and its WAL/SHM sidecars on the same volume. Do not replace it with ephemeral storage or another database implicitly.

Railway mounts volumes at startup as root; build-time ownership of `/data` does not set the mounted volume's ownership. Set `RAILWAY_RUN_UID=0` as documented by [Railway volume permissions](https://docs.railway.com/volumes#permissions). This runs the gateway as container root on Railway; the image retains its non-root default elsewhere. A separately provisioned volume owned by UID 1000 is an alternative if your platform policy requires non-root operation. Never make the volume world-writable. Restrict secret/volume access and configure backups.

No `.env` file, ngrok, local AA server or existing developer data is required. A fresh mounted directory is initialized at startup. The persistent volume is the intentional filesystem dependency. Health will not become available if configuration or SQLite initialization fails.

## Before deployment

Provision domain, credentials and volume; verify mount permissions. For live AA calls, apply/verify AA migrations 63/64, provision the AA-side Bot/client allowlist, configure the matching service secret and use the runtime HTTPS origin. See the runtime's `MCP_INTEGRATION.md`. A hosted integration smoke test is still required; no hosted database or provider was exercised during preparation. A green health response alone does not prove content generation works.
