import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { collectSystemReadiness } from "./collect.js";
import { deployedCommitSha } from "./version.js";

const SHA = "a".repeat(40);

function fixture() {
  const rows: Record<string, Record<string, unknown>[]> = {
    agent_runtime_status: [{
      worker_id: "agent-runtime:1", version: SHA, reported_at: "2026-10-29T12:00:00Z",
      // A stale view could still say live; the inventory checks age itself.
      is_live: true, metadata: { enabled: true }, queue_depth: 2, active_jobs: 0,
    }],
    clients: [{ id: "client-1", name: "Acme" }],
    client_engine_settings: [{
      client_id: "client-1", enabled: false, publishing_enabled: false,
      proof_publishing_enabled: false, campaign_actions_enabled: false,
      lead_magnet_delivery_enabled: false, outbound_messaging_enabled: false,
    }],
    client_engine_platforms: [],
    engine_controls: [{ id: true, enabled: false }],
    platform_publishing: [{ platform: "instagram", supported: true }],
    proof_destinations: [{ destination_key: "google_business_profile", mode: "api", supported: true }],
    campaign_action_executors: [
      { action_key: "campaign_launch", executor_module: "campaign_factory", supported: false },
      { action_key: "meta_ad_build", executor_module: "meta_ads_studio", supported: false },
      { action_key: "google_ad_build", executor_module: "google_ads_studio", supported: false },
      { action_key: "organic_publish", executor_module: "content_distribution", supported: false },
      { action_key: "proof_publish", executor_module: "proof_distribution", supported: true },
      { action_key: "page_deploy", executor_module: "website_studio", supported: true },
      { action_key: "lead_message", executor_module: "sales_os", supported: true },
      { action_key: "profile_update", executor_module: "google_profile", supported: false },
      { action_key: "budget_change", executor_module: "meta_ads_studio", supported: true },
    ],
    message_channels: [{ channel_key: "email", transport: "resend", supported: true, can_initiate: true }],
    client_proof_destinations: [{ client_id: "client-1", destination_key: "google_business_profile",
      enabled: false, account_ref: "possibly-private-account-ref" }],
    client_daily_package_settings: [],
    client_booking_settings: [{ client_id: "client-1", enabled: false }],
    lead_capture_endpoints: [{ id: "capture-1", client_id: "client-1", purpose: "page_form",
      enabled: false, expires_at: null, revoked_at: null, token_hash: "private-token-hash" }],
    client_sales_agent_deployments: [],
    client_integrations: [{
      client_id: "client-1", provider: "meta", status: "connected",
      credential_secret_id: "vault-secret-123", credential_label: "accidentally-a-secret",
      last_checked_at: null, token_expires_at: null,
      ad_account_id: "act_123", meta_page_id: "42", meta_pixel_id: null,
    }],
  };
  const sb = {
    from(table: string) {
      return {
        select() { return this; },
        order() { return this; },
        async range() { return { data: rows[table] ?? [], error: null }; },
      };
    },
    async rpc() {
      return { data: { migrationHead: "20261025233000", migrationCount: 259,
        objects: { tables: 10, views: 5, functions: 4, policies: 3 },
        cronJobs: [{ name: "engine-tick", schedule: "* * * * *", active: true }] }, error: null };
    },
  } as unknown as SupabaseClient;
  const config = {
    supabaseUrl: "https://project-abc.supabase.co", supabaseServiceRoleKey: "private-service-key",
    anthropicApiKey: "private-anthropic-key", openaiApiKey: "private-openai-key",
    githubAppPrivateKey: "private-github-key", githubAppId: "id", githubInstallationId: "installation",
    enabled: true, workflowEnabled: false, publishEnabled: false, proofPublishEnabled: false,
    campaignActionsEnabled: false, leadMagnetDeliveryEnabled: false, outboundMessagingEnabled: false,
    mcpServiceSecret: null, gatewayUrl: null, metaAppSecret: null, metaWebhookVerifyToken: null,
    resendApiKey: null,
  } as unknown as RuntimeConfig;
  return { sb, config, rows };
}

describe("B001 system inventory", () => {
  it("reports a full build identity only; a short or absent host value is unknown", () => {
    expect(deployedCommitSha({ RAILWAY_GIT_COMMIT_SHA: SHA })).toBe(SHA);
    expect(deployedCommitSha({ RAILWAY_GIT_COMMIT_SHA: SHA.slice(0, 12) })).toBeNull();
    expect(deployedCommitSha({})).toBeNull();
  });

  it("keeps a stale heartbeat distinct from a configured worker and redacts secrets", async () => {
    const { sb, config } = fixture();
    const snapshot = await collectSystemReadiness(sb, config, fetch, { RAILWAY_GIT_COMMIT_SHA: SHA });
    expect(snapshot.runtime.sha).toBe(SHA);
    expect(snapshot.runtime.heartbeats.value?.[0]).toMatchObject({ isLive: false, enabled: true, sha: SHA });
    expect(snapshot.runtime.credentialPresence).toMatchObject({ anthropic: true, openai: true });
    expect(snapshot.runtime.actionHolds.profileFieldPatch).toMatchObject({
      state: "held",
      reason: expect.stringMatching(/exact-version AAL2 Approval Inbox decision/),
    });
    expect(snapshot.runtime.actionHolds.genericCampaignActionClaim).toMatchObject({
      state: "held",
      reason: expect.stringMatching(/no atomic action-key and handler-ownership gate/),
    });
    expect(snapshot.gateway.state).toBe("unknown");
    expect(snapshot.global.value?.engineEnabled).toBe(false);
    expect(snapshot.global.value?.campaignActionExecutors).toContainEqual({
      key: "google_ad_build", module: "google_ads_studio", supported: false, handlerRegistered: false,
    });
    expect(snapshot.global.value?.campaignActionHandlerParity).toEqual({
      state: "aligned", unhandledSupportedKeys: [],
    });
    expect(snapshot.global.value?.messageChannels).toEqual([{
      key: "email", transport: "resend", supported: true, canInitiate: true,
    }]);
    expect(snapshot.clients.value?.[0]?.proofDestinations).toEqual([{
      key: "google_business_profile", enabled: false, hasAccountRef: true,
    }]);
    expect(snapshot.database.value?.migrationHead).toBe("20261025233000");
    expect(snapshot.clients.value?.[0]?.integrations[0]).toMatchObject({
      hasCredential: true, accountIds: { adAccountId: "act_123", metaPageId: "42" },
      providerHealth: { state: "unknown", evidenceAt: null },
    });
    expect(snapshot.clients.value?.[0]?.integrations[0]?.providerHealth.reason).toMatch(/exact account, required scopes/);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.evidenceCoverage.runtimeDeployment.state).toBe("observed");
    expect(snapshot.evidenceCoverage.runtimeWorkers.state).toBe("unknown");
    expect(snapshot.evidenceCoverage.cronCatalog.state).toBe("observed");
    expect(snapshot.evidenceCoverage.schemaParity.state).toBe("unknown");
    expect(snapshot.evidenceCoverage.cronExecution.state).toBe("unknown");
    expect(snapshot.evidenceCoverage.switchInventory.state).toBe("unknown");
    expect(snapshot.evidenceCoverage.credentialValidity.state).toBe("unknown");
    expect(snapshot.evidenceCoverage.providerAccountHealth.state).toBe("unknown");
    expect(snapshot.evidenceCoverage.otherEnvironment.state).toBe("unknown");
    expect(snapshot.evidenceCoverage.externalEffects.state).toBe("unknown");
    const exported = JSON.stringify(snapshot);
    for (const forbidden of ["private-service-key", "private-anthropic-key", "private-openai-key",
      "private-github-key", "vault-secret-123", "accidentally-a-secret",
      "possibly-private-account-ref", "private-token-hash"])
      expect(exported).not.toContain(forbidden);
  });

  it("names provider-specific gaps without treating metadata or a terminal status as live proof", async () => {
    const { sb, config, rows } = fixture();
    rows.client_integrations = [
      { client_id: "client-1", provider: "meta", status: "revoked", credential_secret_id: "secret-1" },
      { client_id: "client-1", provider: "google_business", status: "connected", credential_secret_id: "secret-2" },
      { client_id: "client-1", provider: "google_ads", status: "connected", credential_secret_id: "secret-3" },
      { client_id: "client-1", provider: "resend", status: "connected", credential_secret_id: "secret-4" },
      { client_id: "client-1", provider: "instagram", status: "active", credential_secret_id: null },
      { client_id: "client-1", provider: "meta", status: "expiring", credential_secret_id: "secret-5",
        token_expires_at: null },
    ];
    const snapshot = await collectSystemReadiness(sb, config, fetch, {});
    const integrations = snapshot.clients.value?.[0]?.integrations ?? [];
    expect(integrations.map((row) => row.providerHealth.state)).toEqual(
      ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"],
    );
    expect(integrations.map((row) => row.providerHealth.reason)).toEqual([
      expect.stringMatching(/status blocks use/),
      expect.stringMatching(/Business Profile location readback/),
      expect.stringMatching(/developer token, exact customer access/),
      expect.stringMatching(/runtime email key/),
      expect.stringMatching(/No credential is configured/),
      expect.stringMatching(/lacks a known future expiry/),
    ]);
    const exported = JSON.stringify(snapshot);
    for (const secret of ["secret-1", "secret-2", "secret-3", "secret-4", "secret-5"])
      expect(exported).not.toContain(secret);
  });

  it("reports Meta and profile SQL support as blocked by missing runtime handlers", async () => {
    const { sb, config, rows } = fixture();
    rows.campaign_action_executors = rows.campaign_action_executors!.map((row) => ({
      ...row,
      supported: ["meta_ad_build", "profile_update"].includes(String(row.action_key)) ? true : row.supported,
    }));
    const snapshot = await collectSystemReadiness(sb, config, fetch, {});
    expect(snapshot.global.value?.campaignActionHandlerParity).toEqual({
      state: "blocked", unhandledSupportedKeys: ["meta_ad_build", "profile_update"],
    });
    expect(snapshot.global.value?.campaignActionExecutors).toContainEqual({
      key: "google_ad_build", module: "google_ads_studio", supported: false, handlerRegistered: false,
    });
    rows.campaign_action_executors = [{ action_key: "proof_publish", supported: null }];
    const malformed = await collectSystemReadiness(sb, config, fetch, {});
    expect(malformed.global.state).toBe("error");
  });

  it("does not turn a gateway timeout or missing catalog into a healthy assertion", async () => {
    const { sb, config } = fixture();
    config.gatewayUrl = "https://gateway.example";
    config.mcpServiceSecret = "secret";
    const brokenDb = { ...sb, rpc: async () => ({ data: null, error: new Error("down") }) } as unknown as SupabaseClient;
    const snapshot = await collectSystemReadiness(brokenDb, config,
      async () => { throw new Error("network unreachable"); }, {});
    expect(snapshot.gateway.state).toBe("error");
    expect(snapshot.database.state).toBe("error");
    expect(snapshot.runtime.sha).toBeNull();
    expect(snapshot.evidenceCoverage.gatewayDeployment.state).toBe("error");
    expect(snapshot.evidenceCoverage.schemaCatalog.state).toBe("error");
    expect(snapshot.evidenceCoverage.cronCatalog.state).toBe("error");
  });

  it("requires every fresh enabled worker to report the runtime commit before recording fleet evidence", async () => {
    const { sb, config, rows } = fixture();
    const reportedAt = new Date().toISOString();
    rows.agent_runtime_status = [
      { worker_id: "runtime-a", version: SHA, reported_at: reportedAt, is_live: true,
        metadata: { enabled: true }, queue_depth: 0, active_jobs: 0 },
      { worker_id: "runtime-b", version: "b".repeat(40), reported_at: reportedAt, is_live: true,
        metadata: { enabled: true }, queue_depth: 0, active_jobs: 0 },
    ];
    const mismatch = await collectSystemReadiness(sb, config, fetch, { RAILWAY_GIT_COMMIT_SHA: SHA });
    expect(mismatch.evidenceCoverage.runtimeWorkers.state).toBe("unknown");
    rows.agent_runtime_status[1]!.version = SHA;
    const matching = await collectSystemReadiness(sb, config, fetch, { RAILWAY_GIT_COMMIT_SHA: SHA });
    expect(matching.evidenceCoverage.runtimeWorkers).toMatchObject({
      state: "observed", evidenceAt: reportedAt, reason: null,
    });
  });

  it("does not turn a successful gateway HTTP response with a short SHA into deployment evidence", async () => {
    const { sb, config } = fixture();
    config.gatewayUrl = "https://gateway.example";
    config.mcpServiceSecret = "private-secret";
    const snapshot = await collectSystemReadiness(sb, config,
      async () => new Response(JSON.stringify({ ok: true, sha: "abc123", observedAt: new Date().toISOString(),
        configured: { aaInternalApi: true, botAuthMode: "grants" } }), { status: 200 }),
      { RAILWAY_GIT_COMMIT_SHA: SHA });
    expect(snapshot.gateway.state).toBe("observed");
    expect(snapshot.gateway.value?.sha).toBeNull();
    expect(snapshot.evidenceCoverage.gatewayDeployment.state).toBe("unknown");
    expect(JSON.stringify(snapshot)).not.toContain("private-secret");
  });
});
