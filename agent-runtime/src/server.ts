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
import { handleMcpCampaign } from "./mcp/campaign-route.js";
import { handleMcpConversion } from "./mcp/conversion-route.js";
import { handleMcpDelivery } from "./mcp/delivery-route.js";
import { handleMcpContent } from "./mcp/content-route.js";
import { handleMcpAdmin } from "./mcp/admin-route.js";
import { handleMcpEngineering } from "./mcp/engineering-route.js";
import { handleMcpSecurity } from "./mcp/security-route.js";
import { handleMcpPipeline } from "./mcp/pipeline-route.js";
import { handleMcpSalesAgents } from "./mcp/sales-agents-route.js";
import { handleMcpProof } from "./mcp/proof-route.js";
import { handleMcpEconomics } from "./mcp/economics-route.js";
import { handleMcpAttribution } from "./mcp/attribution-route.js";
import { handleMcpBrand } from "./mcp/brand-route.js";
import { handleMcpSites } from "./mcp/sites-mcp-route.js";
import { handleMcpAuth } from "./mcp/auth-route.js";
import { handlePublicSales, isPublicSalesRequest } from "./public/sales-route.js";
import { loadConfig } from "./config.js";
import { serviceClient } from "./db.js";
import { startWorker, type WorkerHandle } from "./worker.js";
import { startHeartbeat } from "./heartbeat.js";
import { registeredAgentKeys } from "./orchestration/dispatch.js";
import { handleMasterChat } from "./master/route.js";
import { handleBriefDraft } from "./briefs/draft-route.js";
import { handleCampaignDraft } from "./campaigns/draft-route.js";
import { handlePillarDraft } from "./pillars/draft-route.js";
import { handleContextDraft } from "./context/draft-route.js";
import { handleRecruitmentDraft } from "./recruitment/draft-route.js";
import { handleGitHubStatus } from "./github/status-route.js";
import { handleSitesRoute } from "./github/sites-route.js";
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
  if (req.url === "/internal/mcp/attribution/get-revenue-attribution"
      || req.url?.startsWith("/internal/mcp/economics/")) {
    void handleMcpEconomics(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url === "/internal/mcp/attribution/get-conversion-funnel"
      || req.url === "/internal/mcp/attribution/get-content-performance") {
    void handleMcpAttribution(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url === "/internal/mcp/brand/get-profile") {
    void handleMcpBrand(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url === "/internal/mcp/sites/provision"
      || req.url === "/internal/mcp/sites/publish-page") {
    void handleMcpSites(req, res, sb, config.mcpServiceSecret, config);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/conversion/")) {
    void handleMcpConversion(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/campaign/")) {
    void handleMcpCampaign(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (/^\/internal\/mcp\/(workflow|attribution)\//.test(req.url ?? '')) {
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
  if (req.url?.startsWith("/internal/mcp/admin/")) {
    void handleMcpAdmin(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/engineering/")) {
    void handleMcpEngineering(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/security/")) {
    void handleMcpSecurity(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/pipeline/")) {
    void handleMcpPipeline(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/sales-agents/")) {
    void handleMcpSalesAgents(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/proof/")) {
    void handleMcpProof(req, res, sb, config.mcpServiceSecret);
    return;
  }
  if (req.url?.startsWith("/internal/mcp/auth/")) {
    void handleMcpAuth(req, res, sb, config.mcpServiceSecret);
    return;
  }

  // The public sales widget. Handled before the console CORS block because its
  // allowed origin comes from the deployment record, not from a static env
  // allowlist — a static list cannot express one origin per client site.
  if (isPublicSalesRequest(req.url)) {
    void handlePublicSales(req, res, sb, config);
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
    // GET is here for /admin/github/status. A GET carrying Authorization
    // is preflighted, and the browser refuses it unless the method is listed.
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/admin/github/status") {
    void handleGitHubStatus(req, res, sb, config);
    return;
  }

  if (req.url === "/admin/briefs/draft") {
    if (req.method !== "POST") {
      json(405, { ok: false, error: "POST only" });
      return;
    }
    void handleBriefDraft(req, res, sb, config);
    return;
  }

  if (req.url === "/admin/business-context/draft") {
    if (req.method !== "POST") {
      json(405, { ok: false, error: "POST only" });
      return;
    }
    void handleContextDraft(req, res, sb, config);
    return;
  }

  if (req.url === "/admin/campaigns/draft") {
    if (req.method !== "POST") {
      json(405, { ok: false, error: "POST only" });
      return;
    }
    void handleCampaignDraft(req, res, sb, config);
    return;
  }

  if (req.url === "/admin/pillars/draft") {
    if (req.method !== "POST") {
      json(405, { ok: false, error: "POST only" });
      return;
    }
    void handlePillarDraft(req, res, sb, config);
    return;
  }

  if (req.url === "/admin/recruitment/draft") {
    if (req.method !== "POST") {
      json(405, { ok: false, error: "POST only" });
      return;
    }
    void handleRecruitmentDraft(req, res, sb, config);
    return;
  }

  if (req.url === "/admin/sites/provision" || req.url === "/admin/sites/publish") {
    if (req.method !== "POST") {
      json(405, { ok: false, error: "POST only" });
      return;
    }
    const action = req.url.endsWith("provision") ? "provision" : "publish";
    void handleSitesRoute(req, res, sb, config, action);
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
