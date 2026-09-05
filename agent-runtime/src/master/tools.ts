// The Master AI's tools.
//
// There is deliberately no "run this SQL" tool. Arbitrary SQL from a model
// that also reads client-supplied text is a way to lose a table, and it
// makes scoping unenforceable — a WHERE clause the model writes is a WHERE
// clause the model can omit. Everything here is structured, and the client
// filter is applied by this file rather than by the model.
//
// Destructive work (delete, or an update touching more than one row) is
// refused once and issued a one-shot nonce. The model must come back with
// that nonce, and the nonce is only honoured if a human said something in
// between — so the confirmation is a person's, not the model's.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { ScopeError, ruleFor, tableNames, type MasterScope } from "./scope.js";

const MAX_ROWS = 200;
const MAX_PARENT_IDS = 1000;

export interface ToolContext {
  sb: SupabaseClient;
  scope: MasterScope;
  conversationId: string;
  /** The verified admin on whose behalf work is queued. */
  actorId: string;
  /** Latest user message time; a nonce older than this had a human after it. */
  lastUserMessageAt: string;
}

export interface ToolOutcome {
  result: unknown;
  /** Recorded in the message audit trail. */
  audit: { tool: string; input: unknown; summary: string; mutating: boolean };
}

type Filter = { column: string; op: string; value: unknown };

const FILTER_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"]);

const FILTER_SCHEMA = {
  type: "array",
  description: "Conditions ANDed together.",
  items: {
    type: "object",
    properties: {
      column: { type: "string" },
      op: { type: "string", enum: [...FILTER_OPS] },
      value: {
        anyOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
        ],
      },
    },
    required: ["column", "op", "value"],
    additionalProperties: false,
  },
} as const;

/** PostgREST builders expose one method per operator, all returning the builder. */
type Filterable<T> = Record<string, ((column: string, value: unknown) => T) | undefined>;

function applyFilters<T>(query: T, filters: Filter[] | undefined): T {
  let q = query;
  for (const f of filters ?? []) {
    if (!FILTER_OPS.has(f.op)) throw new ScopeError(`Unsupported filter op "${f.op}".`);
    const builder = q as Filterable<T>;
    const apply = builder[f.op];
    if (typeof apply !== "function") {
      throw new ScopeError(`Filter op "${f.op}" is not usable on this query.`);
    }
    const value = f.op === "in" ? (Array.isArray(f.value) ? f.value : [f.value]) : f.value;
    q = apply.call(builder, f.column, value);
  }
  return q;
}

/** Ids of the parent rows belonging to this client, for parent-scoped tables. */
async function parentIds(
  ctx: ToolContext,
  parentTable: string,
  parentKey: string,
  clientId: string,
): Promise<string[]> {
  const { data, error } = await ctx.sb
    .from(parentTable)
    .select(parentKey)
    .eq("client_id", clientId)
    .limit(MAX_PARENT_IDS);
  if (error) throw new Error(`Could not resolve scope via ${parentTable}: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const value = row[parentKey];
    return typeof value === "string" ? [value] : [];
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function toolDefinitions(scope: MasterScope): Anthropic.Messages.Tool[] {
  const readable = tableNames(scope, "read");
  const writable = tableNames(scope, "write");

  const tools: Anthropic.Messages.Tool[] = [
    {
      name: "list_tables",
      description: "List the tables this conversation can read or write, and what each is for.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "describe_table",
      description: "Show the columns and types of one table before reading or writing it.",
      input_schema: {
        type: "object",
        properties: { table: { type: "string", enum: readable } },
        required: ["table"],
        additionalProperties: false,
      },
    },
    {
      name: "read_rows",
      description:
        "Read rows from a table. The client filter is applied automatically in a client-scoped conversation.",
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string", enum: readable },
          columns: { type: "string", description: "Comma-separated, or * for all." },
          filters: FILTER_SCHEMA,
          order_by: { type: "string" },
          descending: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: MAX_ROWS },
        },
        required: ["table"],
        additionalProperties: false,
      },
    },
    {
      name: "count_rows",
      description: "Count matching rows without fetching them. Use before a broad change.",
      input_schema: {
        type: "object",
        properties: { table: { type: "string", enum: readable }, filters: FILTER_SCHEMA },
        required: ["table"],
        additionalProperties: false,
      },
    },
    {
      name: "write_rows",
      description:
        "Insert, update or delete rows. A delete, or an update touching more than one row, is refused the first time: describe the change to the operator, and once they agree call again with confirmed:true.",
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string", enum: writable },
          op: { type: "string", enum: ["insert", "update", "delete"] },
          values: { type: "object", description: "Column values for insert or update." },
          filters: FILTER_SCHEMA,
          confirmed: {
            type: "boolean",
            description:
              "Set true only after the operator has explicitly agreed to this exact change in reply to you.",
          },
        },
        required: ["table", "op"],
        additionalProperties: false,
      },
    },
    {
      name: "list_agents",
      description: "List the agents that can be run, with their domain and whether they are paused.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "run_agent",
      description: "Queue one agent. Returns the job id; the worker picks it up within seconds.",
      input_schema: {
        type: "object",
        properties: {
          agent_key: { type: "string" },
          input_table: { type: "string" },
          input_id: { type: "string" },
          ...(scope.kind === "company"
            ? { client_id: { type: "string", description: "Which client to run for." } }
            : {}),
        },
        required: ["agent_key"],
        additionalProperties: false,
      },
    },
    {
      name: "run_all_agents",
      description:
        "Queue every agent for a client. They self-sequence on their dependencies; anything already queued or running is skipped.",
      input_schema: {
        type: "object",
        properties:
          scope.kind === "company" ? { client_id: { type: "string" } } : {},
        ...(scope.kind === "company" ? { required: ["client_id"] } : {}),
        additionalProperties: false,
      },
    },
    {
      name: "job_status",
      description: "Recent agent jobs and their state. This is how you answer 'is it running yet'.",
      input_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["queued", "claimed", "running", "completed", "failed", "cancelled"] },
          agent_key: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "job_events",
      description: "The event log for one job — what the agent did, step by step, and why it failed.",
      input_schema: {
        type: "object",
        properties: { job_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        required: ["job_id"],
        additionalProperties: false,
      },
    },
    {
      name: "runtime_health",
      description: "Whether the agent runtime is alive, its queue depth and active jobs.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

  if (scope.kind === "company") {
    tools.push({
      name: "list_clients",
      description: "Every client, with sector and status. Company scope only.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function runTool(
  ctx: ToolContext,
  name: string,
  rawInput: unknown,
): Promise<ToolOutcome> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const audit = (summary: string, mutating = false) => ({ tool: name, input, summary, mutating });

  switch (name) {
    case "list_tables": {
      const result = {
        readable: tableNames(ctx.scope, "read"),
        writable: tableNames(ctx.scope, "write"),
        scope: ctx.scope.kind,
      };
      return { result, audit: audit(`Listed ${result.readable.length} readable tables`) };
    }

    case "describe_table": {
      const table = String(input.table);
      ruleFor(table, ctx.scope, "read");
      const { data, error } = await ctx.sb.rpc("master_ai_describe_table", { p_table: table });
      if (error) throw new Error(error.message);
      return { result: data, audit: audit(`Described ${table}`) };
    }

    case "read_rows": {
      const table = String(input.table);
      const rule = ruleFor(table, ctx.scope, "read");
      const limit = Math.min(Number(input.limit ?? 50), MAX_ROWS);

      let query = ctx.sb.from(table).select(String(input.columns ?? "*")).limit(limit);
      query = applyFilters(query, input.filters as Filter[]);

      if (ctx.scope.kind === "client") {
        if (rule.scope.by === "column") {
          query = query.eq(rule.scope.column, ctx.scope.clientId);
        } else if (rule.scope.by === "parent") {
          const ids = await parentIds(ctx, rule.scope.parentTable, rule.scope.parentKey, ctx.scope.clientId);
          if (ids.length === 0) return { result: [], audit: audit(`Read ${table}: no rows in scope`) };
          query = query.in(rule.scope.column, ids);
        }
      }
      if (input.order_by) {
        query = query.order(String(input.order_by), { ascending: input.descending !== true });
      }

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return { result: data, audit: audit(`Read ${data?.length ?? 0} row(s) from ${table}`) };
    }

    case "count_rows": {
      const table = String(input.table);
      const rule = ruleFor(table, ctx.scope, "read");
      let query = ctx.sb.from(table).select("*", { count: "exact", head: true });
      query = applyFilters(query, input.filters as Filter[]);
      if (ctx.scope.kind === "client" && rule.scope.by === "column") {
        query = query.eq(rule.scope.column, ctx.scope.clientId);
      }
      const { count, error } = await query;
      if (error) throw new Error(error.message);
      return { result: { count: count ?? 0 }, audit: audit(`Counted ${count ?? 0} in ${table}`) };
    }

    case "write_rows":
      return writeRows(ctx, input, audit);

    case "list_agents": {
      const { data, error } = await ctx.sb
        .from("agents")
        .select("agent_key, name, domain, description, requires_upstream, paused")
        .is("archived_at", null)
        .order("agent_key");
      if (error) throw new Error(error.message);
      return { result: data, audit: audit(`Listed ${data?.length ?? 0} agents`) };
    }

    case "run_agent": {
      const clientId = resolveClientId(ctx, input);
      const { data, error } = await ctx.sb.rpc("enqueue_agent_job_as", {
        p_actor: ctx.actorId,
        p_agent_key: String(input.agent_key),
        p_client_id: clientId,
        p_input_table: input.input_table ? String(input.input_table) : null,
        p_input_id: input.input_id ? String(input.input_id) : null,
      });
      if (error) throw new Error(error.message);
      return {
        result: { job_id: data, queued: true },
        audit: audit(`Queued ${String(input.agent_key)}`, true),
      };
    }

    case "run_all_agents": {
      const clientId = resolveClientId(ctx, input);
      const { data, error } = await ctx.sb.rpc("start_master_run_as", {
        p_actor: ctx.actorId,
        p_client_id: clientId,
      });
      if (error) throw new Error(error.message);
      return { result: data, audit: audit("Started a master run", true) };
    }

    case "job_status": {
      let query = ctx.sb
        .from("agent_jobs")
        .select("id, agent_key, client_id, status, attempts, cost_usd, error, created_at, started_at, completed_at")
        .order("created_at", { ascending: false })
        .limit(Math.min(Number(input.limit ?? 20), 50));
      if (input.status) query = query.eq("status", String(input.status));
      if (input.agent_key) query = query.eq("agent_key", String(input.agent_key));
      if (ctx.scope.kind === "client") query = query.eq("client_id", ctx.scope.clientId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return { result: data, audit: audit(`Read ${data?.length ?? 0} job(s)`) };
    }

    case "job_events": {
      const jobId = String(input.job_id);
      // Confirm the job is in scope before showing its log.
      const { data: job, error: jobError } = await ctx.sb
        .from("agent_jobs")
        .select("id, client_id, agent_key, status")
        .eq("id", jobId)
        .maybeSingle();
      if (jobError) throw new Error(jobError.message);
      if (!job) throw new ScopeError("No such job.");
      if (ctx.scope.kind === "client" && job.client_id !== ctx.scope.clientId) {
        throw new ScopeError("That job belongs to a different client.");
      }
      const { data, error } = await ctx.sb
        .from("agent_job_events")
        .select("description, level, payload, created_at")
        .eq("job_id", jobId)
        .order("created_at")
        .limit(Math.min(Number(input.limit ?? 50), 100));
      if (error) throw new Error(error.message);
      return { result: { job, events: data }, audit: audit(`Read the log for job ${jobId}`) };
    }

    case "runtime_health": {
      const { data, error } = await ctx.sb.from("agent_runtime_status").select("*");
      if (error) throw new Error(error.message);
      return { result: data, audit: audit("Checked runtime health") };
    }

    case "list_clients": {
      if (ctx.scope.kind !== "company") throw new ScopeError("Company scope only.");
      const { data, error } = await ctx.sb
        .from("clients")
        .select("id, name, initials, sector, location, tier, is_internal")
        .order("name");
      if (error) throw new Error(error.message);
      return { result: data, audit: audit(`Listed ${data?.length ?? 0} clients`) };
    }

    default:
      throw new ScopeError(`Unknown tool "${name}".`);
  }
}

/** A client-scoped conversation ignores any client_id the model supplies. */
function resolveClientId(ctx: ToolContext, input: Record<string, unknown>): string {
  if (ctx.scope.kind === "client") return ctx.scope.clientId;
  const supplied = input.client_id;
  if (!supplied) throw new ScopeError("This is a company-wide conversation — say which client.");
  return String(supplied);
}

async function writeRows(
  ctx: ToolContext,
  input: Record<string, unknown>,
  audit: (summary: string, mutating?: boolean) => ToolOutcome["audit"],
): Promise<ToolOutcome> {
  const table = String(input.table);
  const op = String(input.op);
  const rule = ruleFor(table, ctx.scope, "write");
  const filters = (input.filters ?? []) as Filter[];
  const values = (input.values ?? {}) as Record<string, unknown>;

  if (op !== "insert" && filters.length === 0) {
    throw new ScopeError(`A ${op} needs filters. Refusing to touch every row in ${table}.`);
  }

  // Parent-scoped writes: prove the parent belongs to this client first.
  if (ctx.scope.kind === "client" && rule.scope.by === "parent") {
    const key = rule.scope.column;
    const parentValue = op === "insert" ? values[key] : filters.find((f) => f.column === key)?.value;
    if (!parentValue) {
      throw new ScopeError(`Set ${key} so the row can be checked against this client.`);
    }
    const ids = await parentIds(ctx, rule.scope.parentTable, rule.scope.parentKey, ctx.scope.clientId);
    if (!ids.includes(String(parentValue))) {
      throw new ScopeError(`That ${key} does not belong to this client.`);
    }
  }

  if (op === "insert") {
    const row = { ...values };
    if (ctx.scope.kind === "client" && rule.scope.by === "column" && rule.scope.column === "client_id") {
      row.client_id = ctx.scope.clientId; // never taken from the model
    }
    const { data, error } = await ctx.sb.from(table).insert(row).select();
    if (error) throw new Error(error.message);
    return { result: data, audit: audit(`Inserted into ${table}`, true) };
  }

  // How many rows would this touch?
  let counter = ctx.sb.from(table).select("*", { count: "exact", head: true });
  counter = applyFilters(counter, filters);
  if (ctx.scope.kind === "client" && rule.scope.by === "column") {
    counter = counter.eq(rule.scope.column, ctx.scope.clientId);
  }
  const { count, error: countError } = await counter;
  if (countError) throw new Error(countError.message);
  const affected = count ?? 0;

  if (affected === 0) {
    return { result: { affected: 0, note: "Nothing matched those filters." }, audit: audit(`No rows matched in ${table}`) };
  }

  const destructive = op === "delete" || affected > 1;
  if (destructive) {
    const gate = await checkConfirmation(ctx, input, { table, op, affected });
    if (!gate.ok) return { result: gate.response, audit: audit(`Awaiting confirmation: ${op} ${affected} row(s) in ${table}`) };
  }

  let query =
    op === "delete"
      ? ctx.sb.from(table).delete()
      : ctx.sb.from(table).update(values);
  query = applyFilters(query, filters);
  if (ctx.scope.kind === "client" && rule.scope.by === "column") {
    query = query.eq(rule.scope.column, ctx.scope.clientId);
  }
  const { data, error } = await query.select();
  if (error) throw new Error(error.message);
  return {
    result: { affected: data?.length ?? affected, rows: data },
    audit: audit(`${op === "delete" ? "Deleted" : "Updated"} ${data?.length ?? affected} row(s) in ${table}`, true),
  };
}

/** Identity of the operation itself, so consent cannot transfer to a different change. */
function argsHash(input: Record<string, unknown>): string {
  const { confirmed: _ignored, ...rest } = input;
  return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

async function checkConfirmation(
  ctx: ToolContext,
  input: Record<string, unknown>,
  detail: { table: string; op: string; affected: number },
): Promise<{ ok: true } | { ok: false; response: unknown }> {
  const hash = argsHash(input);

  const { data: convo } = await ctx.sb
    .from("master_ai_conversations")
    .select("pending_confirmation")
    .eq("id", ctx.conversationId)
    .maybeSingle();
  const pending = convo?.pending_confirmation as { hash: string; issued_at: string } | null;

  const describedBefore = pending?.hash === hash;
  // The operator must have spoken AFTER this exact change was put to them.
  // That is the part a server can actually verify: whether a human took a
  // turn in between. Reading their answer as a yes is the model's job, and
  // the system prompt is explicit that a clear yes is required.
  const humanSpokeSince =
    describedBefore && new Date(pending.issued_at) < new Date(ctx.lastUserMessageAt);
  const fresh =
    describedBefore && Date.now() - new Date(pending.issued_at).getTime() < CONFIRMATION_TTL_MS;

  if (input.confirmed === true && humanSpokeSince && fresh) {
    await ctx.sb
      .from("master_ai_conversations")
      .update({ pending_confirmation: null })
      .eq("id", ctx.conversationId);
    return { ok: true };
  }

  // Record this exact change as the one put to the operator. Re-recording
  // on every refusal is what stops a confirmation being reused for a
  // different change: the hash moves, so the old consent no longer matches.
  if (!describedBefore || !fresh) {
    await ctx.sb
      .from("master_ai_conversations")
      .update({ pending_confirmation: { hash, issued_at: new Date().toISOString() } })
      .eq("id", ctx.conversationId);
  }

  return {
    ok: false,
    response: {
      needs_confirmation: true,
      summary: `${detail.op} ${detail.affected} row(s) in ${detail.table}`,
      reason:
        input.confirmed === true && !humanSpokeSince
          ? "You set confirmed on the same turn the change was first raised. The operator has not answered yet."
          : "This change has not been put to the operator yet.",
      instruction:
        "Tell the operator exactly what this will change — table, row count, and what the rows contain — and wait for their reply. If they clearly agree, call this again with identical arguments plus confirmed:true.",
    },
  };
}
