// POST /admin/sites/provision and POST /admin/sites/publish.
//
// Admin-authenticated, like the status route, because both act on the client's
// public presence: one creates a repository in AA's organisation, the other
// puts a page on the open internet. Neither is something every logged-in user
// should be able to do by knowing a URL.
//
// The routes are thin on purpose. They authenticate, validate their input, call
// provision.ts and translate the outcome. Everything worth reasoning about —
// ordering, adoption, what counts as published — lives in the orchestration,
// with tests that do not need a server.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { createHash } from "node:crypto";
import { AuthError, requireAdmin } from "../master/auth.js";
import { readJsonBody } from "../mcp/http.js";
import { logger } from "../logging/logger.js";
import { provisionSite, publishPage, type SiteConfig } from "../sites/provision.js";
import { supabaseSiteStore } from "../sites/store.js";
import { pagePath } from "../sites/paths.js";
import { missingConfig } from "./status.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A repository name that is safe in a URL and on a filesystem.
 *
 * GitHub is more permissive than this. We are not, because the name becomes
 * part of every published URL for the life of the site and is not something a
 * client can be asked to live with a typo in.
 */
export function repoNameProblem(name: string): string | null {
  if (!name) return "A repository name is required.";
  if (name.length > 80) return "That repository name is too long.";
  // The optional tail is what lets a one-character name through; the first
  // form of this required two and silently refused "a".
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number.";
  }
  if (name.includes("--")) return "Use single hyphens.";
  return null;
}

function siteConfig(config: RuntimeConfig): SiteConfig {
  return { org: config.githubSitesOrg, runtimeBase: config.publicRuntimeBase };
}

export async function handleSitesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
  action: "provision" | "publish" | "request-page-approval",
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    await requireAdmin(sb, req.headers.authorization);
  } catch (err) {
    json(err instanceof AuthError ? err.status : 401, { ok: false, error: "Not permitted." });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    json(400, { ok: false, error: "Expected a JSON body." });
    return;
  }

  const app = {
    appId: config.githubAppId as string,
    privateKey: config.githubAppPrivateKey as string,
    installationId: config.githubInstallationId,
  };
  const store = supabaseSiteStore(sb);

  try {
    if (action === "request-page-approval") {
      const pageId = String(body.pageId ?? "");
      if (!UUID.test(pageId)) {
        json(400, { ok: false, error: "A page is required." });
        return;
      }
      const page = await store.loadPage(pageId);
      if (!page || !page.html) throw new Error("A built page is required.");
      const repo = page.siteRepositoryId
        ? await store.repoById(page.siteRepositoryId)
        : await store.readyRepoForClient(page.clientId);
      if (!repo || repo.clientId !== page.clientId || repo.status !== "ready" || !repo.pagesUrl) {
        throw new Error("A ready site for this client is required before page approval.");
      }
      const path = page.sitePath ?? pagePath(page.title);
      if (!path) throw new Error("That page needs a safe destination path.");
      const key = "page-deploy:" + createHash("sha256")
        .update(JSON.stringify({ pageId, repoId: repo.id, path, html: page.html }))
        .digest("hex");
      const { data, error } = await sb.rpc("request_campaign_page_deploy_approval_v6", {
        p_page_id: pageId, p_idempotency_key: key,
        p_site_repository_id: repo.id, p_site_path: path,
      });
      if (error) throw new Error(error.message);
      json(200, { ok: true, approvalId: data.id, destination: data.destination,
        status: data.status });
      return;
    }

    const missing = missingConfig({
      appId: config.githubAppId ?? undefined,
      privateKey: config.githubAppPrivateKey ?? undefined,
    });
    if (missing.length > 0) {
      json(400, { ok: false, error: `The runtime has no GitHub credentials. Missing: ${missing.join(", ")}.` });
      return;
    }
    if (action === "provision") {
      const clientId = String(body.clientId ?? "");
      const repo = String(body.repo ?? "").trim().toLowerCase();
      if (!UUID.test(clientId)) {
        json(400, { ok: false, error: "A client is required." });
        return;
      }
      const problem = repoNameProblem(repo);
      if (problem) {
        json(400, { ok: false, error: problem });
        return;
      }

      const result = await provisionSite(store, app, siteConfig(config), { clientId, repo });
      json(200, {
        ok: true,
        created: result.created,
        owner: result.repo.owner,
        repo: result.repo.repo,
        pagesUrl: result.pagesUrl,
        status: result.repo.status,
      });
      return;
    }

    const pageId = String(body.pageId ?? "");
    if (!UUID.test(pageId)) {
      json(400, { ok: false, error: "A page is required." });
      return;
    }
    const result = await publishPage(store, app, siteConfig(config), pageId);
    json(200, { ok: true, url: result.url, commit: result.commit, changed: result.changed });
  } catch (err) {
    // These messages are written to be read by whoever pressed the button —
    // "no built HTML yet", "needs an Organization installation". They come from
    // our own code or from GitHubApiError's safe message, never from a GitHub
    // response body.
    const message = err instanceof Error ? err.message : "That did not work.";
    logger.error(`sites_${action}_failed`, { error: message });
    json(422, { ok: false, error: message });
  }
}
