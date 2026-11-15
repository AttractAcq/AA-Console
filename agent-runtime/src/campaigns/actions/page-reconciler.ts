import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import { mintInstallationToken, resolveInstallation } from "../../github/app-auth.js";
import { readRepoFile } from "../../github/repos.js";

interface Target {
  execution_id: string;
  client_id: string;
  repository_owner: string;
  repository_name: string;
  site_path: string;
  checked_ref: string;
  expected_sha256: string;
  expected_kind: "reviewed_html" | "published_bytes";
}

function validTarget(value: unknown): value is Target {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["execution_id", "client_id", "repository_owner", "repository_name",
    "site_path", "checked_ref", "expected_sha256"]
    .every((key) => typeof row[key] === "string" && String(row[key]).length > 0)
    && /^[0-9a-f]{64}$/.test(String(row.expected_sha256))
    && (row.expected_kind === "reviewed_html" || row.expected_kind === "published_bytes");
}

/** Inspect the frozen GitHub path/ref; never repeats the uncertain publish. */
export async function reconcileUncertainPage(
  sb: SupabaseClient, config: RuntimeConfig, executionId: string, clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "held" | "matches_expected" | "different" | "missing";
  reason?: string }> {
  const { data, error } = await sb.rpc("campaign_page_readback_target_v6", {
    p_execution_id: executionId, p_client_id: clientId,
  } as never);
  if (error) throw new Error("Could not load the uncertain page action.");
  if (!validTarget(data) || data.execution_id !== executionId || data.client_id !== clientId) {
    return { status: "held", reason: "No current uncertain page target belongs to this client." };
  }
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    return { status: "held", reason: "The GitHub App is not configured for readback." };
  }
  const app = { appId: config.githubAppId, privateKey: config.githubAppPrivateKey,
    installationId: config.githubInstallationId };
  const installation = await resolveInstallation(app, fetchImpl);
  if (installation.account.toLowerCase() !== data.repository_owner.toLowerCase()) {
    return { status: "held", reason: "The GitHub App installation belongs to a different repository owner." };
  }
  const token = (await mintInstallationToken(app, installation.installationId, fetchImpl)).token;
  const observed = await readRepoFile(token, data.repository_owner, data.repository_name,
    data.site_path, data.checked_ref, fetchImpl);
  const { data: recorded, error: recordError } = await sb.rpc("record_campaign_page_readback_v6", {
    p_execution_id: executionId, p_client_id: clientId,
    p_repository_owner: data.repository_owner,
    p_repository_name: data.repository_name,
    p_site_path: data.site_path,
    p_checked_ref: data.checked_ref,
    p_observed_sha256: observed?.sha256 ?? null,
  } as never);
  if (recordError || !["matches_expected", "different", "missing"].includes(String(recorded))) {
    throw new Error("The read-only GitHub page observation could not be recorded.");
  }
  return { status: recorded as "matches_expected" | "different" | "missing" };
}
