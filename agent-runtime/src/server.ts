// Process entry point: a small health/status HTTP surface plus
// config.concurrency worker loops in the same process. One process, not a
// server/worker pair — there is no cross-process coordination this runtime
// needs, and one process is simpler to deploy and health-check.
//
// AGENT_RUNTIME_ENABLED=false is the rollback switch: the health server
// still starts, so the platform health check keeps passing, but no worker
// loops run and the process is inert.

import http from "node:http";
import { handleMcpBrief } from "./mcp/brief-route.js";
import { handleMcpOrchestration } from "./mcp/orchestration-route.js";
import { handleMcpDelivery } from "./mcp/delivery-route.js";
import { handleMcpContent } from "./mcp/content-route.js";
import { handleMcpAuth } from "./mcp/auth-route.js";
import { loadConfig } from "./config.js";
import { serviceClient } from "./db.js";
import { startWorker, type WorkerHandle } from "./worker.js";
import { startHeartbeat } from "./heartbeat.js";
import { registeredAgentKeys } from "./orchestration/dispatch.js";
import { handleMasterChat } from "./master/route.js";
import { logger } from "./logging/logger.js";

const config = loadConfig();
const sb = serviceClient(config);

logger.info("agent_runtime_starting", {
  enabled: config.enabled,
  concurrency: config.concurrency,
  model: config.model,
  leaseSeconds: config.leaseSeconds,
  agents: registeredAgentKeys(),
  pid: process.pid,
});

const workers: WorkerHandle[] = [];
if (config.enabled) {
  for (let i = 0; i < config.concurrency; i += 1) {
    workers.push(startWorker(sb, config, i));
  }
} else {
  logger.warn("agent_runtime_disabled", {
    reason: "AGENT_RUNTIME_ENABLED is not true; no worker loops started.",
  });
}

const heartbeat = startHeartbeat(sb, config, workers.length);

const server = http.createServer((req, res) => {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.url === "/internal/mcp/content/generate-brief") {
    void handleMcpBrief(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (/^\/internal\/mcp\/(workflow|campaign|attribution)\//.test(req.url ?? '')) {
    void handleMcpOrchestration(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/delivery/")) {
    void handleMcpDelivery(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/content/")) {
    void handleMcpContent(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/auth/")) {
    void handleMcpAuth(req, res, sb, config.mcpServiceSecret);
    return;
  }

  // The Master AI is browser-called, so it needs CORS. Only listed origins
  // get the header at all — an unlisted origin is refused by the browser
  // before the request is even attempted.
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/master/chat") {
    if (req.method !== "POST") {
      json(405, { ok: false, error: "POST only" });
      return;
    }
    void handleMasterChat(req, res, sb, config);
    return;
  }

  if (req.url === "/health") {
    // Deliberately unauthenticated and free of secrets — the platform
    // health check hits this.
    json(200, {
      ok: true,
      enabled: config.enabled,
      workers: workers.length,
      pid: process.pid,
    });
    return;
  }

  if (req.url === "/status") {
    if (config.sharedSecret && req.headers["x-runtime-secret"] !== config.sharedSecret) {
      json(401, { ok: false, error: "unauthorized" });
      return;
    }
    json(200, {
      ok: true,
      enabled: config.enabled,
      concurrency: config.concurrency,
      leaseSeconds: config.leaseSeconds,
      model: config.model,
      agents: registeredAgentKeys(),
    });
    return;
  }

  json(404, { ok: false, error: "not found" });
});

server.listen(config.healthPort, "0.0.0.0", () => {
  logger.info("health_server_listening", { port: config.healthPort });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("agent_runtime_stopping", { signal });

  heartbeat.stop();
  server.close();
  // Let in-flight jobs finish their current iteration rather than killing
  // them; anything still running will have its lease expire and be
  // reclaimed by the next worker.
  await Promise.all(workers.map((worker) => worker.stop()));

  logger.info("agent_runtime_stopped", {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
