import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { deployedCommitSha } from "./version.js";

type Observation<T> = {
  state: "observed" | "unknown" | "error";
  checkedAt: string;
  value: T | null;
  reason: string | null;
};

type EvidenceCheck = {
  state: "observed" | "unknown" | "error";
  checkedAt: string;
  evidenceAt: string | null;
  source: string;
  reason: string | null;
};

type Catalog = {
  migrationHead: string | null;
  migrationCount: number | null;
  objects: Record<"tables" | "views" | "functions" | "policies", number>;
  cronJobs: { name: string; schedule: string; active: boolean }[] | null;
};

type Heartbeat = {
  workerId: string;
  sha: string | null;
  reportedVersion: string | null;
  reportedAt: string;
  isLive: boolean;
  enabled: boolean | null;
  queueDepth: number | null;
  activeJobs: number | null;
};

type ClientInventory = {
  id: string;
  name: string;
  switches: Record<string, boolean | null>;
  platforms: { platform: string; active: boolean }[];
  leadCaptureEndpoints: { id: string; purpose: string; enabled: boolean; expiresAt: string | null; revoked: boolean }[];
  proofDestinations: { key: string; enabled: boolean; hasAccountRef: boolean }[];
  salesAgentDeployments: { id: string; pageId: string | null; enabled: boolean }[];
  integrations: {
    provider: string;
    status: string;
    ingestEnabled: boolean;
    hasCredential: boolean;
    lastCheckedAt: string | null;
    tokenExpiresAt: string | null;
    accountIds: { adAccountId: string | null; metaPageId: string | null; metaPixelId: string | null };
    providerHealth: EvidenceCheck;
  }[];
};

export type SystemReadinessSnapshot = {
  schemaVersion: 2;
  capturedAt: string;
  environment: {
    name: string | null;
    railwayEnvironmentId: string | null;
    supabaseProjectRef: string | null;
  };
  runtime: {
    sha: string | null;
    switches: Record<string, boolean>;
    credentialPresence: Record<string, boolean>;
    heartbeats: Observation<Heartbeat[]>;
  };
  gateway: Observation<{
    sha: string | null;
    observedAt: string;
    configured: { aaInternalApi: boolean; botAuthMode: string };
  }>;
  database: Observation<Catalog>;
  global: Observation<{
    engineEnabled: boolean | null;
    publishingPlatforms: { platform: string; supported: boolean }[];
    proofDestinations: { key: string; mode: string; supported: boolean }[];
    campaignActionExecutors: { key: string; module: string; supported: boolean }[];
    messageChannels: { key: string; transport: string; supported: boolean; canInitiate: boolean }[];
  }>;
  clients: Observation<ClientInventory[]>;
  evidenceCoverage: Record<
    "runtimeDeployment" | "runtimeWorkers" | "gatewayDeployment" | "schemaCatalog" |
    "schemaParity" | "cronCatalog" | "cronExecution" | "switchInventory" |
    "credentialValidity" | "providerAccountHealth" | "otherEnvironment" | "externalEffects",
    EvidenceCheck
  >;
};

function evidenceCheck(
  state: EvidenceCheck["state"], checkedAt: string, source: string,
  reason: string | null, evidenceAt: string | null = null,
): EvidenceCheck {
  return { state, checkedAt, evidenceAt, source, reason };
}

function observed<T>(value: T): Observation<T> {
  return { state: "observed", checkedAt: new Date().toISOString(), value, reason: null };
}

function unknown<T>(reason: string): Observation<T> {
  return { state: "unknown", checkedAt: new Date().toISOString(), value: null, reason };
}

function failed<T>(reason: string): Observation<T> {
  return { state: "error", checkedAt: new Date().toISOString(), value: null, reason };
}

function safeSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function projectRef(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] ?? null : null;
  } catch { return null; }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function freshHeartbeat(reportedAt: string | null, databaseSaysLive: unknown, now: number): boolean {
  if (!reportedAt || databaseSaysLive !== true) return false;
  const ageMs = now - Date.parse(reportedAt);
  return Number.isFinite(ageMs) && ageMs >= -5000 && ageMs < 90_000;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

const ORDER_COLUMNS: Record<string, string[]> = {
  agent_runtime_status: ["worker_id"],
  clients: ["id"],
  client_engine_settings: ["client_id"],
  client_engine_platforms: ["client_id", "platform"],
  client_integrations: ["client_id", "provider", "id"],
  engine_controls: ["id"],
  platform_publishing: ["platform"],
  proof_destinations: ["destination_key"],
  campaign_action_executors: ["action_key"],
  message_channels: ["channel_key"],
  client_daily_package_settings: ["client_id"],
  client_booking_settings: ["client_id"],
  lead_capture_endpoints: ["client_id", "id"],
  client_proof_destinations: ["client_id", "destination_key"],
  client_sales_agent_deployments: ["client_id", "id"],
};

async function allRows(sb: SupabaseClient, table: string, fields: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = sb.from(table).select(fields);
    for (const column of ORDER_COLUMNS[table] ?? []) query = query.order(column);
    const { data, error } = await query.range(offset, offset + 499);
    if (error) throw new Error(`${table} unavailable`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < 500) return rows;
    if (offset >= 100_000) throw new Error(`${table} exceeds inventory limit`);
  }
}

async function catalog(sb: SupabaseClient): Promise<Observation<Catalog>> {
  try {
    const { data, error } = await sb.rpc("system_readiness_catalog");
    if (error) throw new Error("catalog RPC unavailable");
    const raw = record(data);
    const objects = record(raw.objects);
    const counts = {
      tables: asNumber(objects.tables), views: asNumber(objects.views),
      functions: asNumber(objects.functions), policies: asNumber(objects.policies),
    };
    if (Object.values(counts).some((x) => x === null)) throw new Error("catalog response invalid");
    const cron = raw.cronJobs === null ? null : Array.isArray(raw.cronJobs)
      ? raw.cronJobs.map((item) => {
        const job = record(item);
        if (!asString(job.name) || !asString(job.schedule) || asBool(job.active) === null)
          throw new Error("catalog cron response invalid");
        return { name: job.name as string, schedule: job.schedule as string, active: job.active as boolean };
      }) : null;
    return observed({
      migrationHead: asString(raw.migrationHead),
      migrationCount: asNumber(raw.migrationCount),
      objects: counts as Catalog["objects"],
      cronJobs: cron,
    });
  } catch {
    return failed("Schema catalog could not be read; migration and cron state are unverified.");
  }
}

async function heartbeats(sb: SupabaseClient): Promise<Observation<Heartbeat[]>> {
  try {
    const rows = await allRows(sb, "agent_runtime_status",
      "worker_id,version,reported_at,is_live,metadata,queue_depth,active_jobs");
    if (rows.length === 0) return unknown("No runtime heartbeat has been recorded.");
    const now = Date.now();
    return observed(rows.map((row) => ({
      workerId: asString(row.worker_id) ?? "unknown",
      sha: safeSha(row.version),
      reportedVersion: asString(row.version),
      reportedAt: asString(row.reported_at) ?? "",
      isLive: freshHeartbeat(asString(row.reported_at), row.is_live, now),
      enabled: asBool(record(row.metadata).enabled),
      queueDepth: asNumber(row.queue_depth),
      activeJobs: asNumber(row.active_jobs),
    })).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt)));
  } catch {
    return failed("Runtime heartbeats could not be read.");
  }
}

async function globalConfiguration(sb: SupabaseClient): Promise<SystemReadinessSnapshot["global"]> {
  try {
    const [controls, publishing, proof, actions, channels] = await Promise.all([
      allRows(sb, "engine_controls", "id,enabled"),
      allRows(sb, "platform_publishing", "platform,supported"),
      allRows(sb, "proof_destinations", "destination_key,mode,supported"),
      allRows(sb, "campaign_action_executors", "action_key,executor_module,supported"),
      allRows(sb, "message_channels", "channel_key,transport,supported,can_initiate"),
    ]);
    return observed({
      engineEnabled: asBool(controls[0]?.enabled),
      publishingPlatforms: publishing.map((row) => ({
        platform: asString(row.platform) ?? "unknown", supported: row.supported === true,
      })),
      proofDestinations: proof.map((row) => ({
        key: asString(row.destination_key) ?? "unknown",
        mode: asString(row.mode) ?? "unknown", supported: row.supported === true,
      })),
      campaignActionExecutors: actions.map((row) => ({
        key: asString(row.action_key) ?? "unknown",
        module: asString(row.executor_module) ?? "unknown",
        supported: row.supported === true,
      })),
      messageChannels: channels.map((row) => ({
        key: asString(row.channel_key) ?? "unknown",
        transport: asString(row.transport) ?? "unknown",
        supported: row.supported === true,
        canInitiate: row.can_initiate === true,
      })),
    });
  } catch {
    return failed("Global engine, destination, action, or message capabilities could not be read.");
  }
}

async function clients(sb: SupabaseClient): Promise<Observation<ClientInventory[]>> {
  try {
    const [clientRows, settings, platforms, integrations, packages, bookings, captures,
      proofDestinations, salesAgents] = await Promise.all([
      allRows(sb, "clients", "id,name"),
      allRows(sb, "client_engine_settings",
        "client_id,enabled,publishing_enabled,proof_publishing_enabled,campaign_actions_enabled,lead_magnet_delivery_enabled,outbound_messaging_enabled"),
      allRows(sb, "client_engine_platforms", "client_id,platform,active"),
      allRows(sb, "client_integrations",
        "client_id,provider,status,ingest_enabled,credential_secret_id,last_checked_at,token_expires_at,ad_account_id,meta_page_id,meta_pixel_id"),
      allRows(sb, "client_daily_package_settings", "client_id,enabled"),
      allRows(sb, "client_booking_settings", "client_id,enabled"),
      allRows(sb, "lead_capture_endpoints", "id,client_id,purpose,enabled,expires_at,revoked_at"),
      allRows(sb, "client_proof_destinations", "client_id,destination_key,enabled,account_ref"),
      allRows(sb, "client_sales_agent_deployments", "id,client_id,page_id,enabled"),
    ]);
    const byClient = new Map(settings.map((row) => [row.client_id, row]));
    const byPackage = new Map(packages.map((row) => [row.client_id, row]));
    const byBooking = new Map(bookings.map((row) => [row.client_id, row]));
    return observed(clientRows.map((client) => {
      const id = asString(client.id) ?? "unknown";
      const flags = record(byClient.get(id));
      return {
        id,
        name: asString(client.name) ?? "Unnamed client",
        switches: {
          engine: asBool(flags.enabled),
          publishing: asBool(flags.publishing_enabled),
          proofPublishing: asBool(flags.proof_publishing_enabled),
          campaignActions: asBool(flags.campaign_actions_enabled),
          leadMagnetDelivery: asBool(flags.lead_magnet_delivery_enabled),
          outboundMessaging: asBool(flags.outbound_messaging_enabled),
          dailyPackage: asBool(record(byPackage.get(id)).enabled),
          booking: asBool(record(byBooking.get(id)).enabled),
        },
        platforms: platforms.filter((row) => row.client_id === id).map((row) => ({
          platform: asString(row.platform) ?? "unknown", active: row.active === true,
        })),
        leadCaptureEndpoints: captures.filter((row) => row.client_id === id).map((row) => ({
          id: asString(row.id) ?? "unknown", purpose: asString(row.purpose) ?? "unknown",
          enabled: row.enabled === true, expiresAt: asString(row.expires_at),
          revoked: typeof row.revoked_at === "string",
        })),
        proofDestinations: proofDestinations.filter((row) => row.client_id === id).map((row) => ({
          key: asString(row.destination_key) ?? "unknown", enabled: row.enabled === true,
          hasAccountRef: typeof row.account_ref === "string" && row.account_ref.length > 0,
        })),
        salesAgentDeployments: salesAgents.filter((row) => row.client_id === id).map((row) => ({
          id: asString(row.id) ?? "unknown", pageId: asString(row.page_id), enabled: row.enabled === true,
        })),
        integrations: integrations.filter((row) => row.client_id === id).map((row) => ({
          provider: asString(row.provider) ?? "unknown",
          status: asString(row.status) ?? "unknown",
          ingestEnabled: row.ingest_enabled === true,
          hasCredential: typeof row.credential_secret_id === "string",
          lastCheckedAt: asString(row.last_checked_at),
          tokenExpiresAt: asString(row.token_expires_at),
          accountIds: {
            adAccountId: asString(row.ad_account_id),
            metaPageId: asString(row.meta_page_id),
            metaPixelId: asString(row.meta_pixel_id),
          },
          providerHealth: evidenceCheck(
            "unknown", new Date().toISOString(), "client_integrations metadata",
            "No live provider account probe or credential validation was performed by this inventory.",
            null,
          ),
        })),
      };
    }));
  } catch {
    return failed("Client switches or integration metadata could not be read.");
  }
}

function evidenceCoverage(snapshot: Omit<SystemReadinessSnapshot, "evidenceCoverage">): SystemReadinessSnapshot["evidenceCoverage"] {
  const at = snapshot.capturedAt;
  const sha = snapshot.runtime.sha;
  const beats = snapshot.runtime.heartbeats;
  const liveWorkers = beats.state === "observed" ? beats.value?.filter((beat) => beat.isLive) ?? [] : [];
  const fleetMatches = sha !== null && liveWorkers.length > 0 &&
    liveWorkers.every((beat) => beat.enabled === true && beat.sha === sha);
  const gatewaySha = snapshot.gateway.value?.sha;
  const database = snapshot.database;
  const switchSourcesObserved = snapshot.global.state === "observed" &&
    typeof snapshot.global.value?.engineEnabled === "boolean" &&
    snapshot.clients.state === "observed" &&
    snapshot.clients.value?.every((client) => Object.values(client.switches).every(
      (value) => typeof value === "boolean",
    )) === true;
  return {
    runtimeDeployment: evidenceCheck(
      sha ? "observed" : "unknown", at, "RAILWAY_GIT_COMMIT_SHA",
      sha ? null : "The runtime did not report a full 40-character deployed commit.",
    ),
    runtimeWorkers: evidenceCheck(
      beats.state === "error" ? "error" : fleetMatches ? "observed" : "unknown",
      beats.checkedAt, "agent_runtime_status latest heartbeat per worker",
      fleetMatches ? null : beats.reason ?? "No complete set of fresh, enabled workers matches the runtime's full deployed commit.",
      fleetMatches ? liveWorkers.map((beat) => beat.reportedAt).sort().at(-1) ?? null : null,
    ),
    gatewayDeployment: evidenceCheck(
      snapshot.gateway.state === "error" ? "error" : gatewaySha ? "observed" : "unknown",
      snapshot.gateway.checkedAt, "authenticated gateway internal readiness probe",
      gatewaySha ? null : snapshot.gateway.reason ?? "The gateway did not report a full 40-character deployed commit.",
      gatewaySha ? snapshot.gateway.value?.observedAt ?? null : null,
    ),
    schemaCatalog: evidenceCheck(
      database.state === "error" ? "error" : database.value?.migrationHead && database.value.migrationCount !== null ? "observed" : "unknown",
      database.checkedAt, "system_readiness_catalog RPC",
      database.value?.migrationHead && database.value.migrationCount !== null ? null :
      database.reason ?? "The database migration head or count is unavailable.",
    ),
    schemaParity: evidenceCheck("unknown", at, "B002 independent schema parity check",
      "Catalog object counts do not verify object definitions or migration parity."),
    cronCatalog: evidenceCheck(
      database.state === "error" ? "error" : Array.isArray(database.value?.cronJobs) ? "observed" : "unknown",
      database.checkedAt, "system_readiness_catalog RPC cron metadata",
      Array.isArray(database.value?.cronJobs) ? null : database.reason ?? "The cron catalog is unavailable.",
    ),
    cronExecution: evidenceCheck("unknown", at, "cron execution receipts",
      "A scheduled cron entry does not prove a recent successful run."),
    switchInventory: evidenceCheck(
      snapshot.global.state === "error" || snapshot.clients.state === "error" ? "error" : switchSourcesObserved ? "observed" : "unknown",
      at, "runtime configuration and global/client database switches",
      switchSourcesObserved ? null : "Global or client switch inventory could not be completely read.",
    ),
    credentialValidity: evidenceCheck("unknown", at, "credential presence flags",
      "A configured credential may be expired, revoked, scoped incorrectly, or inaccessible to its provider."),
    providerAccountHealth: evidenceCheck("unknown", at, "client_integrations metadata",
      "Connected account identifiers and stored status are not live provider account checks."),
    otherEnvironment: evidenceCheck("unknown", at, "separate authenticated environment inventory",
      "This snapshot covers only the environment serving the request; capture the other environment separately."),
    externalEffects: evidenceCheck("unknown", at, "provider receipts and read-back",
      "This read-only inventory does not verify published content, sent messages, spend, leads, or bookings."),
  };
}

async function gateway(config: RuntimeConfig, fetcher: typeof fetch): Promise<SystemReadinessSnapshot["gateway"]> {
  if (!config.gatewayUrl || !config.mcpServiceSecret)
    return unknown("Gateway URL or service credential is not configured for a probe.");
  try {
    const res = await fetcher(`${config.gatewayUrl}/internal/readiness`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.mcpServiceSecret}` },
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error("gateway refused probe");
    const body = record(await res.json());
    const configured = record(body.configured);
    if (body.ok !== true || typeof body.observedAt !== "string" ||
        typeof configured.aaInternalApi !== "boolean" || typeof configured.botAuthMode !== "string")
      throw new Error("gateway response invalid");
    return observed({
      sha: safeSha(body.sha),
      observedAt: body.observedAt,
      configured: { aaInternalApi: configured.aaInternalApi, botAuthMode: configured.botAuthMode },
    });
  } catch {
    return failed("Gateway readiness probe failed; its deployment is unverified.");
  }
}

export async function collectSystemReadiness(
  sb: SupabaseClient,
  config: RuntimeConfig,
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SystemReadinessSnapshot> {
  const capturedAt = new Date().toISOString();
  const [heartbeatResult, catalogResult, globalResult, clientResult, gatewayResult] = await Promise.all([
    heartbeats(sb), catalog(sb), globalConfiguration(sb), clients(sb), gateway(config, fetcher),
  ]);
  const snapshot: Omit<SystemReadinessSnapshot, "evidenceCoverage"> = {
    schemaVersion: 2,
    capturedAt,
    environment: {
      name: env.RAILWAY_ENVIRONMENT_NAME ?? env.AA_ENVIRONMENT ?? null,
      railwayEnvironmentId: env.RAILWAY_ENVIRONMENT_ID ?? null,
      supabaseProjectRef: projectRef(config.supabaseUrl),
    },
    runtime: {
      sha: deployedCommitSha(env),
      switches: {
        workers: config.enabled,
        workflow: config.workflowEnabled,
        publishing: config.publishEnabled,
        proofPublishing: config.proofPublishEnabled,
        campaignActions: config.campaignActionsEnabled,
        leadMagnetDelivery: config.leadMagnetDeliveryEnabled,
        outboundMessaging: config.outboundMessagingEnabled,
      },
      credentialPresence: {
        supabaseServiceRole: Boolean(config.supabaseServiceRoleKey),
        anthropic: Boolean(config.anthropicApiKey),
        openai: Boolean(config.openaiApiKey),
        githubApp: Boolean(config.githubAppId && config.githubAppPrivateKey && config.githubInstallationId),
        mcpService: Boolean(config.mcpServiceSecret),
        metaWebhook: Boolean(config.metaAppSecret && config.metaWebhookVerifyToken),
        resend: Boolean(config.resendApiKey),
      },
      heartbeats: heartbeatResult,
    },
    gateway: gatewayResult,
    database: catalogResult,
    global: globalResult,
    clients: clientResult,
  };
  return { ...snapshot, evidenceCoverage: evidenceCoverage(snapshot) };
}
