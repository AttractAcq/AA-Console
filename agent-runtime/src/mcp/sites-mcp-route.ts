import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import {
  BOT,
  ID,
  MCP_ERRORS,
  UUID,
  authenticated,
  fail,
  header,
  json,
  readJsonBody,
} from "./http.js";
import { missingConfig } from "../github/status.js";
import { repoNameProblem } from "../github/sites-route.js";
import { provisionSite, publishPage, type SiteConfig } from "../sites/provision.js";
import { supabaseSiteStore } from "../sites/store.js";

const SITES_BOTS = new Set(["bot_marketing", "bot_sales_ops"]);

function siteConfig(config: RuntimeConfig): SiteConfig {
  return { org: config.githubSitesOrg, runtimeBase: config.publicRuntimeBase };
}

export type SitesMcpDeps = {
  provisionSite?: typeof provisionSite;
  publishPage?: typeof publishPage;
};

/**
 * Bot-authenticated wrappers around the same provisionSite / publishPage
 * orchestration as POST /admin/sites/*. GitHub App credentials stay in
 * RuntimeConfig; they are never returned to the Bot.
 */
export async function handleMcpSites(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  secret: string | null | undefined,
  config: RuntimeConfig,
  deps: SitesMcpDeps = {},
): Promise<void> {
  if (!authenticated(req, secret)) return fail(res, "unauthorized");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { code: "invalid_request", message: "POST required." } });
  }
  const bot = header(req, "x-aa-bot-id");
  if (!bot || !BOT.test(bot)) return fail(res, "invalid_bot");
  if (!SITES_BOTS.has(bot)) return fail(res, "bot_forbidden");
  const requestId = header(req, "x-request-id");
  const executionId = header(req, "idempotency-key");
  if (
    !requestId ||
    !ID.test(requestId) ||
    !executionId ||
    !ID.test(executionId) ||
    !/^application\/json(?:\s*;.*)?$/i.test(header(req, "content-type") ?? "")
  ) {
    return fail(res, "invalid_request");
  }

  const provision = req.url === "/internal/mcp/sites/provision";
  const publish = req.url === "/internal/mcp/sites/publish-page";
  if (!provision && !publish) {
    return json(res, 404, { error: { code: "not_found", message: "Unknown sites route." } });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 16384);
  } catch {
    res.setHeader("Connection", "close");
    return fail(res, "invalid_request");
  }

  const clientId = body.client_id;
  if (typeof clientId !== "string" || !UUID.test(clientId)) return fail(res, "invalid_request");

  let pageId: string | undefined;
  let repo: string | undefined;
  if (provision) {
    if (Object.keys(body).some((k) => !["client_id", "repo"].includes(k)))
      return fail(res, "invalid_request");
    repo = typeof body.repo === "string" ? body.repo.trim().toLowerCase() : "";
    const problem = repoNameProblem(repo);
    if (problem) return fail(res, "invalid_request");
  } else {
    if (Object.keys(body).some((k) => !["client_id", "page_id"].includes(k)))
      return fail(res, "invalid_request");
    pageId = typeof body.page_id === "string" ? body.page_id : "";
    if (!UUID.test(pageId)) return fail(res, "invalid_request");
  }

  const tool = provision ? "sites.provision" : "sites.publish_page";
  try {
    const { data, error } = await sb
      .rpc("mcp_sites_authorize", {
        p_bot_id: bot,
        p_client_id: clientId,
        p_tool: tool,
        ...(pageId ? { p_page_id: pageId } : {}),
      })
      .abortSignal(AbortSignal.timeout(12_000));
    if (error) {
      return fail(
        res,
        error.code === "P0001" && Object.hasOwn(MCP_ERRORS, error.message)
          ? error.message
          : "internal_error",
      );
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return fail(res, "internal_error");
    const record = data as Record<string, unknown>;
    if (String(record.client_id).toLowerCase() !== clientId.toLowerCase())
      return fail(res, "internal_error");
  } catch {
    return fail(res, "internal_error");
  }

  const missing = missingConfig({
    appId: config.githubAppId ?? undefined,
    privateKey: config.githubAppPrivateKey ?? undefined,
  });
  if (missing.length > 0) return fail(res, "github_unconfigured");

  const app = {
    appId: config.githubAppId as string,
    privateKey: config.githubAppPrivateKey as string,
    installationId: config.githubInstallationId,
  };
  const store = supabaseSiteStore(sb);
  const runProvision = deps.provisionSite ?? provisionSite;
  const runPublish = deps.publishPage ?? publishPage;

  try {
    if (provision) {
      const result = await runProvision(store, app, siteConfig(config), {
        clientId,
        repo: repo as string,
      });
      return json(res, 200, {
        client_id: clientId,
        created: result.created,
        owner: result.repo.owner,
        repo: result.repo.repo,
        pages_url: result.pagesUrl,
        status: result.repo.status,
      });
    }
    const result = await runPublish(store, app, siteConfig(config), pageId as string);
    return json(res, 200, {
      client_id: clientId,
      page_id: pageId,
      url: result.url,
      commit: result.commit,
      changed: result.changed,
    });
  } catch {
    return fail(res, "site_failed");
  }
}
