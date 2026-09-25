import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const CLIENT_USER = "44444444-4444-4444-8444-444444444444";
const OTHER_USER = "55555555-5555-4555-8555-555555555555";
let db: PGlite;
const migration = (file: string) => readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function asUser(user: string) {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claim.sub','${user}',false); set role authenticated;`);
}
async function asAdmin() { await asUser(ADMIN); }

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
    "20260903104816_05_content_chain_proof_ideas_briefs_media.sql",
    "20260903104850_06_distribution_conversion_leads.sql",
    "20260904080405_14_campaigns.sql",
  ]) await db.exec(await migration(file));
  await db.exec(`
    alter table agents add column if not exists archived_at timestamptz;
    alter table agents add column if not exists requires_input boolean not null default false;
    create or replace function is_client_user(target uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from client_users where user_id = auth.uid() and client_id = target);
    $$;
  `);
  for (const file of [
    "20260908030000_60_revenue_pipeline.sql",
    "20260908040000_61_lead_operations.sql",
    "20260908192515_67_sales_agents.sql",
  ]) await db.exec(await migration(file));
  await db.exec(`
    create schema mcp_internal;
    create table mcp_internal.mcp_pipeline_requests (
      id uuid primary key default gen_random_uuid(),
      lead_id uuid references client_leads(id)
    );
  `);
  await db.exec(await migration("20260925120000_128_lead_stage_enum.sql"));
  await db.exec(await migration("20260925121000_129_lead_pipeline_archive.sql"));
  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}'),('${CLIENT_USER}'),('${OTHER_USER}');
    update profiles set role='admin' where id='${ADMIN}';
    update profiles set role='client' where id in ('${CLIENT_USER}','${OTHER_USER}');
    insert into clients (id,name,initials) values ('${CLIENT}','Client A','A'),('${OTHER}','Client B','B');
    insert into client_users (client_id,user_id) values ('${CLIENT}','${CLIENT_USER}'),('${OTHER}','${OTHER_USER}');
    grant all on archived_leads, client_leads, lead_events, lead_identities to authenticated;
    grant all on client_sales_agents, sales_agent_conversations to authenticated;
    grant usage on schema mcp_internal to authenticated;
    grant all on mcp_internal.mcp_pipeline_requests to authenticated;
  `);
});

beforeEach(async () => {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claim.sub','',false);
    delete from sales_agent_conversations; delete from client_sales_agents;
    delete from mcp_internal.mcp_pipeline_requests;
    delete from archived_leads; delete from client_leads; delete from lead_identities;`);
  await asAdmin();
});

async function createLead(stage = "qualified", cash = 0) {
  const result = await db.query<{ id: string }>(`
    insert into client_leads (client_id,name,stage,cash_collected,source_channel,opportunity_value)
    values ($1,'Sam', $2::lead_stage,$3,'Instagram',2500) returning id`, [CLIENT, stage, cash]);
  return result.rows[0]!.id;
}

describe("lead edit and archive RPCs", () => {
  it("rejects stage edits, negative money and early cash", async () => {
    const id = await createLead();
    await expect(db.query("select update_lead($1,$2)", [id, { stage: "cash" }])).rejects.toThrow(/cannot be edited/);
    await expect(db.query("select update_lead($1,$2)", [id, { sale_value: -1 }])).rejects.toThrow(/zero or more/);
    await expect(db.query("select update_lead($1,$2)", [id, { cash_collected: 25 }])).rejects.toThrow(/Show Ups/);
    await db.query("select update_lead($1,$2)", [id, { name: "Sam Updated", phone: "+12345678" }]);
    const row = await db.query<{ name: string }>("select name from client_leads where id=$1", [id]);
    expect(row.rows[0]?.name).toBe("Sam Updated");
    const event = await db.query<{ body: string }>("select body from lead_events where lead_id=$1 and kind='note'", [id]);
    expect(event.rows[0]?.body).toMatch(/name, phone/);
  });

  it("moves the full row and every event into separate storage, then recovers them", async () => {
    const id = await createLead();
    await db.query("select add_lead_note($1,$2)", [id, "First call"]);
    expect((await db.query("select id from stalled_leads($1,30)", [CLIENT])).rows).toHaveLength(1);
    await db.query("select archive_lead($1,$2)", [id, "No longer active"]);
    expect((await db.query("select id from stalled_leads($1,30)", [CLIENT])).rows).toHaveLength(0);
    expect((await db.query("select id from client_leads where id=$1", [id])).rows).toHaveLength(0);
    expect((await db.query("select id from lead_events where lead_id=$1", [id])).rows).toHaveLength(0);
    const archived = await db.query<{ id: string; events: unknown[]; lead: { source_channel: string } }>(
      "select id,events,lead from archived_leads where id=$1", [id]);
    expect(archived.rows[0]?.id).toBe(id);
    expect(archived.rows[0]?.events).toHaveLength(1);
    expect(archived.rows[0]?.lead.source_channel).toBe("Instagram");
    await db.query("select recover_lead($1)", [id]);
    expect((await db.query("select id from archived_leads where id=$1", [id])).rows).toHaveLength(0);
    const restored = await db.query<{ id: string; stage: string; source_channel: string }>(
      "select id,stage,source_channel from client_leads where id=$1", [id]);
    expect(restored.rows[0]).toMatchObject({ id, stage: "qualified", source_channel: "Instagram" });
    const events = await db.query<{ body: string }>("select body from lead_events where lead_id=$1 order by occurred_at", [id]);
    expect(events.rows.map((event) => event.body)).toEqual(expect.arrayContaining(["First call", expect.stringContaining("Recovered from archive")]));
  });

  it("keeps sales conversation and MCP request links through archive and recovery", async () => {
    const id = await createLead();
    await db.exec(`insert into client_sales_agents (id,client_id,name,purpose)
      values ('66666666-6666-4666-8666-666666666666','${CLIENT}','Sales','Calls');`);
    await db.query(`insert into sales_agent_conversations (client_id,sales_agent_id,lead_id,transcript)
      values ($1,'66666666-6666-4666-8666-666666666666',$2,'[]'::jsonb)`, [CLIENT, id]);
    await db.query("insert into mcp_internal.mcp_pipeline_requests (lead_id) values ($1)", [id]);
    await db.query("select archive_lead($1,null)", [id]);
    expect((await db.query("select lead_id from sales_agent_conversations where lead_id=$1", [id])).rows).toHaveLength(1);
    expect((await db.query("select lead_id from mcp_internal.mcp_pipeline_requests where lead_id=$1", [id])).rows).toHaveLength(1);
    await db.query("select recover_lead($1)", [id]);
    expect((await db.query("select lead_id from sales_agent_conversations where lead_id=$1", [id])).rows).toHaveLength(1);
  });

  it("refuses archiving cash and keeps cross-client archives isolated", async () => {
    const cashId = await createLead("shown", 50);
    await expect(db.query("select archive_lead($1,null)", [cashId])).rejects.toThrow(/cash collected/);
    const id = await createLead();
    await db.query("select archive_lead($1,null)", [id]);
    await asUser(OTHER_USER);
    expect((await db.query("select id from archived_leads")).rows).toHaveLength(0);
    await expect(db.query("select recover_lead($1)", [id])).rejects.toThrow(/Not permitted/);
    await asUser(CLIENT_USER);
    expect((await db.query("select id from archived_leads")).rows).toHaveLength(1);
  });
});
