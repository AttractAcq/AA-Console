import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const POST = "22222222-2222-4222-8222-222222222222";
const SLOT = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
const BRIEF = "55555555-5555-4555-8555-555555555555";
const IDEA = "66666666-6666-4666-8666-666666666666";
const CAMPAIGN = "77777777-7777-4777-8777-777777777777";
const SHA = "a".repeat(64);
const SOURCE = `${CLIENT}/media.png`;
const FROZEN = `${CLIENT}/${SHA}`;
let db: PGlite;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]!;
}

beforeAll(async () => {
  db = new PGlite();
  try { await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage; create schema cron;
    create function auth.role() returns text language sql stable as
      $$select current_setting('request.jwt.claim.role',true)$$;
    create function public.can_access_client(uuid) returns boolean language sql stable as
      $$select true$$;
    create function public.integration_usable(uuid,text) returns boolean language sql stable as
      $$select true$$;
    create function public.integration_state_eligible(text,timestamptz)
      returns boolean language sql stable as
      $$select $1 in ('connected','active','expiring')
        and ($2 is null or $2 > now())$$;
    create function public.lock_down_definer_functions() returns integer language sql as
      $$select 0$$;
    create function public.reject_approval_ledger_mutation_v6() returns trigger
      language plpgsql as $$begin raise exception 'append-only'; end;$$;
    create table storage.buckets(id text primary key,name text,public boolean,
      file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),
      bucket_id text,name text,metadata jsonb);
    create table cron.job(jobname text primary key);
    create function cron.unschedule(text) returns boolean language sql as
      $$delete from cron.job where jobname=$1 returning true$$;
    create function cron.schedule(text,text,text) returns bigint language plpgsql as
      $$begin insert into cron.job(jobname) values ($1); return 1; end;$$;
    create type post_platform as enum ('instagram','facebook');
    create type post_channel as enum ('organic','paid');
    create type media_type as enum ('image','video');
    create type content_format as enum ('single','carousel','story','reel');
    create type review_status as enum ('pending','approved','rejected');
    create type slot_stage as enum ('planned','awaiting_approval','scheduled');
    create table clients(id uuid primary key,name text);
    create table client_campaigns(id uuid primary key,client_id uuid,
      acquisition_mode text,paid_platform text);
    create table client_ideas(id uuid primary key,client_id uuid,campaign_id uuid);
    create table client_briefs(id uuid primary key,client_id uuid,source_idea_id uuid);
    create table client_media_assets(id uuid primary key,client_id uuid,brief_id uuid,
      title text,storage_path text,render_path text,review_status review_status,
      human_approved_at timestamptz,content_format content_format,media_type media_type,
      usage_rights text,intake_source text);
    create table scheduled_posts(id uuid primary key,client_id uuid,asset_id uuid,
      scheduled_at timestamptz,scheduled_for date,channel post_channel,
      platform post_platform,media_type media_type,publication_status text,
      publish_attempts int default 0,publish_claimed_at timestamptz,
      published_at timestamptz);
    create table content_slots(id uuid primary key,client_id uuid,asset_id uuid,
      brief_id uuid,idea_id uuid,platform post_platform,scheduled_post_id uuid,
      scheduled_at timestamptz,stage slot_stage);
    create table client_media_frames(asset_id uuid,position int,storage_path text);
    create table post_copy_effective(scheduled_post_id uuid,platform post_platform,
      caption text,hashtags text[],alt_text text,link_url text,first_comment text);
    create table client_integrations(client_id uuid,provider text,status text,
      credential_secret_id uuid,credential_label text,meta_page_id text,
      token_expires_at timestamptz);
    create table platform_publishing(platform post_platform,provider text,supported boolean);
    create table platform_format_publishing(platform post_platform,
      content_format content_format,media_type media_type,supported boolean);
    create table client_engine_settings(client_id uuid,publishing_enabled boolean);
    create table agents(agent_key text primary key,name text,initials text,domain text,
      description text,requires_upstream text[],requires_input boolean);
    create table agent_jobs(id uuid primary key default gen_random_uuid(),
      agent_key text,params jsonb,status text default 'queued');
    create table approval_requests_v6(id uuid primary key default gen_random_uuid(),
      client_id uuid,source_system text,source_kind text,source_id text,
      source_version text,title text,requested_at timestamptz default now(),
      requested_by uuid,requester_kind text,requester_ref text,expires_at timestamptz,
      artifact_hash text,preview jsonb,destination text,account_ref text,
      budget jsonb,scope jsonb,owner_role text,preview_blocker text,owning_path text);
    create table approval_request_evidence_v6(id uuid,request_id uuid,
      artifact_hash text,preview jsonb,destination text,account_ref text,
      budget jsonb,scope jsonb);
    create table approval_decision_events_v6(request_id uuid,event_order int,decision text);
    create table approval_class_coverage_versions_v6(class_id int,revision int,
      class_key text,title text,source_state text,source_evidence text,
      decision_state text,decision_evidence text,executor_state text,
      executor_evidence text,blocker text);
    create function public.can_review_approval_request_v6(uuid,text) returns boolean
      language sql stable as $$select true$$;
    create function public.approval_source_state_v6(uuid) returns text
      language sql stable as $$select 'unverified'::text$$;
    create function public.production_release_source_state_v6(uuid) returns text
      language sql stable as $$select 'source_held'::text$$;
    create function public.recruitment_meta_build_source_state_v6(uuid) returns text
      language sql stable as $$select 'source_held'::text$$;
    create function public.register_approval_request_v6(p jsonb) returns uuid
      language plpgsql as $$declare v_id uuid; begin
        insert into approval_requests_v6(client_id,source_system,source_kind,
          source_id,source_version,title,requester_kind,requester_ref,expires_at,
          artifact_hash,preview,destination,account_ref,scope,owner_role,
          preview_blocker,owning_path)
          values ((p->>'client_id')::uuid,p->>'source_system',p->>'source_kind',
            p->>'source_id',p->>'source_version',p->>'title',p->>'requester_kind',
            p->>'requester_ref',(p->>'expires_at')::timestamptz,
            p->>'artifact_hash',p->'preview',p->>'destination',p->>'account_ref',
            p->'scope',p->>'owner_role',p->>'preview_blocker',p->>'owning_path')
          returning id into v_id; return v_id; end;$$;
    insert into clients values ('${CLIENT}','Harbour');
    insert into client_campaigns values ('${CAMPAIGN}','${CLIENT}','organic',null);
    insert into client_ideas values ('${IDEA}','${CLIENT}','${CAMPAIGN}');
    insert into client_briefs values ('${BRIEF}','${CLIENT}','${IDEA}');
    insert into client_media_assets values ('${ASSET}','${CLIENT}','${BRIEF}',
      'Image','${SOURCE}',null,'approved',now(),'single','image',null,null);
    insert into scheduled_posts values ('${POST}','${CLIENT}','${ASSET}',
      now()-interval '1 hour',current_date,'organic','instagram','image','scheduled',0,null,null);
    insert into content_slots values ('${SLOT}','${CLIENT}','${ASSET}',
      '${BRIEF}','${IDEA}','instagram','${POST}',now()-interval '1 hour','scheduled');
    update content_slots set scheduled_at=(select scheduled_at from scheduled_posts where id='${POST}');
    insert into post_copy_effective values ('${POST}','instagram','The exact caption',
      array['#proof'],'An image',null,null);
    insert into client_integrations values ('${CLIENT}','instagram','connected',
      gen_random_uuid(),'123456789',null,null);
    insert into platform_publishing values ('instagram','instagram',true);
    insert into platform_format_publishing values ('instagram','single',null,true);
    insert into client_engine_settings values ('${CLIENT}',true);
    insert into storage.objects(bucket_id,name) values ('publication-media','${FROZEN}');
    select set_config('request.jwt.claim.role','service_role',false);
  `); } catch (error) { throw new Error(`fixture failed: ${String(error)}`); }
  const source = await readFile(new URL(
    "../../supabase/migrations/20261101090000_295_organic_publication_package_boundary.sql",
    import.meta.url,
  ), "utf8");
  try { await db.exec(source); } catch (error) {
    throw new Error(`migration 292 failed: ${JSON.stringify(error, Object.getOwnPropertyNames(error as Error))}`);
  }
}, 60000);

afterAll(async () => { await db?.close(); });

describe("held exact organic publication package", () => {
  it("holds even a valid legacy Engine slot before claim or provider prewrite", async () => {
    const due = await one<{ blocker: string }>(
      `select blocker from publish_due where post_id='${POST}'`);
    expect(due.blocker).toMatch(/No immutable outgoing media-byte package/);
    expect((await db.query("select * from claim_posts_for_publishing(5)")).rows).toHaveLength(0);
    await expect(db.query(`select require_organic_publication_prewrite_v6('${POST}')`))
      .rejects.toThrow(/exact Inbox decision/);
    await db.exec(`
      insert into platform_publishing values ('facebook','meta',true);
      insert into platform_format_publishing values ('facebook','single',null,true);
      insert into client_integrations values ('${CLIENT}','meta','connected',
        gen_random_uuid(),null,'page-42',null);
      update scheduled_posts set platform='facebook' where id='${POST}';
      update content_slots set platform='facebook' where id='${SLOT}';
      update post_copy_effective set platform='facebook' where scheduled_post_id='${POST}';
    `);
    const facebook = await one<{ payload: { provider: string; account_ref: string } }>(
      `select organic_publication_source_snapshot_v6('${POST}') as payload`);
    expect(facebook.payload).toMatchObject({ provider: "meta", account_ref: "page-42" });
    await db.exec(`
      update scheduled_posts set platform='instagram' where id='${POST}';
      update content_slots set platform='instagram' where id='${SLOT}';
      update post_copy_effective set platform='instagram' where scheduled_post_id='${POST}';
      update client_integrations set status='expiring',
        token_expires_at=now()+interval '1 hour' where provider='instagram';
    `);
    expect((await one<{ payload: unknown }>(
      `select organic_publication_source_snapshot_v6('${POST}') as payload`)).payload)
      .not.toBeNull();
    await db.exec(`update client_integrations set token_expires_at=now()-interval '1 second'
      where provider='instagram'`);
    expect((await one<{ payload: unknown }>(
      `select organic_publication_source_snapshot_v6('${POST}') as payload`)).payload)
      .toBeNull();
    await db.exec(`update client_integrations set status='connected',token_expires_at=null
      where provider='instagram'`);
  });

  it("registers downloaded-byte evidence and an explicitly blocked unified Inbox card, idempotently", async () => {
    const candidate = await one<{ post_id: string; platform: string; copy: { caption: string }; source_paths: string[]; source_snapshot_hash: string }>(
      "select * from organic_publication_package_candidates_v6(5)");
    expect(candidate.post_id).toBe(POST);
    expect(candidate.platform).toBe("instagram");
    expect(candidate.copy.caption).toBe("The exact caption");
    expect(candidate.source_paths).toEqual([SOURCE]);
    const media = [{ source_path: SOURCE, frozen_bucket: "publication-media",
      frozen_path: FROZEN, sha256: SHA, byte_size: 123, mime_type: "image/png" }];
    const providerCopy = { caption: "The exact caption\n\n#proof", first_comment: null };
    const sql = "select register_organic_publication_package_v6($1,$2,$3::jsonb,$4::jsonb) as id";
    let first: { id: string };
    try {
      first = await one<{ id: string }>(sql,
        [POST, candidate.source_snapshot_hash, JSON.stringify(media), JSON.stringify(providerCopy)]);
    } catch (error) {
      throw new Error(`registration failed: ${JSON.stringify(error, Object.getOwnPropertyNames(error as Error))}`);
    }
    const again = await one<{ id: string }>(sql,
      [POST, candidate.source_snapshot_hash, JSON.stringify(media), JSON.stringify(providerCopy)]);
    expect(again.id).toBe(first.id);
    const card = await one<{ source_version: string; preview: { media: unknown[]; provider_copy: unknown }; preview_blocker: string }>(
      "select source_version,preview,preview_blocker from approval_requests_v6 where source_kind='organic_publication'");
    expect(card.source_version).toMatch(/^[0-9a-f]{64}$/);
    expect(card.preview_blocker).toMatch(/rights provenance/i);
    expect(card.preview.media).toHaveLength(1);
    expect(card.preview.provider_copy).toEqual(providerCopy);
    expect((await one<{ status: string; source_state: string }>(
      "select status,source_state from approval_inbox_v6 where source_kind='organic_publication'")))
      .toMatchObject({ status: "source_held", source_state: "source_held" });
    await db.exec(`
      create or replace function public.can_review_approval_request_v6(uuid,text)
      returns boolean language sql stable as $$select null::boolean$$;
      select set_config('request.jwt.claim.role','authenticated',false);
    `);
    const requestRow = await one<{ id: string }>(
      "select id from approval_requests_v6 where source_kind='organic_publication'");
    expect((await one<{ source_state: string }>(
      "select organic_publication_source_state_v6($1) as source_state", [requestRow.id]))
      .source_state).toBe("unverified");
    await db.exec(`
      select set_config('request.jwt.claim.role','service_role',false);
      create or replace function public.can_review_approval_request_v6(uuid,text)
      returns boolean language sql stable as $$select true$$;
    `);
    expect((await db.query("select * from organic_publication_package_candidates_v6(5)")).rows)
      .toHaveLength(0);
    expect((await one<{ blocker: string }>(
      `select blocker from publish_due where post_id='${POST}'`)).blocker)
      .toMatch(/held until its exact AAL2 Inbox decision/);
    await expect(db.query(sql, [POST, candidate.source_snapshot_hash,
      JSON.stringify([{ ...media[0], sha256: "b".repeat(64), frozen_path: `${CLIENT}/${"b".repeat(64)}` }]),
      JSON.stringify(providerCopy)]))
      .rejects.toThrow();
    await db.exec(`update post_copy_effective set caption='Changed words' where scheduled_post_id='${POST}'`);
    expect((await one<{ source_state: string }>(
      "select source_state from approval_inbox_v6 where source_kind='organic_publication'"))
      .source_state).toBe("superseded");
    await db.exec(`update post_copy_effective set caption='The exact caption' where scheduled_post_id='${POST}'`);
    const missing = await one<{ id: string }>(`
      insert into approval_requests_v6(client_id,source_system,source_kind,source_id)
      values ('${CLIENT}','aa_console','organic_publication',
        '99999999-9999-4999-8999-999999999999') returning id`);
    expect((await one<{ source_state: string }>(
      "select organic_publication_source_state_v6($1) as source_state", [missing.id]))
      .source_state).toBe("cancelled");
  });

  it("rejects package and Storage byte mutation; paid route stays blocked", async () => {
    await expect(db.exec(`update organic_publication_packages_v6 set manifest='{}'::jsonb`))
      .rejects.toThrow(/append-only/);
    await expect(db.exec(`delete from storage.objects where name='${FROZEN}'`))
      .rejects.toThrow(/Frozen publication media/);
    await db.exec(`update client_campaigns set acquisition_mode='paid',paid_platform='meta'`);
    expect((await one<{ blocker: string }>(
      `select blocker from publish_due where post_id='${POST}'`)).blocker)
      .toMatch(/paid campaign/);
    expect((await db.query("select * from organic_publication_package_candidates_v6(5)")).rows)
      .toHaveLength(0);
  });

  it("makes only a current rights-bearing frozen package reviewable", async () => {
    await db.exec(`update client_campaigns set acquisition_mode='organic',paid_platform=null;
      update client_media_assets set usage_rights='client_owned' where id='${ASSET}';`);
    const candidate = await one<{ source_snapshot_hash: string }>(
      "select source_snapshot_hash from organic_publication_package_candidates_v6(5)");
    const media = [{ source_path: SOURCE, frozen_bucket: "publication-media",
      frozen_path: FROZEN, sha256: SHA, byte_size: 123, mime_type: "image/png" }];
    const { id: packageId } = await one<{ id: string }>(
      "select register_organic_publication_package_v6($1,$2,$3::jsonb,$4::jsonb) as id",
      [POST, candidate.source_snapshot_hash, JSON.stringify(media),
        JSON.stringify({ caption: "The exact caption\n\n#proof", first_comment: null })]);
    const migration = await readFile(new URL(
      "../../supabase/migrations/20261124042100_586_organic_publication_exact_review.sql",
      import.meta.url,
    ), "utf8");
    await db.exec(migration.slice(0, migration.indexOf("-- The canonical Inbox keeps")));
    const { id: requestId } = await one<{ id: string }>(
      "select id from approval_requests_v6 where source_id=$1", [packageId]);
    expect((await one<{ state: string }>(
      "select organic_publication_source_state_v6($1) as state", [requestId])).state)
      .toBe("pending");
    await db.exec(`update post_copy_effective set caption='Changed after review'
      where scheduled_post_id='${POST}'`);
    expect((await one<{ state: string }>(
      "select organic_publication_source_state_v6($1) as state", [requestId])).state)
      .toBe("superseded");
  });

  it("attests only a current claimed post with the exact AAL2 decision while claim stays closed", async () => {
    await db.exec(`
      update post_copy_effective set caption='The exact caption'
        where scheduled_post_id='${POST}';
      alter table approval_decision_events_v6
        add column actor_aal text,
        add column artifact_hash text,
        add column source_decision_ref text;
    `);
    const migration = await readFile(new URL(
      "../../supabase/migrations/20261124042200_587_organic_publication_claimed_prewrite.sql",
      import.meta.url,
    ), "utf8");
    await db.exec(migration);
    const row = await one<{ id: string; artifact_hash: string; request_id: string }>(`
      select p.id,p.artifact_hash,q.id as request_id
      from organic_publication_packages_v6 p
      join approval_requests_v6 q on q.source_id=p.id::text
      where p.scheduled_post_id='${POST}'
      order by q.requested_at desc limit 1`);
    await expect(db.query(`select require_organic_publication_prewrite_v6('${POST}')`))
      .rejects.toThrow(/no current organic publication claim/);
    await db.exec(`update scheduled_posts set publication_status='publishing',
      publish_claimed_at=now(),publish_attempts=1 where id='${POST}'`);
    expect((await one<{ payload: unknown }>(
      `select organic_publication_source_snapshot_v6('${POST}') as payload`)).payload)
      .toBeNull();
    expect((await one<{ payload: unknown }>(
      `select organic_publication_claim_snapshot_v7('${POST}') as payload`)).payload)
      .not.toBeNull();
    await expect(db.query(`select require_organic_publication_prewrite_v6('${POST}')`))
      .rejects.toThrow(/AAL2 publication approval/);
    await db.query(`insert into approval_decision_events_v6
      (request_id,event_order,decision,actor_aal,artifact_hash,source_decision_ref)
      values ($1,1,'approved','aal2',$2,$3)`,
      [row.request_id,row.artifact_hash,`organic_publication_packages_v6:${row.id}`]);
    const approved = await one<{ packet: { artifact_hash: string; manifest: { scheduled_post_id: string } } }>(
      `select require_organic_publication_prewrite_v6('${POST}') as packet`);
    expect(approved.packet.artifact_hash).toBe(row.artifact_hash);
    expect(approved.packet.manifest.scheduled_post_id).toBe(POST);
    expect((await db.query("select * from claim_posts_for_publishing(5)")).rows)
      .toHaveLength(0);
    await db.exec(`update client_engine_settings set publishing_enabled=false
      where client_id='${CLIENT}'`);
    await expect(db.query(`select require_organic_publication_prewrite_v6('${POST}')`))
      .rejects.toThrow(/switch is off/);
    await db.exec(`update client_engine_settings set publishing_enabled=true
      where client_id='${CLIENT}';
      update post_copy_effective set caption='Changed after approval'
      where scheduled_post_id='${POST}'`);
    await expect(db.query(`select require_organic_publication_prewrite_v6('${POST}')`))
      .rejects.toThrow(/frozen package is missing, stale or unlicensed/);
    await db.exec(`update post_copy_effective set caption='The exact caption'
      where scheduled_post_id='${POST}';
      update approval_requests_v6 set expires_at=now()-interval '1 second'
      where id='${row.request_id}'`);
    await expect(db.query(`select require_organic_publication_prewrite_v6('${POST}')`))
      .rejects.toThrow(/review is stale or expired/);
    await db.exec(`update approval_requests_v6 set expires_at=now()+interval '1 day'
      where id='${row.request_id}'`);
    await db.query(`insert into approval_decision_events_v6
      (request_id,event_order,decision,actor_aal,artifact_hash,source_decision_ref)
      values ($1,2,'revoked','aal2',$2,$3)`,
      [row.request_id,row.artifact_hash,`organic_publication_packages_v6:${row.id}`]);
    await expect(db.query(`select require_organic_publication_prewrite_v6('${POST}')`))
      .rejects.toThrow(/AAL2 publication approval/);
  });

  it("binds a both-route organic idea to the current organic package and refuses drift", async () => {
    await db.exec(`
      alter table client_campaigns add column runs_organic boolean default false;
      alter table client_ideas add column acquisition_route text;
      create table campaign_route_packages_v6(
        id uuid primary key,client_id uuid,campaign_id uuid,route text,
        version int,plan_fingerprint text);
      create function public.campaign_plan_fingerprint(public.client_campaigns)
        returns text language sql stable as $$select 'f'::text$$;
      update client_campaigns set acquisition_mode='both',paid_platform='meta',
        runs_organic=true where id='${CAMPAIGN}';
      update client_ideas set acquisition_route='organic' where id='${IDEA}';
      insert into campaign_route_packages_v6 values
        ('88888888-8888-4888-8888-888888888888','${CLIENT}','${CAMPAIGN}',
          'organic',1,'f');
      update scheduled_posts set publication_status='scheduled',publish_claimed_at=null
        where id='${POST}';
    `);
    const migration = await readFile(new URL(
      "../../supabase/migrations/20261124042300_588_organic_publication_route_package.sql",
      import.meta.url,
    ), "utf8");
    await db.exec(migration);
    const source = await one<{ packet: { route_package_id: string; route_package_version: number } }>(
      `select organic_publication_source_snapshot_v6('${POST}') as packet`);
    expect(source.packet).toMatchObject({
      route_package_id: "88888888-8888-4888-8888-888888888888",
      route_package_version: 1,
    });
    await db.exec(`update client_ideas set acquisition_route='paid' where id='${IDEA}'`);
    expect((await one<{ packet: unknown }>(
      `select organic_publication_source_snapshot_v6('${POST}') as packet`)).packet).toBeNull();
    await db.exec(`update client_ideas set acquisition_route='organic' where id='${IDEA}';
      update campaign_route_packages_v6 set plan_fingerprint='stale'`);
    expect((await one<{ packet: unknown }>(
      `select organic_publication_source_snapshot_v6('${POST}') as packet`)).packet).toBeNull();
    await db.exec(`update campaign_route_packages_v6 set plan_fingerprint='f';
      update scheduled_posts set publication_status='publishing',
        publish_claimed_at=now() where id='${POST}'`);
    const claimed = await one<{ packet: { route_package_id: string } }>(
      `select organic_publication_claim_snapshot_v7('${POST}') as packet`);
    expect(claimed.packet.route_package_id).toBe(source.packet.route_package_id);
    expect((await db.query("select * from claim_posts_for_publishing(5)")).rows).toHaveLength(0);
  });

  it("leases only an exact approved package and rolls back a stale claim", async () => {
    await db.exec(`
      create table delivery_approval_invalidations_v6(
        approval_request_id uuid primary key,invalidated_at timestamptz default now());
      alter table scheduled_posts add column updated_at timestamptz default now();
      update scheduled_posts set publication_status='scheduled',publish_claimed_at=null
        where id='${POST}';
    `);
    const migration = await readFile(new URL(
      "../../supabase/migrations/20261124042400_589_organic_publication_approved_claim.sql",
      import.meta.url,
    ), "utf8");
    await db.exec(migration);
    const candidate = await one<{ source_snapshot_hash: string }>(
      "select source_snapshot_hash from organic_publication_package_candidates_v6(5)");
    const media = [{ source_path: SOURCE, frozen_bucket: "publication-media",
      frozen_path: FROZEN, sha256: SHA, byte_size: 123, mime_type: "image/png" }];
    const { id: packageId } = await one<{ id: string }>(
      "select register_organic_publication_package_v6($1,$2,$3::jsonb,$4::jsonb) as id",
      [POST, candidate.source_snapshot_hash, JSON.stringify(media),
        JSON.stringify({ caption: "The exact caption\n\n#proof", first_comment: null })]);
    const { id: requestId, artifact_hash: artifactHash } = await one<{
      id: string; artifact_hash: string;
    }>("select id,artifact_hash from approval_requests_v6 where source_id=$1", [packageId]);
    expect((await one<{ blocker: string }>(
      `select blocker from publish_due where post_id='${POST}'`)).blocker)
      .toMatch(/no current exact AAL2 approval/);
    expect((await db.query("select * from claim_posts_for_publishing(5)")).rows).toHaveLength(0);
    await db.query(`insert into approval_decision_events_v6
      (request_id,event_order,decision,actor_aal,artifact_hash,source_decision_ref)
      values ($1,1,'approved','aal2',$2,$3)`,
      [requestId,artifactHash,`organic_publication_packages_v6:${packageId}`]);
    expect((await one<{ blocker: string | null }>(
      `select blocker from publish_due where post_id='${POST}'`)).blocker).toBeNull();
    await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
    await expect(db.query("select * from claim_posts_for_publishing(5)"))
      .rejects.toThrow(/Posts are claimed by the publisher/);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    const claims = (await db.query<{ post_id: string; attempt: number }>(
      "select * from claim_posts_for_publishing(5)")).rows;
    expect(claims).toMatchObject([{ post_id: POST, attempt: 2 }]);
    expect((await db.query("select * from claim_posts_for_publishing(5)")).rows).toHaveLength(0);
    await db.query("insert into delivery_approval_invalidations_v6(approval_request_id) values ($1)",
      [requestId]);
    await expect(db.query(`select require_organic_publication_prewrite_v6('${POST}')`))
      .rejects.toThrow(/approval was invalidated/);
    await db.exec(`update scheduled_posts set publication_status='scheduled',
      publish_claimed_at=null where id='${POST}'`);
    expect((await db.query("select * from claim_posts_for_publishing(5)")).rows).toHaveLength(0);
  });

  it("records provider acknowledgement and account read-back separately", async () => {
    await db.exec(`
      alter table scheduled_posts add column external_id text;
      create table post_frame_publications(
        post_id uuid,client_id uuid,position integer,external_id text,
        primary key(post_id,position));
      update scheduled_posts set publication_status='published',external_id='123'
        where id='${POST}';
    `);
    const migration = await readFile(new URL(
      "../../supabase/migrations/20261124042500_590_organic_provider_readback.sql",
      import.meta.url,
    ), "utf8");
    await db.exec(migration);
    expect((await db.query("select * from organic_provider_readback_latest_v8")).rows)
      .toHaveLength(0);
    const args = [POST,0,"123","123456789","123456789","verified",
      "https://www.instagram.com/p/ABC/"];
    await db.query("select record_organic_provider_readback_v8($1,$2,$3,$4,$5,$6,$7)", args);
    expect(await one<{ state: string; observed_account_ref: string }>(
      "select state,observed_account_ref from organic_provider_readback_latest_v8"))
      .toMatchObject({ state: "verified", observed_account_ref: "123456789" });
    await expect(db.query(
      "select record_organic_provider_readback_v8($1,$2,$3,$4,$5,$6,$7)",
      [POST,0,"other","123456789","123456789","verified",null],
    )).rejects.toThrow(/acknowledgement is missing/);
    await expect(db.query(
      "select record_organic_provider_readback_v8($1,$2,$3,$4,$5,$6,$7)",
      [POST,0,"123","123456789","123456789","verified","https://example.com/"],
    )).rejects.toThrow(/URL is inconsistent/);
    await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
    await expect(db.query(
      "select record_organic_provider_readback_v8($1,$2,$3,$4,$5,$6,$7)", args,
    )).rejects.toThrow(/Only the publisher/);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    await expect(db.exec("delete from organic_provider_readback_events_v8"))
      .rejects.toThrow(/append-only/);
  });

  it("holds both publication snapshots when the creative source signoff is stale", async () => {
    await db.exec(`
      update scheduled_posts set publication_status='scheduled',published_at=null,
        publish_claimed_at=null where id='${POST}';
      create function public.ordinary_media_signoff_current_v6(uuid)
      returns boolean language sql stable as
        $$select current_setting('test.signoff_current',true)='on'$$;
      select set_config('test.signoff_current','on',false);
    `);
    const migration = await readFile(new URL(
      "../../supabase/migrations/20261124044000_605_organic_source_signoff_gate.sql",
      import.meta.url,
    ), "utf8");
    await db.exec(migration);
    const blockerMigration = await readFile(new URL(
      "../../supabase/migrations/20261124044100_606_publish_due_source_blocker.sql",
      import.meta.url,
    ), "utf8");
    await db.exec(blockerMigration);
    expect((await one<{ packet: unknown }>(
      `select organic_publication_source_snapshot_v6('${POST}') as packet`)).packet)
      .not.toBeNull();
    await db.exec("select set_config('test.signoff_current','off',false)");
    expect((await one<{ packet: unknown }>(
      `select organic_publication_source_snapshot_v6('${POST}') as packet`)).packet)
      .toBeNull();
    expect((await one<{ blocker: string }>(
      `select blocker from publish_due where post_id='${POST}'`)).blocker)
      .toMatch(/exact creative source signoff is missing or stale/);
    await db.exec(`update scheduled_posts set publication_status='publishing',
      publish_claimed_at=now() where id='${POST}';
      select set_config('test.signoff_current','on',false);`);
    expect((await one<{ packet: unknown }>(
      `select organic_publication_claim_snapshot_v7('${POST}') as packet`)).packet)
      .not.toBeNull();
    await db.exec("select set_config('test.signoff_current','off',false)");
    expect((await one<{ packet: unknown }>(
      `select organic_publication_claim_snapshot_v7('${POST}') as packet`)).packet)
      .toBeNull();
    await db.exec(`update client_media_assets set render_path='${CLIENT}/render.png'
      where id='${ASSET}';
      update scheduled_posts set publication_status='scheduled',publish_claimed_at=null
      where id='${POST}';
      select set_config('test.signoff_current','on',false);`);
    expect((await one<{ packet: { source_paths: string[] } }>(
      `select organic_publication_source_snapshot_v6('${POST}') as packet`)).packet.source_paths)
      .toEqual([`${CLIENT}/render.png`]);
    await db.exec("select set_config('test.signoff_current','off',false)");
    expect((await one<{ packet: unknown }>(
      `select organic_publication_source_snapshot_v6('${POST}') as packet`)).packet)
      .toBeNull();
    expect((await one<{ blocker: string }>(
      `select blocker from publish_due where post_id='${POST}'`)).blocker)
      .toMatch(/exact creative source signoff is missing or stale/);
  });
});
