// What a Master AI conversation is allowed to touch.
//
// This is the security core of the feature. The runtime holds the service
// role key, so RLS does not apply to anything it does — every constraint on
// a client-scoped conversation is the one enforced here.
//
// Two rules make that tractable:
//
//  1. The scope is bound when the conversation is created and re-read from
//     the database on every turn. The model is never asked, and never
//     believed, about which client it is working on. A client_id in tool
//     arguments is ignored.
//
//  2. In client scope the registry is an allow-list. A table with no entry
//     is denied rather than defaulted to open, so a table added later is
//     invisible to a client-scoped conversation until someone decides how
//     it should be scoped.
//
// Company scope is deliberately unrestricted — that is what it is for.

export type MasterScope =
  | { kind: "company" }
  | { kind: "client"; clientId: string };

type ScopeRule =
  /** Row carries the client key directly, e.g. client_id (or id, on clients). */
  | { by: "column"; column: string }
  /** Row is tied to a client through a parent row. */
  | { by: "parent"; column: string; parentTable: string; parentKey: string }
  /** Not client-scoped at all. */
  | { by: "global" };

interface TableRule {
  scope: ScopeRule;
  /** May a client-scoped conversation read this? */
  clientRead: boolean;
  /** May a client-scoped conversation write this? */
  clientWrite: boolean;
  /** Views and derived tables cannot be written by anyone. */
  readOnly?: boolean;
  note?: string;
}

const CLIENT_COLUMN: ScopeRule = { by: "column", column: "client_id" };

export const TABLES: Record<string, TableRule> = {
  // ---- the client record itself -----------------------------------------
  // Scoped by its own primary key, not by a client_id column.
  clients: { scope: { by: "column", column: "id" }, clientRead: true, clientWrite: true },

  // ---- directly client-scoped -------------------------------------------
  campaigns: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_agent_inputs: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_agent_records: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_assignments: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_audit_notes: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_billing: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_briefs: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_business_context: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_contracts: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_ideas: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_leads: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_media_assets: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_onboarding_steps: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_pages: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  client_proof_assets: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  // Read-only on purpose. These rows are pulled from an ad platform and
  // are what a client is shown as fact; a human or a model editing them
  // would be falsifying reporting rather than correcting it. Fix the
  // mapping and re-run the ingest instead.
  metrics_daily: {
    scope: CLIENT_COLUMN,
    clientRead: true,
    clientWrite: false,
    note: "Reporting numbers are written by the ingest job. Re-run metrics_ingest rather than editing them.",
  },
  finance_entries: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  job_assignments: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  scheduled_posts: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },
  work_logs: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: true },

  // Queue rows are readable, but starting work goes through run_agent so
  // the gating and dependency rules in start_master_run are not bypassed.
  agent_jobs: {
    scope: CLIENT_COLUMN,
    clientRead: true,
    clientWrite: false,
    note: "Use run_agent or run_all_agents to start work.",
  },

  // Credential metadata only — the secret itself lives in Vault and is
  // never exposed through these tools.
  client_integrations: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: false },
  // Links auth users to clients; changing it changes who can log in.
  client_users: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: false },
  // Internal counter behind ref numbers. Editing it corrupts numbering.
  ref_counters: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: false },

  // ---- scoped through a parent row --------------------------------------
  agent_job_events: {
    scope: { by: "parent", column: "job_id", parentTable: "agent_jobs", parentKey: "id" },
    clientRead: true,
    clientWrite: false,
  },
  client_asset_reviews: {
    scope: { by: "parent", column: "asset_id", parentTable: "client_media_assets", parentKey: "id" },
    clientRead: true,
    clientWrite: true,
  },

  // ---- global reference, safe to read from a client conversation --------
  agents: { scope: { by: "global" }, clientRead: true, clientWrite: false },
  record_templates: { scope: { by: "global" }, clientRead: true, clientWrite: false },
  sops: { scope: { by: "global" }, clientRead: true, clientWrite: false },

  // ---- global, company scope only ---------------------------------------
  // clientRead/clientWrite govern CLIENT scope only; company scope allows
  // everything. A global table is therefore false on both — there is no
  // client whose rows these could be narrowed to.
  profiles: { scope: { by: "global" }, clientRead: false, clientWrite: false },
  team_members: { scope: { by: "global" }, clientRead: false, clientWrite: false },
  team_channels: { scope: { by: "global" }, clientRead: false, clientWrite: false },
  team_messages: { scope: { by: "global" }, clientRead: false, clientWrite: false },
  channel_members: { scope: { by: "global" }, clientRead: false, clientWrite: false },
  finance_periods: { scope: { by: "global" }, clientRead: false, clientWrite: false },
  contract_payments: { scope: { by: "global" }, clientRead: false, clientWrite: false },
  agent_runtime_heartbeats: { scope: { by: "global" }, clientRead: false, clientWrite: false },

  // ---- views: readable, never writable ----------------------------------
  approvals_queue: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: false, readOnly: true },
  work_submissions: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: false, readOnly: true },
  client_billing_view: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: false, readOnly: true },
  lead_pipeline_counts: { scope: CLIENT_COLUMN, clientRead: true, clientWrite: false, readOnly: true },
  campaign_totals: { scope: { by: "global" }, clientRead: true, clientWrite: false, readOnly: true },
  agent_stats: { scope: { by: "global" }, clientRead: false, clientWrite: false, readOnly: true },
  agent_runtime_status: { scope: { by: "global" }, clientRead: true, clientWrite: false, readOnly: true },
  mrr_from_billing: { scope: { by: "global" }, clientRead: false, clientWrite: false, readOnly: true },
};

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

export function tableNames(scope: MasterScope, mode: "read" | "write"): string[] {
  return Object.entries(TABLES)
    .filter(([, rule]) => {
      if (mode === "write" && rule.readOnly) return false;
      if (scope.kind === "company") return true;
      return mode === "read" ? rule.clientRead : rule.clientWrite;
    })
    .map(([name]) => name)
    .sort();
}

/**
 * Resolves a table for use, or throws with a reason the model can act on.
 * Every tool that touches a table goes through here first.
 */
export function ruleFor(table: string, scope: MasterScope, mode: "read" | "write"): TableRule {
  const rule = TABLES[table];
  if (!rule) {
    throw new ScopeError(
      `Unknown table "${table}". Available: ${tableNames(scope, mode).join(", ")}`,
    );
  }
  if (mode === "write" && rule.readOnly) {
    throw new ScopeError(`"${table}" is a view and cannot be written.`);
  }
  if (scope.kind === "client") {
    const allowed = mode === "read" ? rule.clientRead : rule.clientWrite;
    if (!allowed) {
      const why = rule.note ?? `This conversation is scoped to a single client and cannot ${mode} "${table}".`;
      throw new ScopeError(why);
    }
  }
  return rule;
}
