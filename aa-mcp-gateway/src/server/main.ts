import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { createServer } from "./http.js";
import { Store } from "../audit/store.js";
import { ActionEngine } from "../policy/engine.js";
import { registry } from "../registry/tools.js";
import { AAApiAdapter } from "../adapters/aa-api.js";
process.umask(0o077);
let c;
try {
  c = config();
} catch {
  console.error(
    "Invalid gateway configuration; check required environment variables.",
  );
  process.exit(1);
}
mkdirSync(dirname(c.DATABASE_PATH), { recursive: true, mode: 0o700 });
const store = new Store(c.DATABASE_PATH);
const engine = new ActionEngine(
  store,
  registry,
  new AAApiAdapter(
    c.AA_INTERNAL_API_URL
      ? { url: c.AA_INTERNAL_API_URL, token: c.AA_MCP_SERVICE_SECRET! }
      : undefined,
  ),
);
const server = createServer(c, engine);
server.listen(c.PORT, c.HOST, () =>
  console.log(JSON.stringify({ event: "gateway_listening", port: c.PORT })),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 20000).unref();
  });
