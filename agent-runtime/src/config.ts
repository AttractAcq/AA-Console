// Environment configuration. Fails closed: a missing required variable
// throws at startup rather than surfacing as undefined behaviour later.
// Never logs a secret value, only whether one is present.

export interface RuntimeConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  anthropicApiKey: string;
  /** Per-agent override, e.g. ANTHROPIC_API_KEY_COMPETITOR. Falls back to the shared key. */
  anthropicApiKeyByAgent: Record<string, string>;
  model: string;
  enabled: boolean;
  concurrency: number;
  leaseSeconds: number;
  emptyQueueBackoffMs: number;
  /** Per-request timeout for a model call. Without one, a stalled stream hangs forever. */
  providerTimeoutMs: number;
  /** How long a job may hold its lease before renewal stops and it becomes reclaimable. */
  maxJobSeconds: number;
  healthPort: number;
  /** Required in an X-Runtime-Secret header on /status when set. */
  sharedSecret: string | null;
  /** Dedicated MCP gateway credential. Missing disables the MCP endpoint. */
  mcpServiceSecret?: string | null;
  /** Ceiling on Master AI spend across every conversation in one UTC day. */
  masterAiDailyLimitUsd: number;
  /** Ceiling on Master AI spend within a single conversation, all time. */
  masterAiConversationLimitUsd: number;
  /** Origins allowed to call /master/chat from a browser. */
  allowedOrigins: string[];

  /** Image rendering. Absent means the AI build route reports itself unavailable. */
  openaiApiKey: string | null;
  imageModel: string;
  /** Which provider writes the creative concept. */
  conceptProvider: "openai" | "anthropic";
  conceptModel: string;
  /** Transactional email. Absent means a brief is still assigned, just not emailed. */
  resendApiKey: string | null;
  resendFrom: string;
  /** Where an emailed brief links back to. */
  consoleUrl: string;
}

// The one origin this system is served from. Both the CORS allow-list and
// the links in outbound email fall back to it, so a deployment that sets
// neither still points at the real console rather than at a developer's
// laptop. Override either with its own variable for a different environment.
const CONSOLE_ORIGIN = "https://console.attractacq.com";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

// Money, so not intEnv. Zero is allowed and means "stop the Master AI
// entirely" — a deliberate off switch, not a misconfiguration, which is why
// this rejects only negatives and nonsense.
function moneyEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number of dollars, got: ${raw}`);
  }
  return parsed;
}

// Deliberately a literal list rather than a query against the agents table:
// a misconfigured registry row must never change which environment
// variables this process is willing to read at startup.
const AGENT_KEY_ENV_SUFFIX: Record<string, string> = {
  icp: "ICP",
  competitor: "COMPETITOR",
  association: "ASSOCIATION",
  market: "MARKET",
  campaign_intel: "CAMPAIGN_INTEL",
  brand_strategy: "BRAND_STRATEGY",
  offer_strategy: "OFFER_STRATEGY",
  money_model: "MONEY_MODEL",
  ideation: "IDEATION",
  brief: "BRIEF",
  landing_page: "LANDING_PAGE",
};

function serverPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined) return 8787;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return Number(raw);
}

export function loadConfig(): RuntimeConfig {
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  const anthropicApiKeyByAgent: Record<string, string> = {};
  for (const [agentKey, suffix] of Object.entries(AGENT_KEY_ENV_SUFFIX)) {
    const override = optionalEnv(`ANTHROPIC_API_KEY_${suffix}`);
    if (override) anthropicApiKeyByAgent[agentKey] = override;
  }

  const leaseSeconds = intEnv("AGENT_RUNTIME_LEASE_SECONDS", 900);
  if (leaseSeconds < 30 || leaseSeconds > 3600) {
    // claim_agent_job rejects anything outside this range, so fail here
    // rather than on every claim attempt.
    throw new Error(`AGENT_RUNTIME_LEASE_SECONDS must be between 30 and 3600, got: ${leaseSeconds}`);
  }

  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    anthropicApiKey,
    anthropicApiKeyByAgent,
    model: optionalEnv("AGENT_RUNTIME_MODEL") ?? "claude-opus-5",
    enabled: (optionalEnv("AGENT_RUNTIME_ENABLED") ?? "true").toLowerCase() === "true",
    concurrency: intEnv("AGENT_RUNTIME_CONCURRENCY", 2),
    leaseSeconds,
    emptyQueueBackoffMs: intEnv("AGENT_RUNTIME_EMPTY_QUEUE_BACKOFF_MS", 5000),
    // Generous against the slowest legitimate run — a web-search agent can
    // take minutes — but finite, which is the whole point.
    providerTimeoutMs: intEnv("AGENT_RUNTIME_PROVIDER_TIMEOUT_MS", 600_000),
    maxJobSeconds: intEnv("AGENT_RUNTIME_MAX_JOB_SECONDS", 1800),
    healthPort: serverPort(),
    sharedSecret: optionalEnv("AGENT_RUNTIME_SHARED_SECRET") ?? null,
    mcpServiceSecret: optionalEnv("AA_MCP_SERVICE_SECRET") ?? null,
    // Calibrated against real use rather than guessed: 13 turns had cost
    // $1.15 in total, the dearest single turn $0.16, and the busiest day
    // $1.10. These sit far above that, so they never interrupt ordinary
    // work — they exist to stop a runaway, not to budget.
    masterAiDailyLimitUsd: moneyEnv("MASTER_AI_DAILY_LIMIT_USD", 20),
    masterAiConversationLimitUsd: moneyEnv("MASTER_AI_CONVERSATION_LIMIT_USD", 5),
    // The Master AI is called from the browser, so the origin list is a
    // real control rather than a formality.
    //
    // This used to default to http://localhost:5173, on the reasoning that a
    // deployment which forgot to set it should be unreachable from a hosted
    // front end. That was right while no hosted front end existed. Now there
    // is exactly one, and defaulting to localhost means the failure mode is
    // a console that silently cannot talk to its own runtime — while still
    // trusting an origin nobody serves from any more.
    allowedOrigins: (optionalEnv("MASTER_AI_ALLOWED_ORIGINS") ?? CONSOLE_ORIGIN)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),

    // Both providers are optional at startup. A missing key is a feature
    // that reports itself unavailable, not a process that refuses to boot —
    // the rest of the runtime has no business failing because nobody has
    // connected an image renderer yet.
    openaiApiKey: optionalEnv("OPENAI_API_KEY") ?? null,
    // Not pinned in code: the correct id is a provider fact that changes
    // faster than this repo does, so a wrong one is a config edit.
    imageModel: optionalEnv("OPENAI_IMAGE_MODEL") ?? "gpt-image-2",
    // Explicit rather than inferred from the model name: reading the
    // provider out of a string is the kind of cleverness that breaks
    // silently the first time a model is named differently.
    conceptProvider:
      (optionalEnv("CREATIVE_CONCEPT_PROVIDER") ?? "openai").toLowerCase() === "anthropic"
        ? "anthropic"
        : "openai",
    conceptModel: optionalEnv("CREATIVE_CONCEPT_MODEL") ?? "gpt-5.6-sol",
    resendApiKey: optionalEnv("RESEND_API_KEY") ?? null,
    resendFrom: optionalEnv("RESEND_FROM") ?? "AA Console <briefs@attractacq.com>",
    // A brief email reaches a real person. An unset CONSOLE_URL used to put
    // http://localhost:5173 in front of them, which is a dead link on every
    // machine but the one that sent it.
    consoleUrl: (optionalEnv("CONSOLE_URL") ?? CONSOLE_ORIGIN).replace(/\/+$/, ""),
  };
}

/** Never pass the result of this to a log line or an HTTP response. */
export function anthropicKeyForAgent(config: RuntimeConfig, agentKey: string): string {
  return config.anthropicApiKeyByAgent[agentKey] ?? config.anthropicApiKey;
}
