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
    campaign_action_executors: [{ action_key: "google_ad_build", executor_module: "google_ads_studio", supported: false }],
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
  return { sb, config };
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
    expect(snapshot.gateway.state).toBe("unknown");
    expect(snapshot.global.value?.engineEnabled).toBe(false);
    expect(snapshot.global.value?.campaignActionExecutors).toEqual([{
      key: "google_ad_build", module: "google_ads_studio", supported: false,
    }]);
    expect(snapshot.global.value?.messageChannels).toEqual([{
      key: "email", transport: "resend", supported: true, canInitiate: true,
    }]);
    expect(snapshot.clients.value?.[0]?.proofDestinations).toEqual([{
      key: "google_business_profile", enabled: false, hasAccountRef: true,
    }]);
    expect(snapshot.database.value?.migrationHead).toBe("20261025233000");
    expect(snapshot.clients.value?.[0]?.integrations[0]).toMatchObject({
      hasCredential: true, accountIds: { adAccountId: "act_123", metaPageId: "42" },
    });
    const exported = JSON.stringify(snapshot);
    for (const forbidden of ["private-service-key", "private-anthropic-key", "private-openai-key",
      "private-github-key", "vault-secret-123", "accidentally-a-secret",
      "possibly-private-account-ref", "private-token-hash"])
      expect(exported).not.toContain(forbidden);
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
  });
});
