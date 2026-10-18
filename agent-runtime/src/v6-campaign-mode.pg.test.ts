import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const clientA = "11111111-1111-4111-8111-111111111111";
const clientB = "22222222-2222-4222-8222-222222222222";
const source = "33333333-3333-4333-8333-333333333333";
const manager = "44444444-4444-4444-8444-444444444444";
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
    create table profiles (id uuid primary key);
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
      id uuid primary key, agent_key text, client_id uuid,
      input_table text, input_id uuid, status text
    );
    create table agents (
      agent_key text primary key, name text, initials text, domain text,
      description text, requires_upstream text[], requires_input boolean
    );
    create table client_business_context (
      client_id uuid primary key, business_overview text, ideal_customer text,
      main_offer text, competitors text, brand_voice text, proof_testimonials text,
      current_marketing text, sales_process text, current_revenue text,
      target_revenue text, updated_at timestamptz default now()
    );
    create table client_agent_records (
      id uuid primary key default gen_random_uuid(), client_id uuid not null,
      domain text not null, item_key text not null, title text not null,
      body text, updated_at timestamptz default now(), display_order integer default 0
    );
    create table client_content_pillars (
      id uuid primary key, name text, premise text, belongs text, does_not_belong text
    );
    create table campaign_content_pillars (campaign_id uuid, pillar_id uuid);
    create table client_proof_assets (
      id uuid primary key, client_id uuid not null,
      usage_rights text not null, expires_on date,
      title text, body text, source text, proof_type text, claim text,
      evidence text, captured_on date, storage_path text
    );
    create table client_pages (
      id uuid primary key, client_id uuid not null, published_url text,
      publish_status text not null default 'unpublished', html text,
      current_revision integer, site_repository_id uuid, site_path text
    );
    create table client_page_revisions (
      id uuid primary key default gen_random_uuid(), client_id uuid not null,
      page_id uuid not null, revision_number integer not null, html text not null
    );
    create table client_site_repositories (
      id uuid primary key default gen_random_uuid(), client_id uuid not null,
      status text not null, pages_url text, owner text, repo text,
      default_branch text not null default 'main'
    );
    create table client_sales_agent_deployments (page_id uuid not null);
    create table client_sales_agents (id uuid primary key, client_id uuid not null);
    create table campaign_artifacts (
      id uuid primary key default gen_random_uuid(), campaign_id uuid not null,
      client_id uuid not null, kind text not null, page_id uuid,
      sales_agent_id uuid
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
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('test.user_id', true), '')::uuid $$;
    create function active_video_approval_manager(uuid) returns uuid language sql stable as $$
      select '${manager}'::uuid $$;
    insert into profiles(id) values ('${manager}');
  `);
  const approvalsMigration = await readFile(new URL("../../supabase/migrations/20261015230000_206_v6_action_approvals.sql", import.meta.url), "utf8");
  await db.exec(approvalsMigration);
  const intelligenceMigration = await readFile(new URL("../../supabase/migrations/20261016000000_207_v6_intelligence_snapshot.sql", import.meta.url), "utf8");
  await db.exec(intelligenceMigration);
  const offerMigration = await readFile(new URL("../../supabase/migrations/20261016010000_208_v6_offer_studio.sql", import.meta.url), "utf8");
  await db.exec(offerMigration);
  const proofArtifactMigration = await readFile(new URL("../../supabase/migrations/20261016020000_209_v6_proof_artifacts.sql", import.meta.url), "utf8");
  await db.exec(proofArtifactMigration);
  const offerBindingMigration = await readFile(new URL("../../supabase/migrations/20261016030000_210_v6_campaign_offer_binding.sql", import.meta.url), "utf8");
  await db.exec(offerBindingMigration);
  const artifactOfferMigration = await readFile(new URL("../../supabase/migrations/20261016040000_211_v6_artifact_offer_inputs.sql", import.meta.url), "utf8");
  await db.exec(artifactOfferMigration);
  const pagePublishBoundaryMigration = await readFile(new URL("../../supabase/migrations/20261016050000_212_v6_page_publish_boundary.sql", import.meta.url), "utf8");
  await db.exec(pagePublishBoundaryMigration);
  const pageApprovalMigration = await readFile(new URL("../../supabase/migrations/20261016060000_213_v6_page_approval_snapshot.sql", import.meta.url), "utf8");
  await db.exec(pageApprovalMigration);
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

it("binds a human decision to an exact v6 action and rejects stale or mismatched scope", async () => {
  const campaign = await db.query<{ id: string }>(`
    insert into client_campaigns (
      client_id,name,brief,acquisition_mode,paid_platform,built_at,objective,audience
    ) values ($1,'Approval test','Brief','paid','meta',now(),
      'Qualified leads','Service buyers') returning id`, [clientA]);
  const campaignId = campaign.rows[0]!.id;
  const manifest = await db.query<{ manifest: { id: string; plan_hash: string } }>(
    "select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest",
    [campaignId, "approval-package-1", false]);
  const { id, plan_hash } = manifest.rows[0]!.manifest;
  const scope = JSON.stringify({ account_id: "act_123", daily_spend_limit: 50 });
  await expect(db.query(
    "select request_campaign_action_approval_v6($1,$2,$3,$4,$5,$6::jsonb)",
    [id, "wrong-route", "google_ad_build", "google:123", "a".repeat(32), scope],
  )).rejects.toThrow(/does not match/);
  await expect(db.query(
    "select request_campaign_action_approval_v6($1,$2,$3,$4,$5,$6::jsonb)",
    [id, "wrong-version", "campaign_launch", "campaign", "a".repeat(32), scope],
  )).rejects.toThrow(/exact package hash/);
  const args = [id, "meta-build-1", "meta_ad_build", "meta:act_123", "a".repeat(32), scope];
  const first = await db.query<{ approval: { id: string; status: string; request_hash: string } }>(
    "select to_jsonb(request_campaign_action_approval_v6($1,$2,$3,$4,$5,$6::jsonb)) as approval", args);
  expect(first.rows[0]!.approval.status).toBe("pending");
  const approvalId = first.rows[0]!.approval.id;
  const replay = await db.query<{ approval: { id: string } }>(
    "select to_jsonb(request_campaign_action_approval_v6($1,$2,$3,$4,$5,$6::jsonb)) as approval", args);
  expect(replay.rows[0]!.approval.id).toBe(approvalId);
  await expect(db.query(
    "select request_campaign_action_approval_v6($1,$2,$3,$4,$5,$6::jsonb)",
    [id, "meta-build-1", "meta_ad_build", "meta:other", "a".repeat(32), scope],
  )).rejects.toThrow(/Idempotency key/);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('test.user_id','55555555-5555-4555-8555-555555555555',false);`);
  try {
    await expect(db.query("select decide_campaign_action_approval_v6($1,$2)",
      [approvalId, "approved"])).rejects.toThrow(/admin or the active client manager/);
    await db.exec(`select set_config('test.user_id','${manager}',false)`);
    const decided = await db.query<{ approval: { status: string; decided_by: string } }>(
      "select to_jsonb(decide_campaign_action_approval_v6($1,$2)) as approval",
      [approvalId, "approved"]);
    expect(decided.rows[0]!.approval).toMatchObject({ status: "approved", decided_by: manager });
    await expect(db.query("select decide_campaign_action_approval_v6($1,$2)",
      [approvalId, "approved"])).rejects.toThrow(/already been decided/);
    await expect(db.query("update campaign_action_approvals set destination='meta:other' where id=$1",
      [approvalId])).rejects.toThrow(/immutable/);
  } finally {
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  }
  const pending = await db.query<{ approval: { id: string } }>(
    "select to_jsonb(request_campaign_action_approval_v6($1,$2,$3,$4,$5,$6::jsonb)) as approval",
    [id, "meta-build-2", "meta_ad_build", "meta:act_123", "b".repeat(32), scope]);
  await db.query("select create_campaign_manifest_v6($1,$2,$3)",
    [campaignId, "approval-package-2", false]);
  await expect(db.query(
    "select request_campaign_action_approval_v6($1,$2,$3,$4,$5,$6::jsonb)",
    [id, "stale", "meta_ad_build", "meta:act_123", "a".repeat(32), scope],
  )).rejects.toThrow(/superseded/);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('test.user_id','${manager}',false);`);
  try {
    await expect(db.query("select decide_campaign_action_approval_v6($1,$2)",
      [pending.rows[0]!.approval.id, "approved"])).rejects.toThrow(/package changed/);
  } finally {
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  }
  expect(plan_hash).toMatch(/^[0-9a-f]{32}$/);
});

it("reuses the exact intelligence input on a planner retry and links it to the package", async () => {
  const campaign = await db.query<{ id: string }>(`
    insert into client_campaigns (
      client_id,name,brief,acquisition_mode,built_at,objective,audience,needs_landing_page
    ) values ($1,'Research campaign','Initial brief','organic',now(),
      'More bookings','Local buyers',false) returning id`, [clientA]);
  const campaignId = campaign.rows[0]!.id;
  const jobId = "66666666-6666-4666-8666-666666666666";
  const nextJobId = "77777777-7777-4777-8777-777777777777";
  await db.query("insert into agent_jobs(id,agent_key,input_table,input_id,status) values ($1,'campaign_plan','client_campaigns',$2,'running'),($3,'campaign_plan','client_campaigns',$2,'running')",
    [jobId, campaignId, nextJobId]);
  await db.query("insert into client_business_context(client_id,business_overview) values ($1,'Service business') on conflict(client_id) do update set business_overview=excluded.business_overview",
    [clientA]);
  const record = await db.query<{ id: string }>(`
    insert into client_agent_records(client_id,domain,item_key,title,body)
    values ($1,'offer_strategy','offer','Offer','An evidence-backed service') returning id`, [clientA]);
  const first = await db.query<{ snapshot: { id: string; snapshot_hash: string;
    source_records: Array<{ id: string; body: string; updated_at: string }>;
    missing_domains: string[] } }>(
    "select to_jsonb(capture_campaign_intelligence_snapshot_v6($1,$2)) as snapshot",
    [campaignId, jobId]);
  const original = first.rows[0]!.snapshot;
  expect(original.source_records).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: record.rows[0]!.id, body: "An evidence-backed service" }),
  ]));
  expect(original.missing_domains).toContain("icp");
  await db.query("update client_agent_records set body='Changed offer',updated_at=now() where id=$1",
    [record.rows[0]!.id]);
  const replay = await db.query<{ snapshot: { id: string; snapshot_hash: string; source_records: Array<{ body: string }> } }>(
    "select to_jsonb(capture_campaign_intelligence_snapshot_v6($1,$2)) as snapshot",
    [campaignId, jobId]);
  expect(replay.rows[0]!.snapshot.id).toBe(original.id);
  expect(replay.rows[0]!.snapshot.snapshot_hash).toBe(original.snapshot_hash);
  expect(replay.rows[0]!.snapshot.source_records[0]!.body).toBe("An evidence-backed service");
  const fresh = await db.query<{ snapshot: { id: string; snapshot_hash: string } }>(
    "select to_jsonb(capture_campaign_intelligence_snapshot_v6($1,$2)) as snapshot",
    [campaignId, nextJobId]);
  expect(fresh.rows[0]!.snapshot.snapshot_hash).not.toBe(original.snapshot_hash);
  const manifest = await db.query<{ manifest: { id: string } }>(
    "select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest",
    [campaignId, "research-package", false]);
  await db.query("select attach_campaign_manifest_intelligence_v6($1,$2)",
    [manifest.rows[0]!.manifest.id, original.id]);
  await db.query("select attach_campaign_manifest_intelligence_v6($1,$2)",
    [manifest.rows[0]!.manifest.id, original.id]);
  await expect(db.query("select attach_campaign_manifest_intelligence_v6($1,$2)",
    [manifest.rows[0]!.manifest.id, fresh.rows[0]!.snapshot.id]))
    .rejects.toThrow(/already uses another/);
});

it("versions service offers and requires cleared proof before a human signs quantified claims", async () => {
  const proofId = "88888888-8888-4888-8888-888888888888";
  await db.query("insert into client_proof_assets(id,client_id,usage_rights) values ($1,$2,'not_cleared')",
    [proofId, clientA]);
  const claims = JSON.stringify([
    { kind: "quantified", text: "95% of callers book a visit", proof_asset_id: proofId },
  ]);
  const args = [clientA, "Roof repair", "Homeowners", "A fast inspection",
    ["On-site survey"], ["Structural replacement"], 150, "EUR", 40, claims, "offer-draft-1", null];
  const first = await db.query<{ offer: { id: string; offer_id: string; version: number; content_hash: string } }>(
    "select to_jsonb(create_service_offer_version_v6($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)) as offer", args);
  const offer = first.rows[0]!.offer;
  expect(offer.version).toBe(1);
  expect(offer.content_hash).toMatch(/^[0-9a-f]{64}$/);
  const replay = await db.query<{ offer: { id: string } }>(
    "select to_jsonb(create_service_offer_version_v6($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)) as offer", args);
  expect(replay.rows[0]!.offer.id).toBe(offer.id);
  await expect(db.query("update service_offer_versions set promise='Changed' where id=$1", [offer.id]))
    .rejects.toThrow(/immutable/);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('test.user_id','${manager}',false);`);
  try {
    await expect(db.query("select approve_service_offer_version_v6($1)", [offer.id]))
      .rejects.toThrow(/current, cleared proof/);
    await db.query("update client_proof_assets set usage_rights='approved',permission_basis='Customer signed testimonial release' where id=$1", [proofId]);
    const signed = await db.query<{ signoff: { approved_by: string } }>(
      "select to_jsonb(approve_service_offer_version_v6($1)) as signoff", [offer.id]);
    expect(signed.rows[0]!.signoff.approved_by).toBe(manager);
    await expect(db.query("select approve_service_offer_version_v6($1)", [offer.id]))
      .rejects.toThrow(/already approved/);
  } finally {
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  }
  const campaign = await db.query<{ id: string }>(`
    insert into client_campaigns (
      client_id,name,brief,acquisition_mode,built_at,objective,audience,needs_landing_page
    ) values ($1,'Offer campaign','Brief','organic',now(),'Booked visits',
      'Homeowners',false) returning id`, [clientA]);
  const manifest = await db.query<{ manifest: { id: string } }>(
    "select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest",
    [campaign.rows[0]!.id, "offer-package", false]);
  await db.query("select attach_campaign_offer_v6($1,$2)", [manifest.rows[0]!.manifest.id, offer.id]);
  await db.query("select attach_campaign_offer_v6($1,$2)", [manifest.rows[0]!.manifest.id, offer.id]);
  const attached = await db.query<{ offer_version_id: string }>(
    "select offer_version_id from campaign_manifest_offers where manifest_id=$1",
    [manifest.rows[0]!.manifest.id]);
  expect(attached.rows[0]!.offer_version_id).toBe(offer.id);
  await expect(db.query("update campaign_manifest_offers set offer_version_id=$1 where manifest_id=$2",
    [offer.id, manifest.rows[0]!.manifest.id])).rejects.toThrow(/immutable/);
  const nextManifest = await db.query<{ manifest: { id: string } }>(
    "select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest",
    [campaign.rows[0]!.id, "offer-package-next", false]);
  await expect(db.query("select attach_campaign_offer_v6($1,$2)",
    [manifest.rows[0]!.manifest.id, offer.id])).rejects.toThrow(/superseded/);
  await db.query("update client_proof_assets set expires_on=current_date-1 where id=$1", [proofId]);
  await expect(db.query("select attach_campaign_offer_v6($1,$2)",
    [nextManifest.rows[0]!.manifest.id, offer.id])).rejects.toThrow(/current, cleared proof/);
});

it("holds proof derivatives until source rights and text pass human review", async () => {
  const proofId = "99999999-9999-4999-8999-999999999999";
  await db.query(`insert into client_proof_assets
    (id,client_id,usage_rights,title,body,source,claim,evidence)
    values ($1,$2,'not_cleared','Customer review','The team arrived on time.',
      'https://example.test/review','On-time arrival','The team arrived on time.')`,
  [proofId, clientA]);
  const args = [clientA, proofId, "geo_answer", "The team arrived on time",
    "The team arrived on time.", "How quickly do you arrive? A customer reported that the team arrived on time.",
    "proof-artifact-1", null];
  const first = await db.query<{ artifact: {
    id: string; version: number; source_hash: string; content_hash: string;
  } }>("select to_jsonb(create_proof_artifact_v6($1,$2,$3,$4,$5,$6,$7,$8)) as artifact", args);
  const artifact = first.rows[0]!.artifact;
  expect(artifact.version).toBe(1);
  expect(artifact.source_hash).toMatch(/^[0-9a-f]{64}$/);
  const replay = await db.query<{ artifact: { id: string } }>(
    "select to_jsonb(create_proof_artifact_v6($1,$2,$3,$4,$5,$6,$7,$8)) as artifact", args);
  expect(replay.rows[0]!.artifact.id).toBe(artifact.id);
  await expect(db.query("select create_proof_artifact_v6($1,$2,$3,$4,$5,$6,$7,$8)",
    [clientA, proofId, "geo_answer", "Claim", "Invented excerpt", "Draft", "bad-excerpt", null]))
    .rejects.toThrow(/appear verbatim/);
  await expect(db.query("select create_proof_artifact_v6($1,$2,$3,$4,$5,$6,$7,$8)",
    [clientB, proofId, "geo_answer", "Claim", "The team arrived on time.", "Draft", "wrong-client", null]))
    .rejects.toThrow(/does not belong/);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('test.user_id','${manager}',false);`);
  try {
    const requested = await db.query<{ request_proof_artifact_v6: string }>(
      "select request_proof_artifact_v6($1,$2,$3)", [clientA, proofId, "seo_case_study"]);
    expect(requested.rows[0]!.request_proof_artifact_v6).toMatch(/^[0-9a-f-]{36}$/);
    await expect(db.query("select request_proof_artifact_v6($1,$2,$3)",
      [clientB, proofId, "geo_answer"])).rejects.toThrow(/same-client proof/);
    await expect(db.query("select approve_proof_artifact_v6($1)", [artifact.id]))
      .rejects.toThrow(/uncleared, expired or changed/);
    await expect(db.query("update client_proof_assets set usage_rights='approved' where id=$1", [proofId]))
      .rejects.toThrow(/permission basis/);
    await db.query("update client_proof_assets set usage_rights='approved',permission_basis='Customer authorized quote use' where id=$1", [proofId]);
    const rights = await db.query<{ actor_id: string; actor_role: string; permission_basis: string }>(
      "select actor_id,actor_role,permission_basis from proof_rights_events where proof_id=$1", [proofId]);
    expect(rights.rows).toEqual([{
      actor_id: manager, actor_role: "authenticated", permission_basis: "Customer authorized quote use",
    }]);
    await db.query("update client_proof_assets set evidence='A revised account.' where id=$1", [proofId]);
    await expect(db.query("select approve_proof_artifact_v6($1)", [artifact.id]))
      .rejects.toThrow(/uncleared, expired or changed/);
    await db.query("update client_proof_assets set evidence='The team arrived on time.' where id=$1", [proofId]);
    const signoff = await db.query<{ signoff: { approved_by: string } }>(
      "select to_jsonb(approve_proof_artifact_v6($1)) as signoff", [artifact.id]);
    expect(signoff.rows[0]!.signoff.approved_by).toBe(manager);
  } finally {
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  }
  const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await db.query("insert into agent_jobs(id,agent_key,client_id) values ($1,'proof_artifact',$2)",
    [jobId, clientA]);
  const generated = await db.query<{ artifact: { created_by_job_id: string; version: number } }>(
    "select to_jsonb(create_proof_artifact_v6($1,$2,$3,$4,$5,$6,$7,$8)) as artifact",
    [clientA, proofId, "geo_answer", "On-time arrival", "The team arrived on time.",
      "A customer said the team arrived on time.", "agent-proof-1", jobId]);
  expect(generated.rows[0]!.artifact).toMatchObject({ created_by_job_id: jobId, version: 2 });
  await expect(db.query("update proof_artifact_versions set content='changed' where id=$1", [artifact.id]))
    .rejects.toThrow(/immutable/);
});

it("binds one approved offer before planning and captures its exact version", async () => {
  const args = [clientA, "Boiler service", "Homeowners", "An inspected boiler",
    ["Safety inspection"], ["Parts not included"], 120, "EUR", 30,
    JSON.stringify([{ kind: "general", text: "Includes a safety inspection" }]),
    "campaign-binding-offer", null];
  const created = await db.query<{ offer: { id: string; content_hash: string } }>(
    "select to_jsonb(create_service_offer_version_v6($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)) as offer", args);
  const offerId = created.rows[0]!.offer.id;
  await expect(db.query(`insert into client_campaigns
    (client_id,name,brief,acquisition_mode,offer_version_id)
    values ($1,'Unapproved','Brief','organic',$2)`, [clientA, offerId]))
    .rejects.toThrow(/approved offer/);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('test.user_id','${manager}',false);`);
  await db.query("select approve_service_offer_version_v6($1)", [offerId]);
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  await expect(db.query(`insert into client_campaigns
    (client_id,name,brief,acquisition_mode,offer_version_id)
    values ($1,'Other client','Brief','organic',$2)`, [clientB, offerId]))
    .rejects.toThrow();
  const campaign = await db.query<{ id: string }>(`insert into client_campaigns
    (client_id,name,brief,acquisition_mode,offer_version_id)
    values ($1,'Bound','Brief','organic',$2) returning id`, [clientA, offerId]);
  const campaignId = campaign.rows[0]!.id;
  const captured = await db.query<{ offer: { id: string; content_hash: string; promise: string } }>(
    "select capture_campaign_offer_v6($1) as offer", [campaignId]);
  expect(captured.rows[0]!.offer).toMatchObject({
    id: offerId, content_hash: created.rows[0]!.offer.content_hash,
    promise: "An inspected boiler",
  });
  await expect(db.query("update client_campaigns set offer_version_id=null where id=$1", [campaignId]))
    .rejects.toThrow(/fixed|before planning/);
  await db.query("update client_campaigns set built_at=now(),objective='Booked inspections',audience='Homeowners',needs_landing_page=false,needs_sales_agent=false where id=$1", [campaignId]);
  const manifest = await db.query<{ manifest: { id: string } }>(
    "select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest",
    [campaignId, "bound-package", false]);
  await db.query("select attach_campaign_offer_v6($1,$2)", [manifest.rows[0]!.manifest.id, offerId]);
  const linked = await db.query<{ offer_version_id: string }>(
    "select offer_version_id from campaign_manifest_offers where manifest_id=$1",
    [manifest.rows[0]!.manifest.id]);
  expect(linked.rows[0]!.offer_version_id).toBe(offerId);
  const mcpArgs = ["chief", clientA, "Boiler acquisition", "Book boiler inspections",
    "paid", "meta", "offer-bind-request", "offer-bind-execution", offerId];
  const mcp = await db.query<{ mcp_campaign_create_v6: {
    campaign: { id: string; offer_version_id: string }; replayed: boolean;
  } }>("select mcp_campaign_create_v6($1,$2,$3,$4,$5,$6,$7,$8,$9)", mcpArgs);
  expect(mcp.rows[0]!.mcp_campaign_create_v6.campaign.offer_version_id).toBe(offerId);
  const replay = await db.query<{ mcp_campaign_create_v6: { replayed: boolean } }>(
    "select mcp_campaign_create_v6($1,$2,$3,$4,$5,$6,$7,$8,$9)", mcpArgs);
  expect(replay.rows[0]!.mcp_campaign_create_v6.replayed).toBe(true);
  await expect(db.query("select mcp_campaign_create_v6($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [...mcpArgs.slice(0, 8), null])).rejects.toThrow(/idempotency_conflict/);
});

it("freezes the same approved campaign offer for page and sales-agent build jobs", async () => {
  const created = await db.query<{ offer: { id: string } }>(
    "select to_jsonb(create_service_offer_version_v6($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)) as offer",
    [clientA, "Garden design", "Homeowners", "A tailored garden plan",
      ["Site visit"], ["Construction excluded"], null, null, null, "[]",
      "artifact-offer", null]);
  const offerId = created.rows[0]!.offer.id;
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('test.user_id','${manager}',false);`);
  await db.query("select approve_service_offer_version_v6($1)", [offerId]);
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  const campaign = await db.query<{ id: string }>(`insert into client_campaigns
    (client_id,name,brief,acquisition_mode,offer_version_id,built_at,objective,audience,
     needs_landing_page,needs_sales_agent)
    values ($1,'Garden enquiries','Brief','organic',$2,now(),'Booked visits',
      'Homeowners',true,true) returning id`, [clientA, offerId]);
  const campaignId = campaign.rows[0]!.id;
  const manifest = await db.query<{ manifest: { id: string } }>(
    "select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest",
    [campaignId, "artifact-offer-package", false]);
  await db.query("select attach_campaign_offer_v6($1,$2)", [manifest.rows[0]!.manifest.id, offerId]);
  const pageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaabbbb";
  const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaacccc";
  const pageJob = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaadddd";
  const agentJob = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaeeee";
  await db.query("insert into client_pages(id,client_id) values ($1,$2)", [pageId, clientA]);
  await db.query("insert into client_sales_agents(id,client_id) values ($1,$2)", [agentId, clientA]);
  await db.query(`insert into campaign_artifacts(campaign_id,client_id,kind,page_id)
    values ($1,$2,'landing_page',$3)`, [campaignId, clientA, pageId]);
  await db.query(`insert into campaign_artifacts(campaign_id,client_id,kind,sales_agent_id)
    values ($1,$2,'sales_agent',$3)`, [campaignId, clientA, agentId]);
  await db.query(`insert into agent_jobs(id,agent_key,client_id,input_table,input_id)
    values ($1,'landing_page',$2,'client_pages',$3)`, [pageJob, clientA, pageId]);
  await db.query(`insert into agent_jobs(id,agent_key,client_id,input_table,input_id)
    values ($1,'sales_agent',$2,'client_sales_agents',$3)`, [agentJob, clientA, agentId]);
  const page = await db.query<{ offer: { id: string; promise: string } }>(
    "select capture_campaign_artifact_offer_v6($1,$2) as offer", [pageJob, "page"]);
  const agent = await db.query<{ offer: { id: string; promise: string } }>(
    "select capture_campaign_artifact_offer_v6($1,$2) as offer", [agentJob, "sales_agent"]);
  expect(page.rows[0]!.offer).toMatchObject({ id: offerId, promise: "A tailored garden plan" });
  expect(agent.rows[0]!.offer).toEqual(page.rows[0]!.offer);
  const replay = await db.query<{ offer: { id: string } }>(
    "select capture_campaign_artifact_offer_v6($1,$2) as offer", [pageJob, "page"]);
  expect(replay.rows[0]!.offer.id).toBe(offerId);
  await expect(db.query("select capture_campaign_artifact_offer_v6($1,$2)",
    [pageJob, "sales_agent"])).rejects.toThrow(/matching artifact build job/);
  const manualCampaign = await db.query<{ id: string }>(`insert into client_campaigns
    (client_id,name,brief,acquisition_mode,built_at,objective,audience,
     needs_landing_page,needs_sales_agent)
    values ($1,'Manual package offer','Brief','organic',now(),'Booked visits',
      'Homeowners',true,false) returning id`, [clientA]);
  const manualManifest = await db.query<{ manifest: { id: string } }>(
    "select to_jsonb(create_campaign_manifest_v6($1,$2,$3)) as manifest",
    [manualCampaign.rows[0]!.id, "manual-offer-package", false]);
  await db.query("select attach_campaign_offer_v6($1,$2)", [manualManifest.rows[0]!.manifest.id, offerId]);
  const manualPage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaffff";
  const manualJob = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaababa";
  await db.query("insert into client_pages(id,client_id) values ($1,$2)", [manualPage, clientA]);
  await db.query(`insert into campaign_artifacts(campaign_id,client_id,kind,page_id)
    values ($1,$2,'landing_page',$3)`, [manualCampaign.rows[0]!.id, clientA, manualPage]);
  await db.query(`insert into agent_jobs(id,agent_key,client_id,input_table,input_id)
    values ($1,'landing_page',$2,'client_pages',$3)`, [manualJob, clientA, manualPage]);
  const manual = await db.query<{ offer: { id: string } }>(
    "select capture_campaign_artifact_offer_v6($1,$2) as offer", [manualJob, "page"]);
  expect(manual.rows[0]!.offer.id).toBe(offerId);
  const another = await db.query<{ id: string }>(`insert into client_campaigns
    (client_id,name,brief,acquisition_mode) values ($1,'Another','Brief','organic') returning id`, [clientA]);
  await db.query(`insert into campaign_artifacts(campaign_id,client_id,kind,page_id)
    values ($1,$2,'landing_page',$3)`, [another.rows[0]!.id, clientA, pageId]);
  await expect(db.query("select capture_campaign_artifact_offer_v6($1,$2)",
    [pageJob, "page"])).rejects.toThrow(/ambiguous offer scope/);
});

it("blocks both page-publish entry and late attachment for v6 campaigns", async () => {
  const pageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const livePageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await db.query("insert into client_pages(id,client_id) values ($1,$2)", [pageId, clientA]);
  await db.query(`insert into client_pages(id,client_id,published_url,publish_status)
    values ($1,$2,'https://example.test/live','published')`, [livePageId, clientA]);
  await db.query("select assert_page_publish_allowed_v6($1)", [pageId]);
  const campaign = await db.query<{ id: string }>(`insert into client_campaigns
    (client_id,name,brief,acquisition_mode) values ($1,'Page gate','Brief','organic') returning id`, [clientA]);
  await db.query(`insert into campaign_artifacts(campaign_id,client_id,kind,page_id)
    values ($1,$2,'landing_page',$3)`, [campaign.rows[0]!.id, clientA, pageId]);
  await expect(db.query("select assert_page_publish_allowed_v6($1)", [pageId]))
    .rejects.toThrow(/exact-version human approval/);
  await expect(db.query("update client_pages set publish_status='publishing' where id=$1", [pageId]))
    .rejects.toThrow(/exact-version human approval/);
  await expect(db.query(`insert into campaign_artifacts(campaign_id,client_id,kind,page_id)
    values ($1,$2,'landing_page',$3)`, [campaign.rows[0]!.id, clientA, livePageId]))
    .rejects.toThrow(/live page cannot be attached/);
  await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
  await expect(db.query("select assert_page_publish_allowed_v6($1)", [pageId]))
    .rejects.toThrow(/Service role required/);
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
});

it("freezes the exact revision and destination for a v6 page approval request", async () => {
  const pageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const repoId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const html = "<html><body>Approved service offer</body></html>";
  const campaign = await db.query<{ id: string }>(`insert into client_campaigns
    (client_id,name,brief,acquisition_mode) values ($1,'Page approval','Brief','organic') returning id`, [clientA]);
  const campaignId = campaign.rows[0]!.id;
  await db.query(`update client_campaigns set objective='Leads', audience='Local buyers',
    built_at=now(), needs_landing_page=true where id=$1`, [campaignId]);
  await db.query("select create_campaign_manifest_v6($1,'page-approval-package',false)", [campaignId]);
  await db.query(`insert into client_site_repositories
    (id,client_id,status,pages_url,owner,repo) values
    ($1,$2,'ready','https://sites.example/client','aa-sites','client')`, [repoId, clientA]);
  await db.query(`insert into client_pages
    (id,client_id,html,current_revision)
    values ($1,$2,$3,1)`, [pageId, clientA, html]);
  await db.query(`insert into client_page_revisions
    (client_id,page_id,revision_number,html) values ($1,$2,1,$3)`, [clientA, pageId, html]);
  await db.query(`insert into campaign_artifacts
    (campaign_id,client_id,kind,page_id) values ($1,$2,'landing_page',$3)`, [campaignId, clientA, pageId]);

  const requested = await db.query<{ approval: { id: string; destination: string; status: string } }>(
    "select to_jsonb(request_campaign_page_deploy_approval_v6($1,$2,$3,$4)) as approval",
    [pageId, "deploy-v1", repoId, "service-offer/index.html"]);
  expect(requested.rows[0]!.approval).toMatchObject({
    destination: "https://sites.example/client/service-offer/", status: "pending",
  });
  const approvalId = requested.rows[0]!.approval.id;
  const snapshot = await db.query<{ rendered_html: string; site_path: string }>(
    "select rendered_html,site_path from campaign_page_approval_snapshots where approval_id=$1",
    [approvalId]);
  expect(snapshot.rows[0]).toEqual({ rendered_html: html, site_path: "service-offer/index.html" });
  const placement = await db.query<{ site_repository_id: string; site_path: string }>(
    "select site_repository_id,site_path from client_pages where id=$1", [pageId]);
  expect(placement.rows[0]).toEqual({ site_repository_id: repoId,
    site_path: "service-offer/index.html" });
  const replay = await db.query<{ approval: { id: string } }>(
    "select to_jsonb(request_campaign_page_deploy_approval_v6($1,$2)) as approval",
    [pageId, "deploy-v1"]);
  expect(replay.rows[0]!.approval.id).toBe(approvalId);
  const generic = await db.query<{ approval: { id: string } }>(
    `select to_jsonb(request_campaign_action_approval_v6(
      (select id from campaign_manifest_versions where campaign_id=$1),
      'generic-page', 'page_deploy', 'https://sites.example/client/other/',
      repeat('a',64), '{}'::jsonb)) as approval`, [campaignId]);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('test.user_id','${manager}',false)`);
  await expect(db.query("select decide_campaign_action_approval_v6($1,'approved',null)",
    [generic.rows[0]!.approval.id])).rejects.toThrow(/exact rendered snapshot/);
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  await db.query("update client_pages set html='<html>Changed</html>' where id=$1", [pageId]);
  await expect(db.query("select request_campaign_page_deploy_approval_v6($1,$2)",
    [pageId, "deploy-v1"])).rejects.toThrow(/does not match its recorded revision/);
  await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
  await expect(db.query("select decide_campaign_action_approval_v6($1,'approved',null)",
    [approvalId])).rejects.toThrow(/Page or destination changed/);
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  await db.query("update client_pages set html=$2 where id=$1", [pageId, html]);
  await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
  const decided = await db.query<{ approval: { status: string } }>(
    "select to_jsonb(decide_campaign_action_approval_v6($1,'approved',null)) as approval",
    [approvalId]);
  expect(decided.rows[0]!.approval.status).toBe("approved");
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  await db.query("select create_campaign_manifest_v6($1,'page-approval-package-v2',false)",
    [campaignId]);
  const nextPackageRequest = await db.query<{ approval: { id: string } }>(
    "select to_jsonb(request_campaign_page_deploy_approval_v6($1,$2)) as approval",
    [pageId, "deploy-v1"]);
  expect(nextPackageRequest.rows[0]!.approval.id).not.toBe(approvalId);
  await db.query("insert into client_sales_agent_deployments(page_id) values ($1)", [pageId]);
  await expect(db.query("select request_campaign_page_deploy_approval_v6($1,$2)",
    [pageId, "deploy-v2"])).rejects.toThrow(/Sales-agent widgets/);
});
