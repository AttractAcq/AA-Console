import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpEconomics } from "./economics-route.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CAMP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "test-only-service-credential";
let db: PGlite;
const migration = async (file: string) =>
  readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), "utf8");

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    grant usage on schema public, auth to authenticated, service_role, anon;
  `);
  for (const file of [
    "20260903104450_01_foundations_roles_clients.sql",
    "20260903104529_02_team_and_operations.sql",
    "20260903104615_03_agent_registry_and_job_queue.sql",
    "20260903104724_04_intelligence_and_strategy.sql",
    "20260903104816_05_content_chain_proof_ideas_briefs_media.sql",
    "20260903104850_06_distribution_conversion_leads.sql",
    "20260904080405_14_campaigns.sql",
    "20260904083559_15_brief_refs_and_job_link.sql",
    "20260904203418_23_idea_provenance_fields.sql",
    "20260907170000_55_structured_briefs.sql",
  ]) await db.exec(await migration(file));
  await db.exec(`
    alter table agents add column archived_at timestamptz;
    alter table agents add column requires_input boolean not null default false;
    alter table agent_jobs add column params jsonb not null default '{}';
    revoke execute on all functions in schema public from public, anon;
    grant execute on function enqueue_agent_job(text,uuid,text,uuid) to authenticated;
    create or replace function is_client_user(target uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from client_users cu where cu.user_id = auth.uid() and cu.client_id = target);
    $$;
    revoke execute on function is_client_user(uuid) from anon, public;
    grant execute on function is_client_user(uuid) to authenticated;
  `);
  for (const file of [
    "20260908030000_60_revenue_pipeline.sql",
    "20260908040000_61_lead_operations.sql",
    "20260908192515_67_sales_agents.sql",
    "20260907190000_56_repurposing.sql",
    "20260908080000_63_mcp_brief_enqueue.sql",
    "20260908080100_64_brief_job_idempotency.sql",
    "20260908190000_65_mcp_bot_auth_registry.sql",
    "20260908200000_66_mcp_domain_rls_bot_isolation.sql",
    "20260908230000_68_mcp_production_manager.sql",
    "20260908240000_69_mcp_phase5_read_rpc_volatile.sql",
    "20260909000000_70_mcp_approval_engine.sql",
    "20260909040000_74_mcp_production_bot_decide.sql",
    "20260909050000_75_mcp_distribution_manager.sql",
    "20260910000000_76_mcp_sales_ops.sql",
    "20260909010000_71_mcp_client_delivery.sql",
    "20260909020100_72_mcp_cos_orchestration.sql",
    "20260911210000_78_mcp_admin_calendar.sql",
    "20260915120000_84_mcp_sales_agent_factory.sql",
  ]) await db.exec(await migration(file));
  // Same stub as isolation-rls.test.ts: 79 needs client_campaigns for the FK,
  // but 72_campaign_execution is not in this partial fixture.
  await db.exec(`
    create table if not exists client_campaigns (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients (id) on delete cascade
    );
  `);
  for (const file of [
    "20260911205529_79_client_marketing_spend.sql",
    "20260915180000_85_mcp_finance_controller.sql",
  ]) await db.exec(await migration(file));
  await db.exec(`
    create table metrics_daily (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients(id),
      post_id uuid,
      metric_date date,
      impressions bigint,
      reach bigint,
      clicks bigint,
      spend numeric
    );
    alter table metrics_daily enable row level security;
  `);
  for (const file of [
    "20260925120000_128_lead_stage_enum.sql",
    "20260925121000_129_lead_pipeline_archive.sql",
    "20260925122000_130_lead_reporting_bot_stages.sql",
  ]) await db.exec(await migration(file));
}, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_bot_clients, client_marketing_spend, lead_events, client_leads, campaigns, clients, profiles, auth.users cascade;
    update mcp_internal.mcp_bots set status = 'active';
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI'),('${OTHER}','Other','OT');
    insert into campaigns (id,campaign_ref,client_id,target_role,daily_spend)
      values ('${CAMP}','FIN-A','${CLIENT}','owner',1);
    insert into client_marketing_spend (client_id, spent_on, amount, currency, source, campaign_id)
      values ('${CLIENT}','2026-09-10',100,'ZAR','manual','${CAMP}');
    insert into mcp_bot_clients (bot_id,client_id) values
      ('bot_finance','${CLIENT}'),('bot_production','${CLIENT}');
    select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claim.sub','',false);
  `);
});

function rpcAdapter() {
  const rpc = vi.fn((name: string, p: Record<string, unknown>) => ({
    abortSignal: async () => {
      try {
        const keys = Object.keys(p);
        const named = keys.map((k, i) => `${k} := $${i + 1}`).join(", ");
        const result = await db.query<{ result: unknown }>(
          `select ${name}(${named}) as result`,
          keys.map((k) => p[k]),
        );
        return { data: result.rows[0]?.result, error: null };
      } catch (e) {
        const error = e as { code: string; message: string };
        return { data: null, error: { code: error.code, message: error.message } };
      }
    },
  }));
  return { rpc, sb: { rpc } as unknown as SupabaseClient };
}

async function call(path: string, body: unknown, options: {
  headers?: Record<string, string | undefined>;
  secret?: string | null;
  method?: string;
  bot?: string;
} = {}) {
  const headers = {
    authorization: `Bearer ${SECRET}`, "x-aa-bot-id": options.bot ?? "bot_finance",
    "x-request-id": "request-1", "idempotency-key": "execution-1",
    "content-type": "application/json", ...options.headers,
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flatMap(([k, v]) => v === undefined ? [] : [k, v]);
  req.method = options.method ?? "POST";
  (req as IncomingMessage).url = path;
  let status = 0;
  let jsonBody: any;
  const res = Object.assign(new EventEmitter(), {
    writeHead: (code: number) => { status = code; },
    setHeader: vi.fn(), end: (data: string) => { jsonBody = JSON.parse(data); },
  }) as unknown as ServerResponse;
  const { sb } = rpcAdapter();
  await handleMcpEconomics(req, res, sb, options.secret === undefined ? SECRET : options.secret);
  return { status, body: jsonBody };
}

describe("Phase 13 economics routes", () => {
  it("requires the service secret", async () => {
    const result = await call("/internal/mcp/economics/get-costs", { client_id: CLIENT }, { secret: "wrong" });
    expect(result.status).toBe(401);
  });

  it("reads client economics and rejects unknown fields or other-bot identity", async () => {
    const result = await call("/internal/mcp/economics/get-client-economics", {
      client_id: CLIENT, start_date: "2026-09-01", end_date: "2026-10-01",
    });
    expect(result.status).toBe(200);
    expect(result.body.client_id).toBe(CLIENT);
    expect(Number(result.body.economics.spend)).toBe(100);
    const unknown = await call("/internal/mcp/economics/get-costs", { client_id: CLIENT, title: "nope" });
    expect(unknown.status).toBe(400);
    const otherBot = await call("/internal/mcp/economics/get-costs", { client_id: CLIENT }, { bot: "bot_production" });
    expect(otherBot.status).toBe(403);
    expect(otherBot.body.error.code).toBe("bot_forbidden");
  });

  it("attributes revenue by campaign and denies the ungranted client", async () => {
    const result = await call("/internal/mcp/attribution/get-revenue-attribution", {
      client_id: CLIENT, start_date: "2026-09-01", end_date: "2026-10-01",
    });
    expect(result.status).toBe(200);
    expect(result.body.campaigns[0].campaign_id).toBe(CAMP);
    const denied = await call("/internal/mcp/attribution/get-revenue-attribution", { client_id: OTHER });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("client_forbidden");
  });
});
