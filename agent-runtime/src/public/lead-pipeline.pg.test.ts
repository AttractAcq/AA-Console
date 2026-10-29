import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const CLIENT_USER = "44444444-4444-4444-8444-444444444444";
const OTHER_USER = "55555555-5555-4555-8555-555555555555";
const EDITOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let db: PGlite;
const migration = (file: string) => readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function asUser(user: string) {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claim.sub','${user}',false); set role authenticated;`);
}
async function asAdmin() { await asUser(ADMIN); }
async function asService() {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claim.sub','',false); set role service_role;`);
}
async function asAnon() {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','anon',false);
    select set_config('request.jwt.claim.sub','',false); set role anon;`);
}

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
  ]) await db.exec(await migration(file));
  // Minimal Supabase Storage tables; migration 08 installs the real policies.
  // The first folder segment is all the policy needs from foldername().
  await db.exec(`
    create schema storage;
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null,
      file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null, owner uuid
    );
    create function storage.foldername(path text) returns text[]
      language sql immutable as $$ select string_to_array(path, '/') $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert on storage.objects to authenticated;
  `);
  await db.exec(await migration("20260903105011_08_team_chat_and_storage_buckets.sql"));
  await db.exec(await migration("20260904094627_19_narrow_employee_client_scope.sql"));
  await db.exec(`
    alter table agents add column if not exists archived_at timestamptz;
    alter table agents add column if not exists requires_input boolean not null default false;
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
    insert into clients (id,name,initials)
      values ('66666666-6666-4666-8666-666666666666','Legacy','LG');
    insert into client_leads (id,client_id,name,stage) values
      ('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','Old lead','lead'),
      ('88888888-8888-4888-8888-888888888888','66666666-6666-4666-8666-666666666666','Old sale','sale');
    insert into lead_events (lead_id,client_id,kind,body)
      values ('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','note','Old note');
    insert into client_sales_agents (id,client_id,name,purpose)
      values ('99999999-9999-4999-8999-999999999999','66666666-6666-4666-8666-666666666666','Legacy agent','Calls');
    insert into sales_agent_conversations (client_id,sales_agent_id,lead_id)
      values ('66666666-6666-4666-8666-666666666666','99999999-9999-4999-8999-999999999999','77777777-7777-4777-8777-777777777777');
    insert into mcp_internal.mcp_pipeline_requests (lead_id)
      values ('88888888-8888-4888-8888-888888888888');
  `);
  await db.exec(await migration("20260925120000_128_lead_stage_enum.sql"));
  await db.exec(await migration("20260925110000_127_retired_team_access.sql"));
  await db.exec(await migration("20260925121000_129_lead_pipeline_archive.sql"));
  await db.exec(await migration("20261029160000_265_lead_and_media_entitlements.sql"));
  // The reporting functions in 266 are executed against these representative
  // relations. Their values distinguish each client's commercial result; the
  // permission checks are the behavior under test, not attribution maths.
  await db.exec(`
    create table client_marketing_spend (
      id uuid primary key default gen_random_uuid(), client_id uuid not null,
      spent_on date not null, amount numeric not null, currency text not null,
      channel text, campaign_id uuid
    );
    create view lead_progress as
      select id as lead_id, client_id, created_at, stage, source_channel,
        source_campaign_id, coalesce(sale_value,0) as sale_value,
        coalesce(cash_collected,0) as cash_collected,
        3::integer as furthest_rank from client_leads;
    create table content_attribution (
      client_id uuid not null, asset_ref text, asset_title text, hook text,
      idea_title text, content_territory text, leads integer, sales integer,
      cash_collected numeric, spend numeric, impressions bigint,
      sale_value numeric, asset_created_at timestamptz default now()
    );
    -- Migration 209 replaced migration 19's client-only INSERT with this
    -- broader policy. Reproduce the current policy before applying 266.
    alter table client_proof_assets add column usage_rights text not null default 'not_cleared';
    drop policy cpa_client_insert on client_proof_assets;
    create policy cpa_client_insert on client_proof_assets for insert to authenticated
      with check (can_access_client(client_id) and usage_rights = 'not_cleared');
  `);
  await db.exec(await migration("20261029170000_266_commercial_reporting_and_storage_scope.sql"));
  // 129 clears the active tables, but archives what it finds rather than
  // dropping it. lead_events.lead_id is ON DELETE CASCADE, so a bare delete
  // would have taken each lead's history with it.
  expect((await db.query("select id from client_leads")).rows).toHaveLength(0);
  expect((await db.query("select id from lead_events")).rows).toHaveLength(0);
  const migrated = await db.query<{ name: string; stage_at_archive: string; events: unknown[]; reason: string }>(
    "select name, stage_at_archive, events, reason from archived_leads order by name");
  expect(migrated.rows.map((row) => [row.name, row.stage_at_archive, row.events.length])).toEqual([
    ["Old lead", "lead", 1],
    ["Old sale", "sale", 0],
  ]);
  expect(migrated.rows[0]?.reason).toMatch(/migration 129/);
  expect((await db.query("select lead_id from sales_agent_conversations where lead_id is not null")).rows).toHaveLength(1);
  expect((await db.query("select lead_id from mcp_internal.mcp_pipeline_requests where lead_id is not null")).rows).toHaveLength(1);
  await db.exec(`
    delete from sales_agent_conversations; delete from client_sales_agents;
    delete from mcp_internal.mcp_pipeline_requests;
    delete from archived_leads; delete from lead_identities;
    delete from clients;
  `);
  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}'),('${CLIENT_USER}'),('${OTHER_USER}'),('${EDITOR}');
    update profiles set role='admin' where id='${ADMIN}';
    update profiles set role='client' where id in ('${CLIENT_USER}','${OTHER_USER}');
    update profiles set role='employee' where id='${EDITOR}';
    insert into clients (id,name,initials) values ('${CLIENT}','Client A','A'),('${OTHER}','Client B','B');
    insert into client_users (client_id,user_id) values ('${CLIENT}','${CLIENT_USER}'),('${OTHER}','${OTHER_USER}');
    insert into team_members (user_id,category,name,initials)
      values ('${EDITOR}','editors','Editor','E');
    grant all on archived_leads, client_leads, lead_events, lead_identities to authenticated;
    grant select on client_users to authenticated;
    grant select, insert on client_proof_assets to authenticated, service_role;
    grant usage on schema storage to service_role;
    grant select, insert on storage.objects to service_role;
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
  await db.exec(`delete from storage.objects; delete from client_marketing_spend;
    delete from content_attribution; delete from client_proof_assets;
    delete from job_assignments; delete from client_assignments;
    update team_members set active=true where user_id='${EDITOR}';`);
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

describe("migration 265: lead and owned-media entitlements", () => {
  it("rejects every named lead mutation for an assigned editor while preserving admin/client actions", async () => {
    const id = await createLead();
    await db.exec("reset role");
    await db.query(`insert into job_assignments(member_id,client_id,title)
      select id,$1,'Edit a reel' from team_members where user_id=$2`, [CLIENT, EDITOR]);
    await asUser(EDITOR);
    expect((await db.query<{ ok: boolean }>("select can_access_client($1) as ok", [CLIENT])).rows[0]?.ok).toBe(true);
    expect((await db.query("select id from client_leads where id=$1", [id])).rows).toHaveLength(0);
    expect((await db.query("select id from stalled_leads($1,30)", [CLIENT])).rows).toHaveLength(0);
    await expect(db.query("select advance_lead($1,'appointment')", [id])).rejects.toThrow(/Not permitted/);
    await expect(db.query("select update_lead($1,$2)", [id, { name: "Wrong" }])).rejects.toThrow(/Not permitted/);
    await expect(db.query("select add_lead_note($1,'Wrong')", [id])).rejects.toThrow(/Not permitted/);
    await expect(db.query("select archive_lead($1,null)", [id])).rejects.toThrow(/Not permitted/);

    await asAdmin();
    expect((await db.query("select id from stalled_leads($1,30)", [CLIENT])).rows).toHaveLength(1);
    await db.query("select archive_lead($1,null)", [id]);
    await asUser(EDITOR);
    await expect(db.query("select recover_lead($1)", [id])).rejects.toThrow(/Not permitted/);
    await asUser(CLIENT_USER);
    await db.query("select recover_lead($1)", [id]);
    await db.query("select update_lead($1,$2)", [id, { name: "Client edited" }]);
    await db.query("select advance_lead($1,'appointment')", [id]);
    await db.query("select add_lead_note($1,'Client follow-up')", [id]);
    await db.query("select archive_lead($1,null)", [id]);
    expect((await db.query("select id from archived_leads where id=$1", [id])).rows).toHaveLength(1);
    await db.query("select recover_lead($1)", [id]);
    expect((await db.query<{ name: string; stage: string }>("select name,stage from client_leads where id=$1", [id])).rows[0])
      .toMatchObject({ name: "Client edited", stage: "appointment" });
  });

  it("keeps service-role pipeline operations and denies cross-client humans", async () => {
    const id = await createLead();
    await asUser(OTHER_USER);
    await expect(db.query("select advance_lead($1,'appointment')", [id])).rejects.toThrow(/Not permitted/);
    await db.exec(`reset role; select set_config('request.jwt.claim.role','service_role',false);
      select set_config('request.jwt.claim.sub','',false); set role service_role;`);
    expect((await db.query("select id from stalled_leads($1,30)", [CLIENT])).rows).toHaveLength(1);
    await db.query("select advance_lead($1,'appointment')", [id]);
    await db.query("select update_lead($1,$2)", [id, { name: "Service edited" }]);
    await db.query("select add_lead_note($1,'Service note')", [id]);
    await db.query("select archive_lead($1,null)", [id]);
    await db.query("select recover_lead($1)", [id]);
    await db.exec("reset role");
    expect((await db.query<{ stage: string; name: string }>("select stage,name from client_leads where id=$1", [id])).rows[0])
      .toMatchObject({ stage: "appointment", name: "Service edited" });
    expect((await db.query("select id from lead_events where lead_id=$1 and body='Service note'", [id])).rows)
      .toHaveLength(1);
    const grant = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('authenticated', 'public.may_manage_client_leads(uuid)', 'EXECUTE') as allowed");
    expect(grant.rows[0]?.allowed).toBe(false);
    await db.exec(`select set_config('request.jwt.claim.role','',false);
      select set_config('request.jwt.claim.sub','',false);`);
    expect((await db.query<{ allowed: boolean }>(
      "select may_manage_client_leads($1) as allowed", [CLIENT])).rows[0]?.allowed).toBe(false);
    await expect(db.query("select advance_lead($1,'shown')", [id])).rejects.toThrow(/Not permitted/);
  });

  it("limits an employee's own client-media objects to active assigned clients", async () => {
    await db.exec("reset role");
    await db.query(`insert into job_assignments(member_id,client_id,title)
      select id,$1,'Edit a reel' from team_members where user_id=$2`, [CLIENT, EDITOR]);
    await db.query("insert into storage.objects(bucket_id,name,owner) values ('client-media',$1,$3),('client-media',$2,$3)",
      [`${CLIENT}/own-a.png`, `${OTHER}/own-b.png`, EDITOR]);
    const visible = () => db.query<{ name: string }>("select name from storage.objects where bucket_id='client-media' order by name");

    await asUser(EDITOR);
    expect((await visible()).rows.map((r) => r.name)).toEqual([`${CLIENT}/own-a.png`]);
    await db.exec(`reset role; update team_members set active=false where user_id='${EDITOR}';`);
    await asUser(EDITOR);
    expect((await visible()).rows).toHaveLength(0);

    await db.exec(`reset role; update team_members set active=true where user_id='${EDITOR}';
      delete from job_assignments;`);
    await asUser(EDITOR);
    expect((await visible()).rows).toHaveLength(0);
    await asUser(CLIENT_USER);
    expect((await visible()).rows.map((r) => r.name)).toEqual([`${CLIENT}/own-a.png`]);
    await asUser(OTHER_USER);
    expect((await visible()).rows.map((r) => r.name)).toEqual([`${OTHER}/own-b.png`]);
    await asAdmin();
    expect((await visible()).rows).toHaveLength(2);
  });
});

describe("migration 266: commercial reports and proof/SOP storage", () => {
  const since = "2000-01-01";
  const until = "2100-01-01";
  const economics = [
    "client_economics",
    "client_economics_by_channel",
    "client_economics_by_campaign",
  ] as const;

  it("keeps five definer reports within service, admin or same-client scope", async () => {
    await createLead();
    await db.exec("reset role");
    await db.query("insert into client_leads(client_id,name,stage,source_channel) values ($1,'Other','qualified','Search')", [OTHER]);
    await db.query(`insert into client_marketing_spend(client_id,spent_on,amount,currency,channel)
      values ($1,current_date,100,'ZAR','Social'),($2,current_date,200,'ZAR','Search')`, [CLIENT, OTHER]);
    await db.query(`insert into content_attribution(client_id,asset_ref,asset_title,leads,sales,cash_collected,spend,impressions,sale_value)
      values ($1,'A-1','Alpha',1,0,0,100,10,0),($2,'B-1','Beta',1,0,0,200,20,0)`, [CLIENT, OTHER]);
    await db.query(`insert into job_assignments(member_id,client_id,title)
      select id,$1,'Edit a reel' from team_members where user_id=$2`, [CLIENT, EDITOR]);

    const assertVisible = async (client: string, ref: string) => {
      const funnel = await db.query<{ leads: number }>("select leads from acquisition_funnel($1,30)", [client]);
      expect(funnel.rows[0]?.leads).toBe(1);
      for (const name of economics) {
        const rows = await db.query<{ spend: number }>(`select * from ${name}($1,$2,$3)`, [client, since, until]);
        expect(rows.rows.length).toBeGreaterThan(0);
        expect(rows.rows.reduce((sum, row) => sum + Number(row.spend), 0)).toBe(client === CLIENT ? 100 : 200);
      }
      const content = await db.query<{ asset_ref: string }>("select asset_ref from top_content_by_revenue($1,10)", [client]);
      expect(content.rows.map((r) => r.asset_ref)).toEqual([ref]);
    };
    const assertDenied = async (client: string) => {
      expect((await db.query("select * from acquisition_funnel($1,30)", [client])).rows).toHaveLength(0);
      for (const name of economics) {
        await expect(db.query(`select * from ${name}($1,$2,$3)`, [client, since, until]))
          .rejects.toThrow(/Not permitted/);
      }
      expect((await db.query("select * from top_content_by_revenue($1,10)", [client])).rows).toHaveLength(0);
    };

    await asAdmin();
    await assertVisible(CLIENT, "A-1");
    await assertVisible(OTHER, "B-1");
    await asUser(CLIENT_USER);
    await assertVisible(CLIENT, "A-1");
    await assertDenied(OTHER);
    await asUser(OTHER_USER);
    await assertVisible(OTHER, "B-1");
    await assertDenied(CLIENT);
    await asUser(EDITOR);
    expect((await db.query<{ allowed: boolean }>("select can_access_client($1) as allowed", [CLIENT])).rows[0]?.allowed).toBe(true);
    await assertDenied(CLIENT);
    await db.exec(`reset role; update team_members set active=false where user_id='${EDITOR}';`);
    await asUser(EDITOR);
    await assertDenied(CLIENT);
    await asService();
    await assertVisible(CLIENT, "A-1");
    await assertVisible(OTHER, "B-1");
    await asAnon();
    await expect(db.query("select * from acquisition_funnel($1,30)", [CLIENT])).rejects.toThrow(/permission denied/);
    for (const name of economics) {
      await expect(db.query(`select * from ${name}($1,$2,$3)`, [CLIENT, since, until]))
        .rejects.toThrow(/permission denied/);
    }
    await expect(db.query("select * from top_content_by_revenue($1,10)", [CLIENT])).rejects.toThrow(/permission denied/);
  });

  it("matches proof metadata and bucket scope, and removes SOP reads on retirement", async () => {
    await db.exec("reset role");
    await db.query(`insert into job_assignments(member_id,client_id,title)
      select id,$1,'Edit a reel' from team_members where user_id=$2`, [CLIENT, EDITOR]);
    await db.query(`insert into storage.objects(bucket_id,name)
      values ('proof',$1),('proof',$2),('sops','guide.pdf')`, [`${CLIENT}/a/evidence.png`, `${OTHER}/b/evidence.png`]);
    await db.query(`insert into client_proof_assets(client_id,media_type,body)
      values ($1,'text','Client A proof'),($2,'text','Client B proof')`, [CLIENT, OTHER]);
    const objects = (bucket: string) => db.query<{ name: string }>(
      "select name from storage.objects where bucket_id=$1 order by name", [bucket]);
    const proofRows = () => db.query<{ client_id: string }>(
      "select client_id from client_proof_assets order by client_id");
    const addProof = (client: string, rights = "not_cleared") => db.query(
      "insert into client_proof_assets(client_id,media_type,body,usage_rights) values ($1,'text','Evidence',$2)",
      [client, rights]);
    const upload = (client: string) => db.query(
      "insert into storage.objects(bucket_id,name) values ('proof',$1)", [`${client}/new/evidence.png`]);

    await asUser(EDITOR);
    expect((await db.query<{ allowed: boolean }>("select can_access_client($1) as allowed", [CLIENT])).rows[0]?.allowed).toBe(true);
    expect((await objects("proof")).rows).toHaveLength(0);
    expect((await proofRows()).rows).toHaveLength(0);
    expect((await objects("sops")).rows).toHaveLength(1);
    await expect(addProof(CLIENT)).rejects.toThrow(/row-level security/);
    await expect(upload(CLIENT)).rejects.toThrow(/row-level security/);
    await db.exec(`reset role; update team_members set active=false where user_id='${EDITOR}';`);
    await asUser(EDITOR);
    expect((await objects("sops")).rows).toHaveLength(0);
    expect((await objects("proof")).rows).toHaveLength(0);

    await asUser(CLIENT_USER);
    expect((await objects("proof")).rows.map((r) => r.name)).toEqual([`${CLIENT}/a/evidence.png`]);
    expect((await proofRows()).rows.map((r) => r.client_id)).toEqual([CLIENT]);
    expect((await objects("sops")).rows).toHaveLength(0);
    await addProof(CLIENT);
    await upload(CLIENT);
    await expect(addProof(OTHER)).rejects.toThrow(/row-level security/);
    await expect(upload(OTHER)).rejects.toThrow(/row-level security/);
    await expect(addProof(CLIENT, "approved")).rejects.toThrow(/row-level security/);
    await asUser(OTHER_USER);
    expect((await objects("proof")).rows.map((r) => r.name)).toEqual([`${OTHER}/b/evidence.png`]);
    expect((await proofRows()).rows.map((r) => r.client_id)).toEqual([OTHER]);
    await addProof(OTHER);
    await upload(OTHER);
    await expect(addProof(CLIENT)).rejects.toThrow(/row-level security/);
    await expect(upload(CLIENT)).rejects.toThrow(/row-level security/);
    await asAdmin();
    expect((await objects("proof")).rows).toHaveLength(4);
    expect((await proofRows()).rows.length).toBeGreaterThanOrEqual(4);
    expect((await objects("sops")).rows).toHaveLength(1);
    await addProof(OTHER);
    await upload(OTHER);
    await asService();
    expect((await objects("proof")).rows).toHaveLength(5);
    expect((await objects("sops")).rows).toHaveLength(1);
    await addProof(OTHER);
    await upload(OTHER);
    await asAnon();
    await expect(objects("proof")).rejects.toThrow(/permission denied/);
    await expect(objects("sops")).rejects.toThrow(/permission denied/);
    await expect(upload(CLIENT)).rejects.toThrow(/permission denied/);
    await expect(addProof(CLIENT)).rejects.toThrow(/permission denied/);
  });
});
