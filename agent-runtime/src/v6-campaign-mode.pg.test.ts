import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const clientA = "11111111-1111-4111-8111-111111111111";
const clientB = "22222222-2222-4222-8222-222222222222";
const source = "33333333-3333-4333-8333-333333333333";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function is_admin() returns boolean language sql stable as
      $$ select current_setting('test.is_admin', true) = 'true' $$;
    create function can_access_client(uuid) returns boolean language sql stable as
      $$ select current_setting('test.is_admin', true) = 'true' $$;
    create table clients (id uuid primary key);
    create table client_campaigns (
      id uuid primary key default gen_random_uuid(), client_id uuid not null references clients(id),
      name text not null, brief text not null, status text not null default 'planning',
      ideate_on_plan boolean not null default true,
      meta_campaign_id text, approved_at timestamptz,
      objective text, audience text, offer_summary text, core_message text,
      channels text[], budget numeric, starts_on date, ends_on date,
      kpi_metric text, kpi_target numeric, content_count integer,
      needs_landing_page boolean, needs_sales_agent boolean,
      ad_campaign_id text, built_at timestamptz, launched_at timestamptz,
      created_at timestamptz default now(), updated_at timestamptz default now(),
      unique (id, client_id)
    );
    create table agent_jobs (
      id uuid primary key, agent_key text, input_table text, input_id uuid, status text
    );
    create function enqueue_agent_job_internal(text, uuid, text, uuid, uuid, jsonb, text)
    returns uuid language sql as $$ select gen_random_uuid() $$;
  `);
  const migration = await readFile(new URL("../../supabase/migrations/20261015190000_203_v6_campaign_mode.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(`
    create schema mcp_internal;
    create table mcp_internal.mcp_campaign_requests (
      bot_id text not null, execution_id text not null, request_id text not null,
      tool text not null, client_id uuid not null, campaign_id uuid,
      payload jsonb not null, result jsonb not null,
      primary key (bot_id, execution_id)
    );
    create function mcp_internal.require_service_role() returns void language plpgsql as $$
    begin
      if auth.role() <> 'service_role' then raise exception 'service_role_required'; end if;
    end $$;
    create function mcp_internal.require_campaign_execution_permission(text, uuid, text)
      returns void language plpgsql as $$
    begin
      perform mcp_internal.require_service_role();
    end $$;
    create function mcp_internal.require_mcp_ids(p_request_id text, p_execution_id text)
      returns void language plpgsql as $$
    begin
      if nullif(p_request_id, '') is null or nullif(p_execution_id, '') is null then
        raise exception 'invalid_request';
      end if;
    end $$;
    create function mcp_internal.take_campaign_request(
      p_bot_id text, p_execution_id text, p_tool text, p_client_id uuid, p_payload jsonb
    ) returns jsonb language plpgsql as $$
    declare v_row mcp_internal.mcp_campaign_requests;
    begin
      select * into v_row from mcp_internal.mcp_campaign_requests
        where bot_id = p_bot_id and execution_id = p_execution_id;
      if found then
        if v_row.tool is distinct from p_tool or v_row.client_id is distinct from p_client_id
           or v_row.payload is distinct from p_payload then
          raise exception 'idempotency_conflict';
        end if;
        return v_row.result || jsonb_build_object('replayed', true);
      end if;
      return null;
    end $$;
    create function mcp_internal.enqueue_mcp_job(text, uuid, text, uuid, text, text, text, text)
      returns uuid language sql as $$ select gen_random_uuid() $$;
    create function mcp_internal.clip_text(p_value text, p_limit integer)
      returns text language sql as $$ select left(p_value, p_limit) $$;
    create function mcp_internal.campaign_json(c client_campaigns)
      returns jsonb language sql as $$ select jsonb_build_object('id', c.id, 'name', c.name) $$;
  `);
  const mcpMigration = await readFile(new URL("../../supabase/migrations/20261015210000_204_v6_mcp_campaign_create.sql", import.meta.url), "utf8");
  await db.exec(mcpMigration);
  const manifestMigration = await readFile(new URL("../../supabase/migrations/20261015220000_205_v6_campaign_manifest.sql", import.meta.url), "utf8");
  await db.exec(manifestMigration);
  await db.exec(`
    insert into clients(id) values ('${clientA}'), ('${clientB}');
    insert into client_campaigns(id,client_id,name,brief,meta_campaign_id,approved_at)
      values ('${source}','${clientA}','Original','A genuine source brief','12345',now());
    select set_config('request.jwt.claim.role','service_role',false);
  `);
});

afterAll(async () => { await db?.close(); });

it("keeps pre-v6 campaigns in an explicit legacy state", async () => {
  const result = await db.query<{ acquisition_mode: string; paid_platform: string | null }>(
    "select acquisition_mode,paid_platform from client_campaigns where id=$1", [source]);
  expect(result.rows[0]).toEqual({ acquisition_mode: "legacy", paid_platform: null });
});

it("clones only the brief into an independent paid campaign with lineage", async () => {
  const result = await db.query<{ clone_campaign_for_route: string }>(
    "select clone_campaign_for_route($1,$2,$3,$4)", [source, "paid", "meta", "Paid rebuild"]);
  const id = result.rows[0]!.clone_campaign_for_route;
  const row = await db.query<{
    client_id: string; name: string; brief: string; acquisition_mode: string;
    paid_platform: string; cloned_from_campaign_id: string; status: string;
    meta_campaign_id: string | null; approved_at: string | null;
  }>("select * from client_campaigns where id=$1", [id]);
  expect(row.rows[0]).toMatchObject({
    client_id: clientA, name: "Paid rebuild", brief: "A genuine source brief",
    acquisition_mode: "paid", paid_platform: "meta", cloned_from_campaign_id: source,
    status: "planning", meta_campaign_id: null, approved_at: null,
  });
  await expect(db.query("update client_campaigns set acquisition_mode='organic', paid_platform=null where id=$1", [id]))
    .rejects.toThrow(/immutable/);
  await expect(db.query("select request_meta_build($1)", [id]))
    .rejects.toThrow(/human approval/);
});

it("rejects an incomplete paid route and cross-client lineage", async () => {
  await expect(db.query("select clone_campaign_for_route($1,$2,$3,$4)", [source, "paid", null, "Bad route"]))
    .rejects.toThrow(/Choose organic/);
  await expect(db.query(
    "insert into client_campaigns(client_id,name,brief,acquisition_mode,cloned_from_campaign_id) values ($1,$2,$3,$4,$5)",
    [clientB, "Cross-client", "Invalid", "organic", source],
  )).rejects.toThrow(/foreign key/);
});

it("creates a route-aware MCP campaign once and replays the same execution", async () => {
  const args = ["chief", clientA, "Search demand", "A specific service acquisition brief", "paid", "google", "request-1", "execution-1"];
  const first = await db.query<{ mcp_campaign_create_v6: { campaign: { id: string; acquisition_mode: string; paid_platform: string }; replayed: boolean } }>(
    "select mcp_campaign_create_v6($1,$2,$3,$4,$5,$6,$7,$8)", args);
  expect(first.rows[0]!.mcp_campaign_create_v6).toMatchObject({
    campaign: { acquisition_mode: "paid", paid_platform: "google" }, replayed: false,
  });
  const again = await db.query<{ mcp_campaign_create_v6: { campaign: { id: string }; replayed: boolean } }>(
    "select mcp_campaign_create_v6($1,$2,$3,$4,$5,$6,$7,$8)", args);
  expect(again.rows[0]!.mcp_campaign_create_v6).toMatchObject({
    campaign: { id: first.rows[0]!.mcp_campaign_create_v6.campaign.id }, replayed: true,
  });
  const count = await db.query<{ count: number }>("select count(*) from client_campaigns where name='Search demand'");
  expect(count.rows[0]!.count).toBe(1);
  await expect(db.query("select mcp_campaign_create_v6($1,$2,$3,$4,$5,$6,$7,$8)",
    ["chief", clientA, "Search demand", "A specific service acquisition brief", "organic", null, "request-1", "execution-1"]))
    .rejects.toThrow(/idempotency_conflict/);
});

it("exposes mode and lineage in scoped MCP campaign reads", async () => {
  const created = await db.query<{ mcp_campaign_create_v6: { campaign: { id: string } } }>(
    "select mcp_campaign_create_v6($1,$2,$3,$4,$5,$6,$7,$8)",
    ["chief", clientA, "Listing probe", "Scoped route read", "paid", "google", "request-list", "execution-list"]);
  const list = await db.query<{ mcp_campaign_list_v6: {
    projection: string; campaigns: Array<{ id: string; acquisition_mode: string; paid_platform: string | null }>;
  } }>("select mcp_campaign_list_v6($1,$2)", ["chief", clientA]);
  expect(list.rows[0]!.mcp_campaign_list_v6.projection).toBe("client_campaigns_execution_v6");
  expect(list.rows[0]!.mcp_campaign_list_v6.campaigns).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: source, acquisition_mode: "legacy", paid_platform: null }),
    expect.objectContaining({ id: created.rows[0]!.mcp_campaign_create_v6.campaign.id,
      acquisition_mode: "paid", paid_platform: "google" }),
  ]));
  const other = await db.query<{ mcp_campaign_list_v6: { campaigns: unknown[] } }>(
    "select mcp_campaign_list_v6($1,$2)", ["chief", clientB]);
  expect(other.rows[0]!.mcp_campaign_list_v6.campaigns).toEqual([]);
});

it("requires a valid route and rejects every v6 launch path before approval execution", async () => {
  await expect(db.query("select mcp_campaign_create_v6($1,$2,$3,$4,$5,$6,$7,$8)",
    ["chief", clientA, "Invalid", "Brief", "paid", null, "request-2", "execution-2"]))
    .rejects.toThrow(/invalid_request/);
  await expect(db.query(
    "insert into client_campaigns(client_id,name,brief,acquisition_mode,status) values ($1,'Direct','Brief','organic','live')",
    [clientA],
  )).rejects.toThrow(/human approval/);
  const v6 = await db.query<{ id: string }>(
    "insert into client_campaigns(client_id,name,brief,acquisition_mode) values ($1,'Organic','Brief','organic') returning id",
    [clientA]);
  await expect(db.query("update client_campaigns set status='live' where id=$1", [v6.rows[0]!.id]))
    .rejects.toThrow(/human approval/);
  await db.query("update client_campaigns set status='live' where id=$1", [source]);
});

it("versions a route-bound campaign package with honest module dependencies", async () => {
  await expect(db.query("select create_campaign_manifest_v6($1,$2,$3)",
    [source, "legacy-package", false])).rejects.toThrow(/route-bound, built campaign plan/);
  const campaign = await db.query<{ id: string }>(`
    insert into client_campaigns (
      client_id,name,brief,acquisition_mode,paid_platform,built_at,objective,audience,
      offer_summary,needs_landing_page
    ) values ($1,'Acquisition','Brief','paid','meta',now(),'Booked consultations',
      'Local homeowners','Inspection offer',true) returning id`, [clientA]);
  const id = campaign.rows[0]!.id;
  const manifest = await db.query<{ manifest: {
    id: string; version: number; plan_hash: string; acquisition_mode: string; paid_platform: string;
  } }>("select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest", [id, "package-1", true]);
  const first = manifest.rows[0]!.manifest;
  expect(first).toMatchObject({ version: 1, acquisition_mode: "paid", paid_platform: "meta" });
  const items = await db.query<{ item_key: string; module_key: string; required: boolean; depends_on: string[] }>(
    "select item_key,module_key,required,depends_on from campaign_manifest_items where manifest_id=$1", [first.id]);
  expect(items.rows).toHaveLength(10);
  expect(items.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ item_key: "distribution", module_key: "meta_ads_studio",
      required: true, depends_on: ["creative", "website", "sales_path"] }),
    expect.objectContaining({ item_key: "lead_magnet", required: true,
      depends_on: ["offer", "website"] }),
  ]));
  await db.query("update client_campaigns set built_at=now() + interval '1 second' where id=$1", [id]);
  const replay = await db.query<{ manifest: { id: string } }>(
    "select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest", [id, "package-1", true]);
  expect(replay.rows[0]!.manifest.id).toBe(first.id);
  await expect(db.query("select create_campaign_manifest_v6($1,$2,$3)", [id, "package-1", false]))
    .rejects.toThrow(/Idempotency key/);
  await expect(db.query("update campaign_manifest_items set required=false where manifest_id=$1", [first.id]))
    .rejects.toThrow(/immutable/);
  const next = await db.query<{ manifest: { version: number; id: string } }>(
    "select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest", [id, "package-2", false]);
  expect(next.rows[0]!.manifest.version).toBe(2);
  expect(next.rows[0]!.manifest.id).not.toBe(first.id);
  await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
  try {
    await expect(db.query("select create_campaign_manifest_v6($1,$2,$3)",
      [id, "untrusted", false])).rejects.toThrow(/Service role required/);
  } finally {
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  }
});
