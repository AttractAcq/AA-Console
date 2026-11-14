import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = (name: string) =>
  readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");

const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMPAIGN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEGACY_CAMPAIGN = "cccccccc-aaaa-4ccc-8aaa-cccccccccccc";
const OFFER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OFFER_VERSION_A = "aaaaaaaa-0000-4000-8000-000000000002";

let db: PGlite;

async function one<T extends Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}

async function asService<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create schema storage;
    create table storage.objects(name text primary key, metadata jsonb);
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role',true) $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table public.clients(id uuid primary key);
    create table public.profiles(id uuid primary key);
    create table public.agent_jobs(id uuid primary key);
    create function public.can_access_client(p uuid) returns boolean language sql stable
      as $$ select true $$;
    create function public.lock_down_definer_functions() returns void language sql
      as $$ select null::void $$;
    create table public.client_campaigns(
      id uuid primary key, client_id uuid not null references public.clients(id),
      runs_organic boolean not null, runs_paid boolean not null,
      paid_platform text, acquisition_mode text, offer_version_id uuid,
      objective text, updated_at timestamptz default now(),
      status text default 'planning', cloned_from_campaign_id uuid);
    create function public.campaign_plan_fingerprint(p public.client_campaigns)
      returns text language sql stable as
      $$ select md5(p.id::text || ':' || coalesce(p.objective,'')) $$;
    create table public.campaign_manifest_versions(
      id uuid primary key, campaign_id uuid not null, client_id uuid not null,
      version integer not null, acquisition_mode text not null,
      plan_hash text not null);
    create table public.campaign_manifest_items(
      manifest_id uuid not null, item_key text not null,
      module_key text not null, required boolean not null,
      external_activation boolean not null default false,
      depends_on text[] not null default '{}',
      primary key(manifest_id,item_key));
    create table public.approval_requests_v6(
      id uuid primary key, client_id uuid, source_system text,
      source_kind text, source_id text, source_version text, title text,
      requested_at timestamptz default now(), requested_by uuid,
      requester_kind text, requester_ref text, expires_at timestamptz,
      artifact_hash text, preview jsonb, destination text, account_ref text,
      budget jsonb, scope jsonb, owner_role text, preview_blocker text,
      owning_path text, payload_hash text not null);
    create table public.approval_request_evidence_v6(
      id uuid primary key, request_id uuid, artifact_hash text,
      preview jsonb, destination text, account_ref text, budget jsonb,
      scope jsonb);
    create table public.approval_decision_events_v6(
      id uuid primary key default gen_random_uuid(), request_id uuid,
      decision text, event_order bigint generated always as identity);
    create table public.production_release_attestations_v6(
      id uuid primary key, request_id uuid, packet jsonb,
      event_order bigint generated always as identity);
    create function public.approval_source_state_v6(p uuid) returns text
      language sql stable as $$ select 'pending'::text $$;
    create function public.production_release_source_state_v6(p uuid) returns text
      language sql stable as $$ select 'pending'::text $$;
    create function public.recruitment_meta_build_source_state_v6(p uuid) returns text
      language sql stable as $$ select 'pending'::text $$;
    create function public.organic_publication_source_state_v6(p uuid) returns text
      language sql stable as $$ select 'pending'::text $$;
    create table public.campaign_action_approvals(
      id uuid primary key, client_id uuid, campaign_id uuid,
      destination text, artifact_version_hash text, scope jsonb default '{}'::jsonb);
    create table public.campaign_action_executions(
      id uuid primary key, approval_id uuid, client_id uuid,
      campaign_id uuid, artifact_version_hash text, action_key text,
      manifest_id uuid, status text);
    create table public.market_opportunities(
      id uuid primary key, client_id uuid, name text, status text,
      status_note text, updated_at timestamptz default now());
    create table public.client_agent_records(
      id uuid primary key, client_id uuid, content jsonb,
      updated_at timestamptz default now());
    create table public.service_offers(
      id uuid primary key, client_id uuid, service_name text);
    create table public.service_offer_versions(
      id uuid primary key, client_id uuid, offer_id uuid,
      version integer, content_hash text);
    create table public.client_media_assets(
      id uuid primary key, client_id uuid, body text,
      updated_at timestamptz default now(), storage_path text default 'path',
      render_path text);
    create table public.client_proof_assets(
      id uuid primary key, client_id uuid, title text,
      usage_rights text, expires_on date, permission_basis text);
    create function public.proof_source_snapshot_v6(p public.client_proof_assets)
      returns jsonb language sql stable as
      $$ select jsonb_build_object('id',p.id,'title',p.title) $$;
    create table public.proof_artifact_versions(
      id uuid primary key, client_id uuid, source_proof_id uuid,
      content_hash text);
    create table public.client_proof_destinations(
      client_id uuid, destination_key text, enabled boolean, account_ref text,
      primary key(client_id,destination_key));
    create table public.client_pages(
      id uuid primary key, client_id uuid, body text,
      updated_at timestamptz default now());
    create table public.lead_magnets(
      id uuid primary key, client_id uuid, campaign_id uuid);
    create table public.lead_magnet_versions(
      id uuid primary key, client_id uuid, magnet_id uuid,
      content_sha256 text);
    create table public.client_sales_agents(
      id uuid primary key, client_id uuid, instructions text,
      updated_at timestamptz default now());
    create table public.client_leads(
      id uuid primary key, client_id uuid, source_client_campaign_id uuid,
      source_post_id uuid, source_click_id text, source_utm jsonb,
      consent_given_at timestamptz);
    create table public.lead_events(
      id uuid primary key, client_id uuid, lead_id uuid, kind text,
      body text, occurred_at timestamptz);
    create table public.opportunity_links(
      id uuid primary key, client_id uuid, opportunity_id uuid,
      campaign_id uuid, role text);
    create table public.campaign_artifacts(
      id uuid primary key, client_id uuid, campaign_id uuid,
      asset_id uuid, page_id uuid, sales_agent_id uuid);
    insert into public.clients values ('${CLIENT_A}'),('${CLIENT_B}');
    insert into public.client_campaigns
      (id,client_id,runs_organic,runs_paid,paid_platform,acquisition_mode,objective)
      values ('${CAMPAIGN_A}','${CLIENT_A}',true,true,'meta','both','Original'),
             ('${CAMPAIGN_B}','${CLIENT_B}',true,false,null,'organic','Other'),
             ('${LEGACY_CAMPAIGN}','${CLIENT_B}',false,false,null,'legacy','Historical');
    insert into public.service_offers values
      ('${OFFER_A}','${CLIENT_A}','Core service');
    insert into public.service_offer_versions values
      ('${OFFER_VERSION_A}','${CLIENT_A}','${OFFER_A}',1,
       repeat('a',64));
    create function public.guard_campaign_acquisition_route()
      returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger guard_campaign_acquisition_route_insert
      before insert on public.client_campaigns for each row
      execute function public.guard_campaign_acquisition_route();
    create trigger guard_campaign_acquisition_route_update
      before update on public.client_campaigns for each row
      execute function public.guard_campaign_acquisition_route();
  `);
  for (const name of [
    "20261114000000_316_delivery_work_contract.sql",
    "20261114010000_317_delivery_lineage_catalog.sql",
    "20261114020000_318_delivery_lineage_links.sql",
    "20261114030000_319_delivery_dependency_invalidation.sql",
    "20261114040000_320_delivery_live_lineage_guards.sql",
    "20261114050000_321_delivery_asset_bytes.sql",
    "20261114060000_322_campaign_route_guard_insert.sql",
    "20261114070000_323_storage_change_invalidates_creative.sql",
  ]) {
    await db.exec(await migration(name));
  }
  await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
}, 120_000);

afterAll(async () => { await db?.close(); });

describe("delivery Phase 1 contract", () => {
  it("backfills each route without inventing a legacy status", async () => {
    const rows = (await db.query<{ route: string; campaign_id: string }>(
      `select campaign_id,route from public.campaign_route_packages_v6 order by campaign_id,route`,
    )).rows;
    expect(rows.filter((r) => r.campaign_id === CAMPAIGN_A).map((r) => r.route))
      .toEqual(["organic", "paid"]);
    expect(rows.filter((r) => r.campaign_id === CAMPAIGN_B).map((r) => r.route))
      .toEqual(["organic"]);
    expect(rows.filter((r) => r.campaign_id === LEGACY_CAMPAIGN)).toEqual([]);
  });

  it("allows a new both-route campaign while preserving route and launch holds", async () => {
    const campaign = "23232323-2323-4232-8232-232323232323";
    await db.exec(`insert into public.client_campaigns
      (id,client_id,runs_organic,runs_paid,paid_platform,acquisition_mode,objective)
      values ('${campaign}','${CLIENT_A}',true,true,'meta','both','New')`);
    await expect(db.exec(`update public.client_campaigns set runs_paid=false,
      acquisition_mode='organic',paid_platform=null where id='${campaign}'`))
      .rejects.toThrow(/immutable/i);
    await expect(db.exec(`update public.client_campaigns set status='live'
      where id='${campaign}'`)).rejects.toThrow(/approval/i);
  });

  it("rejects a cross-client lineage edge", async () => {
    const a = await one<{ id: string }>(`select entity_version_id as id from public.delivery_entity_heads_v6
      where client_id='${CLIENT_A}' and entity_kind='campaign'`);
    const b = await one<{ id: string }>(`select entity_version_id as id from public.delivery_entity_heads_v6
      where client_id='${CLIENT_B}' and entity_kind='campaign'`);
    await expect(db.exec(`insert into public.delivery_lineage_links_v6
      (client_id,source_version_id,derived_version_id,relationship)
      values ('${CLIENT_A}','${a.id}','${b.id}','informed')`))
      .rejects.toThrow();
  });

  it("records a new source fingerprint and makes a bound approval stale", async () => {
    const old = await one<{ entity_version_id: string }>(`select entity_version_id
      from public.delivery_entity_heads_v6 where client_id='${CLIENT_A}'
        and entity_kind='offer' and source_key='${OFFER_A}'`);
    const request = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await db.exec(`insert into public.approval_requests_v6
      (id,client_id,source_system,source_kind,source_id,source_version,
       title,artifact_hash,preview,scope,owner_role,expires_at,payload_hash)
      values ('${request}','${CLIENT_A}','test','test','x','1','Review',
       repeat('f',64),'{}'::jsonb,'{}'::jsonb,'admin_or_active_client_manager',
       now()+interval '1 day',repeat('f',64))`);
    await asService(`select public.bind_delivery_approval_dependency_v6(
      '${request}','${old.entity_version_id}')`);
    await db.exec(`insert into public.service_offer_versions values
      (gen_random_uuid(),'${CLIENT_A}','${OFFER_A}',2,repeat('b',64))`);
    const row = await one<{ status: string; preview_blocker: string }>(
      `select status,preview_blocker from public.approval_inbox_v6 where id='${request}'`,
    );
    expect(row.status).toBe("stale");
    expect(row.preview_blocker).toMatch(/source changed/i);
    await expect(db.exec(`insert into public.approval_decision_events_v6
      (request_id,decision) values ('${request}','approved')`))
      .rejects.toThrow(/source changed/i);
  });

  it("refuses cross-client and unreviewed work transitions", async () => {
    const work = await asService<{ id: string }>(`select id from
      public.create_delivery_work_item_v6('${CAMPAIGN_A}',null,null,null,
        'creative',1,'content_production_factory',true,
        '{"brief":"one"}'::jsonb,'{"format":"image"}'::jsonb)`);
    const id = work[0]!.id;
    const other = await one<{ entity_version_id: string }>(`select entity_version_id
      from public.delivery_entity_heads_v6 where client_id='${CLIENT_B}'
      and entity_kind='campaign' and source_key='${CAMPAIGN_B}'`);
    await expect(asService(`select public.bind_delivery_work_input_v6(
      '${id}','content_production_factory','${other.entity_version_id}')`))
      .rejects.toThrow(/same client|match/i);
    await expect(asService(`select public.link_delivery_work_output_v6(
      '${id}','content_production_factory','${other.entity_version_id}')`))
      .rejects.toThrow(/same client|match/i);
    await expect(asService(`select public.advance_delivery_work_item_v6(
      '${id}','website_studio','prepared','{}'::jsonb)`))
      .rejects.toThrow(/owning module/i);
    await expect(asService(`select public.advance_delivery_work_item_v6(
      '${id}','content_production_factory','approved','{}'::jsonb)`))
      .rejects.toThrow();
    const state = await one<{ state: string }>(`select state from
      public.delivery_work_items_v6 where id='${id}'`);
    expect(state.state).toBe("draft");
  });

  it("traces a migrated campaign through opportunity, offer, assets, delivery and outcome", async () => {
    const opportunity = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const asset = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const page = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const proof = "99999999-9999-4999-8999-999999999999";
    const proofVersion = "88888888-8888-4888-8888-888888888888";
    const magnet = "77777777-7777-4777-8777-777777777777";
    const magnetVersion = "66666666-6666-4666-8666-666666666666";
    const agent = "55555555-5555-4555-8555-555555555555";
    const lead = "44444444-4444-4444-8444-444444444444";
    await db.exec(`
      insert into public.market_opportunities(id,client_id,name,status)
        values ('${opportunity}','${CLIENT_A}','Niche','discovered');
      insert into public.opportunity_links(id,client_id,opportunity_id,campaign_id,role)
        values (gen_random_uuid(),'${CLIENT_A}','${opportunity}','${CAMPAIGN_A}','campaign');
      update public.client_campaigns set offer_version_id='${OFFER_VERSION_A}'
        where id='${CAMPAIGN_A}';
      insert into public.client_media_assets(id,client_id,body)
        values ('${asset}','${CLIENT_A}','Creative');
      insert into public.client_pages values ('${page}','${CLIENT_A}','Landing',now());
      insert into public.client_sales_agents values ('${agent}','${CLIENT_A}','Agent',now());
      insert into public.campaign_artifacts values
        (gen_random_uuid(),'${CLIENT_A}','${CAMPAIGN_A}','${asset}',null,null),
        (gen_random_uuid(),'${CLIENT_A}','${CAMPAIGN_A}',null,'${page}',null),
        (gen_random_uuid(),'${CLIENT_A}','${CAMPAIGN_A}',null,null,'${agent}');
      insert into public.client_proof_assets values
        ('${proof}','${CLIENT_A}','Review','approved',null,'consent');
      insert into public.proof_artifact_versions values
        ('${proofVersion}','${CLIENT_A}','${proof}',repeat('c',64));
      insert into public.lead_magnets values ('${magnet}','${CLIENT_A}','${CAMPAIGN_A}');
      insert into public.lead_magnet_versions values
        ('${magnetVersion}','${CLIENT_A}','${magnet}',repeat('d',64));
      insert into public.client_leads(id,client_id,source_client_campaign_id)
        values ('${lead}','${CLIENT_A}','${CAMPAIGN_A}');
      insert into public.lead_events values
        (gen_random_uuid(),'${CLIENT_A}','${lead}','outcome','Sale',now());
    `);
    const kinds = (await db.query<{ entity_kind: string }>(`
      select distinct entity_kind from public.delivery_entity_heads_v6
      where client_id='${CLIENT_A}' and entity_kind in
        ('opportunity','offer_version','campaign','route_package','content_asset',
         'proof_source','proof_artifact','page','magnet_version','sales_agent',
         'lead','outcome')`)).rows.map((r) => r.entity_kind);
    expect(kinds).toHaveLength(12);
    const edges = (await db.query<{ relationship: string }>(`
      select relationship from public.delivery_lineage_links_v6
      where client_id='${CLIENT_A}'`)).rows.map((r) => r.relationship);
    for (const relation of ['informed','selected_offer','route_of','produced',
      'derived_proof','captured','recorded_outcome']) {
      expect(edges).toContain(relation);
    }
  });

  it("blocks stale work inputs even when an old state remains prepared", async () => {
    const model = "33333333-3333-4333-8333-333333333333";
    await db.exec(`insert into public.client_agent_records
      values ('${model}','${CLIENT_A}','{"claim":"first"}'::jsonb,now())`);
    const source = await one<{ entity_version_id: string }>(`select entity_version_id
      from public.delivery_entity_heads_v6 where client_id='${CLIENT_A}'
      and entity_kind='source_model' and source_key='${model}'`);
    const work = await asService<{ id: string }>(`select id from
      public.create_delivery_work_item_v6('${CAMPAIGN_A}',null,null,null,
        'strategy',1,'intelligence_os',true,'{}'::jsonb,'{}'::jsonb)`);
    const id = work[0]!.id;
    await asService(`select public.bind_delivery_work_input_v6(
      '${id}','intelligence_os','${source.entity_version_id}')`);
    await asService(`select public.advance_delivery_work_item_v6(
      '${id}','intelligence_os','prepared','{}'::jsonb)`);
    await db.exec(`update public.client_agent_records
      set content='{"claim":"changed"}'::jsonb where id='${model}'`);
    const effective = await one<{ effective_state: string }>(`select effective_state
      from public.delivery_work_effective_v6 where id='${id}'`);
    expect(effective.effective_state).toBe('held');
    await expect(asService(`select public.advance_delivery_work_item_v6(
      '${id}','intelligence_os','prepared','{}'::jsonb)`))
      .rejects.toThrow(/changed/i);
  });

  it("opens remediation when an executed action's source changes", async () => {
    const action = "22222222-3333-4333-8333-444444444444";
    const request = "11111111-2222-4222-8222-333333333333";
    await db.exec(`
      insert into public.campaign_action_approvals
        (id,client_id,campaign_id)
        values ('${action}','${CLIENT_A}','${CAMPAIGN_A}');
      insert into public.approval_requests_v6
        (id,client_id,source_system,source_kind,source_id,source_version,
         title,artifact_hash,preview,scope,owner_role,expires_at,payload_hash)
        values ('${request}','${CLIENT_A}','aa_console','campaign_action',
          '${action}','1','Publish',repeat('e',64),'{}'::jsonb,'{}'::jsonb,
          'admin_or_active_client_manager',now()+interval '1 day',repeat('e',64));
      insert into public.campaign_action_executions
        values (gen_random_uuid(),'${action}','${CLIENT_A}','${CAMPAIGN_A}',
          repeat('e',64),'publish',null,'executed');
      update public.client_campaigns set objective='Changed after publish'
        where id='${CAMPAIGN_A}';
    `);
    const rows = (await db.query<{ external_use_kind: string }>(`
      select external_use_kind from public.delivery_remediation_tasks_v6
      where approval_request_id='${request}'`)).rows;
    expect(rows.map((r) => r.external_use_kind))
      .toContain('campaign_action_execution');
    const approvalEdges = await one<{ count: string }>(`select count(*)::text as count
      from public.delivery_lineage_links_v6 l
      join public.delivery_entity_versions_v6 s on s.id=l.source_version_id
      join public.delivery_entity_versions_v6 d on d.id=l.derived_version_id
      where l.client_id='${CLIENT_A}' and l.relationship='approved_action'
        and ((s.entity_kind='campaign' and d.entity_kind='approval')
          or (s.entity_kind='approval' and d.entity_kind='distribution_attempt'))`);
    expect(Number(approvalEdges.count)).toBeGreaterThanOrEqual(2);
  });

  it("requires exact creative bytes and invalidates an approval when they change", async () => {
    const asset = "12121212-1212-4212-8212-121212121212";
    const request = "13131313-1313-4313-8313-131313131313";
    await db.exec(`insert into public.client_media_assets
      (id,client_id,body,storage_path) values
      ('${asset}','${CLIENT_A}','Creative','${CLIENT_A}/creative.png')`);
    const work = await asService<{ id: string }>(`select id from
      public.create_delivery_work_item_v6('${CAMPAIGN_A}',null,null,null,
        'creative_bytes',1,'content_production_factory',true,
        '{}'::jsonb,'{}'::jsonb)`);
    const id = work[0]!.id;
    const old = await one<{ entity_version_id: string }>(`select entity_version_id
      from public.delivery_entity_heads_v6 where client_id='${CLIENT_A}'
        and entity_kind='content_asset' and source_key='${asset}'`);
    await expect(asService(`select public.link_delivery_work_output_v6(
      '${id}','content_production_factory','${old.entity_version_id}')`))
      .rejects.toThrow(/byte SHA-256/i);
    await expect(asService(`select public.register_delivery_asset_bytes_v6(
      '${asset}','wrong/path',repeat('a',64))`)).rejects.toThrow(/path/i);
    await asService(`select public.register_delivery_asset_bytes_v6(
      '${asset}','${CLIENT_A}/creative.png',repeat('a',64))`);
    const current = await one<{ entity_version_id: string }>(`select entity_version_id
      from public.delivery_entity_heads_v6 where client_id='${CLIENT_A}'
        and entity_kind='content_asset' and source_key='${asset}'`);
    await asService(`select public.link_delivery_work_output_v6(
      '${id}','content_production_factory','${current.entity_version_id}')`);
    await db.exec(`insert into public.approval_requests_v6
      (id,client_id,source_system,source_kind,source_id,source_version,
       title,artifact_hash,preview,scope,owner_role,expires_at,payload_hash)
      values ('${request}','${CLIENT_A}','test','asset','${asset}','1','Creative',
       repeat('a',64),'{}'::jsonb,'{}'::jsonb,'manager',
       now()+interval '1 day',repeat('a',64))`);
    await asService(`select public.bind_delivery_approval_dependency_v6(
      '${request}','${current.entity_version_id}')`);
    await asService(`select public.register_delivery_asset_bytes_v6(
      '${asset}','${CLIENT_A}/creative.png',repeat('b',64))`);
    const inbox = await one<{ status: string }>(`select status from
      public.approval_inbox_v6 where id='${request}'`);
    expect(inbox.status).toBe('stale');
    const workState = await one<{ effective_state: string }>(`select
      effective_state from public.delivery_work_effective_v6 where id='${id}'`);
    expect(workState.effective_state).toBe('held');
    await db.exec(`insert into storage.objects values
      ('${CLIENT_A}/creative.png','{"etag":"old"}'::jsonb)`);
    await db.exec(`update storage.objects set metadata='{"etag":"new"}'::jsonb
      where name='${CLIENT_A}/creative.png'`);
    const cleared = await one<{ delivery_bytes_sha256: string | null }>(`select
      delivery_bytes_sha256 from public.client_media_assets where id='${asset}'`);
    expect(cleared.delivery_bytes_sha256).toBeNull();
    await db.exec(`update public.client_media_assets
      set storage_path='${CLIENT_A}/new.png' where id='${asset}'`);
    const digest = await one<{ delivery_bytes_sha256: string | null }>(`select
      delivery_bytes_sha256 from public.client_media_assets where id='${asset}'`);
    expect(digest.delivery_bytes_sha256).toBeNull();
  });

  it("invalidates bound proof rights and destination settings", async () => {
    const proof = "14141414-1414-4414-8414-141414141414";
    const request = "15151515-1515-4515-8515-151515151515";
    await db.exec(`
      insert into public.client_proof_assets values
        ('${proof}','${CLIENT_A}','Review','approved',null,'consent');
      insert into public.client_proof_destinations values
        ('${CLIENT_A}','google_business_profile',true,'locations/1');
      insert into public.approval_requests_v6
        (id,client_id,source_system,source_kind,source_id,source_version,
         title,artifact_hash,preview,scope,owner_role,expires_at,payload_hash)
        values ('${request}','${CLIENT_A}','test','proof','${proof}','1','Proof',
          repeat('a',64),'{}'::jsonb,'{}'::jsonb,'manager',
          now()+interval '1 day',repeat('a',64));
    `);
    const versions = (await db.query<{ entity_version_id: string }>(`
      select entity_version_id from public.delivery_entity_heads_v6
      where client_id='${CLIENT_A}' and
        ((entity_kind='proof_source' and source_key='${proof}') or
         (entity_kind='destination' and source_key='${CLIENT_A}:google_business_profile'))
    `)).rows;
    expect(versions).toHaveLength(2);
    for (const version of versions) {
      await asService(`select public.bind_delivery_approval_dependency_v6(
        '${request}','${version.entity_version_id}')`);
    }
    await db.exec(`update public.client_proof_assets set usage_rights='revoked'
      where id='${proof}'`);
    await db.exec(`update public.client_proof_destinations set enabled=false
      where client_id='${CLIENT_A}' and destination_key='google_business_profile'`);
    const invalidations = await one<{ count: string }>(`select count(*)::text as count
      from public.delivery_approval_invalidations_v6
      where approval_request_id='${request}'`);
    expect(Number(invalidations.count)).toBe(2);
  });

  it("auto-binds campaign action proof, rights and destination versions", async () => {
    const proof = "16161616-1616-4616-8616-161616161616";
    const artifact = "17171717-1717-4717-8717-171717171717";
    const action = "18181818-1818-4818-8818-181818181818";
    const request = "19191919-1919-4919-8919-191919191919";
    await db.exec(`
      insert into public.client_proof_assets values
        ('${proof}','${CLIENT_A}','Review','approved',null,'consent');
      insert into public.proof_artifact_versions values
        ('${artifact}','${CLIENT_A}','${proof}',repeat('9',64));
      insert into public.client_proof_destinations values
        ('${CLIENT_A}','main_website',true,'example.com');
      insert into public.campaign_action_approvals
        (id,client_id,campaign_id,destination,artifact_version_hash)
        values ('${action}','${CLIENT_A}','${CAMPAIGN_A}',
          'main_website',repeat('9',64));
      insert into public.approval_requests_v6
        (id,client_id,source_system,source_kind,source_id,source_version,
         title,artifact_hash,preview,scope,owner_role,expires_at,payload_hash)
        values ('${request}','${CLIENT_A}','aa_console','campaign_action',
          '${action}','1','Place proof',repeat('9',64),'{}'::jsonb,
          '{}'::jsonb,'manager',now()+interval '1 day',repeat('9',64));
    `);
    const kinds = (await db.query<{ entity_kind: string }>(`
      select e.entity_kind from public.delivery_approval_dependencies_v6 d
      join public.delivery_entity_versions_v6 e on e.id=d.entity_version_id
      where d.approval_request_id='${request}'`)).rows.map((r) => r.entity_kind);
    for (const kind of ['campaign','proof_artifact','proof_source','destination']) {
      expect(kinds).toContain(kind);
    }
    await db.exec(`update public.client_proof_assets set usage_rights='revoked'
      where id='${proof}'`);
    const status = await one<{ status: string }>(`select status from
      public.approval_inbox_v6 where id='${request}'`);
    expect(status.status).toBe('stale');
  });

  it("keeps confirmed delivery factual and opens remediation after a source change", async () => {
    const model = "24242424-2424-4242-8242-242424242424";
    const request = "25252525-2525-4252-8252-252525252525";
    await db.exec(`insert into public.client_agent_records
      values ('${model}','${CLIENT_A}','{"claim":"first"}'::jsonb,now())`);
    const source = await one<{ entity_version_id: string }>(`select entity_version_id
      from public.delivery_entity_heads_v6 where client_id='${CLIENT_A}'
        and entity_kind='source_model' and source_key='${model}'`);
    const work = await asService<{ id: string }>(`select id from
      public.create_delivery_work_item_v6('${CAMPAIGN_A}',null,null,null,
        'confirmed_model',1,'intelligence_os',true,'{}'::jsonb,'{}'::jsonb)`);
    const id = work[0]!.id;
    await asService(`select public.bind_delivery_work_input_v6(
      '${id}','intelligence_os','${source.entity_version_id}')`);
    await asService(`select public.link_delivery_work_output_v6(
      '${id}','intelligence_os','${source.entity_version_id}')`);
    const hash = await one<{ digest: string }>(`select
      public.delivery_work_output_hash_v6('${id}') as digest`);
    await asService(`select public.advance_delivery_work_item_v6(
      '${id}','intelligence_os','prepared','{}'::jsonb)`);
    await asService(`select public.advance_delivery_work_item_v6(
      '${id}','intelligence_os','ready_for_review',
      jsonb_build_object('qa_state','passed','output_fingerprint','${hash.digest}'))`);
    await db.exec(`insert into public.approval_requests_v6
      (id,client_id,source_system,source_kind,source_id,source_version,
       title,artifact_hash,preview,scope,owner_role,expires_at,payload_hash)
      values ('${request}','${CLIENT_A}','test','model','${model}','1','Model',
       '${hash.digest}','{}'::jsonb,'{}'::jsonb,'manager',
       now()+interval '1 day',repeat('a',64))`);
    await asService(`select public.bind_delivery_approval_dependency_v6(
      '${request}','${source.entity_version_id}')`);
    await db.exec(`insert into public.approval_decision_events_v6
      (request_id,decision) values ('${request}','approved')`);
    await asService(`select public.advance_delivery_work_item_v6(
      '${id}','intelligence_os','approved',
      jsonb_build_object('approval_request_id','${request}'))`);
    await asService(`select public.advance_delivery_work_item_v6(
      '${id}','intelligence_os','execution_due','{}'::jsonb)`);
    await asService(`select public.advance_delivery_work_item_v6(
      '${id}','intelligence_os','attempted','{"attempt_count":1}'::jsonb)`);
    await asService(`select public.advance_delivery_work_item_v6(
      '${id}','intelligence_os','externally_confirmed',
      '{"external_result":{"external_id":"provider-1"}}'::jsonb)`);
    await db.exec(`update public.client_agent_records
      set content='{"claim":"changed"}'::jsonb where id='${model}'`);
    const effective = await one<{ effective_state: string; effective_blocker: string }>(`
      select effective_state,effective_blocker from public.delivery_work_effective_v6
      where id='${id}'`);
    expect(effective.effective_state).toBe('externally_confirmed');
    expect(effective.effective_blocker).toMatch(/remediation/i);
    const task = await one<{ external_use_kind: string }>(`select external_use_kind
      from public.delivery_remediation_tasks_v6
      where approval_request_id='${request}'`);
    expect(task.external_use_kind).toBe('delivery_work_item');
  });
});
