import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = new URL("../../supabase/migrations/", import.meta.url);
const migration = (name: string) => readFile(new URL(name, ROOT), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
const BRIEF = "55555555-5555-4555-8555-555555555555";
const IDEA = "66666666-6666-4666-8666-666666666666";
const CAMPAIGN = "77777777-7777-4777-8777-777777777777";
const POST = "88888888-8888-4888-8888-888888888888";
const SLOT = "99999999-9999-4999-8999-999999999999";
const PAID_IDEA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAID_CAMPAIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: PGlite;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]!;
}

async function asPublisher<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false)");
  }
}

async function chain(mode: "organic" | "paid" | "legacy" = "organic") {
  await db.exec(`
    insert into client_campaigns(id, client_id, acquisition_mode, paid_platform)
      values ('${CAMPAIGN}', '${CLIENT}', '${mode}', ${mode === "paid" ? "'meta'" : "null"});
    insert into client_ideas(id, client_id, campaign_id)
      values ('${IDEA}', '${CLIENT}', '${CAMPAIGN}');
    insert into client_briefs(id, client_id, source_idea_id)
      values ('${BRIEF}', '${CLIENT}', '${IDEA}');
    insert into client_media_assets(id, client_id, brief_id, title, storage_path, review_status, human_approved_at)
      values ('${ASSET}', '${CLIENT}', '${BRIEF}', 'Proof', 'assets/proof.jpg', 'approved', now());
  `);
}

async function post(channel: "organic" | "paid" = "organic", withSlot = true) {
  await db.exec(`
    insert into scheduled_posts(id, client_id, asset_id, channel, platform, scheduled_for, scheduled_at, media_type)
      values ('${POST}', '${CLIENT}', '${ASSET}', '${channel}', 'instagram', current_date - 1,
              now() - interval '1 hour', 'image');
    insert into post_copy_effective(scheduled_post_id, platform, caption)
      values ('${POST}', 'instagram', 'A verified client result.');
  `);
  if (withSlot) await db.exec(`
    insert into content_slots(id, client_id, asset_id, brief_id, idea_id, platform, scheduled_post_id, stage)
      values ('${SLOT}', '${CLIENT}', '${ASSET}', '${BRIEF}', '${IDEA}', 'instagram', '${POST}', 'scheduled');
  `);
}

const blocker = () => one<{ blocker: string | null }>(
  "select blocker from publish_due where post_id = $1", [POST],
).then((r) => r.blocker);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function can_access_client(p_client_id uuid) returns boolean language sql stable as
      $$ select case when current_setting('test.access', true) = 'null' then null::boolean
                    else p_client_id = '${CLIENT}'::uuid and current_setting('test.access', true) <> 'off' end $$;
    create function client_timezone(uuid) returns text language sql stable as
      $$ select 'Europe/London'::text $$;
    create function integration_usable(uuid, text) returns boolean language sql stable as
      $$ select true $$;
    create function lock_down_definer_functions() returns integer language sql as
      $$ select 0 $$;
    create type post_platform as enum ('instagram', 'facebook');
    create type post_channel as enum ('organic', 'paid');
    create type media_type as enum ('image', 'video', 'text');
    create type content_format as enum ('single', 'carousel', 'story', 'reel');
    create type review_status as enum ('pending', 'approved', 'rejected');
    create table clients(id uuid primary key, name text);
    create table client_campaigns(id uuid primary key, client_id uuid, acquisition_mode text not null,
      paid_platform text, cloned_from_campaign_id uuid);
    create table client_ideas(id uuid primary key, client_id uuid, campaign_id uuid);
    create table client_briefs(id uuid primary key, client_id uuid, source_idea_id uuid);
    create table client_media_assets(id uuid primary key, client_id uuid, brief_id uuid,
      title text, storage_path text, render_path text, content_format content_format default 'single',
      review_status review_status, human_approved_at timestamptz);
    create table scheduled_posts(id uuid primary key default gen_random_uuid(), client_id uuid,
      asset_id uuid, ref_number text, scheduled_for date, scheduled_at timestamptz,
      channel post_channel not null default 'organic', platform post_platform,
      media_type media_type not null default 'image', publication_status text not null default 'scheduled',
      publish_attempts integer not null default 0, publish_claimed_at timestamptz,
      published_at timestamptz, created_by uuid, updated_at timestamptz default now());
    create function sync_scheduled_post_from_asset() returns trigger language plpgsql
      set search_path to 'public' as $$
      begin
        if new.asset_id is not null then
          select a.client_id into new.client_id from client_media_assets a where a.id = new.asset_id;
        end if;
        return new;
      end $$;
    create trigger sp_sync_asset before insert or update on scheduled_posts
      for each row execute function sync_scheduled_post_from_asset();
    create table content_slots(id uuid primary key, client_id uuid, asset_id uuid, brief_id uuid,
      idea_id uuid, platform post_platform, scheduled_post_id uuid, stage text);
    create table client_engine_settings(client_id uuid primary key, publishing_enabled boolean);
    create table platform_publishing(platform post_platform primary key, provider text, supported boolean);
    create table platform_format_publishing(platform post_platform, content_format content_format,
      media_type media_type, supported boolean, note text);
    create table client_media_frames(asset_id uuid, position integer, storage_path text);
    create table post_copy_effective(scheduled_post_id uuid, platform post_platform, caption text,
      hashtags text[], alt_text text, link_url text, first_comment text);
    insert into clients values ('${CLIENT}', 'Harbour'), ('${OTHER}', 'Beacon');
    insert into client_engine_settings values ('${CLIENT}', true);
    insert into platform_publishing values ('instagram', 'instagram', true);
    insert into platform_format_publishing values ('instagram', 'single', null, true, 'ready');
    select set_config('request.jwt.claim.role', 'authenticated', false);
    select set_config('request.jwt.claim.sub', '${USER}', false);
  `);
  for (const name of [
    "20261019110000_220_carousels_go_out_whole.sql",
    "20261019120000_221_a_story_is_many_posts.sql",
    "20261101040000_287_organic_schedule_route.sql",
  ]) await db.exec(await migration(name));
}, 60000);

beforeEach(async () => {
  await db.exec(`
    delete from post_copy_effective;
    delete from content_slots;
    delete from scheduled_posts;
    delete from client_media_assets;
    delete from client_briefs;
    delete from client_ideas;
    delete from client_campaigns;
    select set_config('request.jwt.claim.role', 'authenticated', false);
    select set_config('request.jwt.claim.sub', '${USER}', false);
    select set_config('test.access', 'on', false);
  `);
});

afterAll(async () => { await db?.close(); });

describe("the scheduling RPC", () => {
  it("accepts an approved same-client organic asset at the requested local time", async () => {
    await chain();
    const { id } = await one<{ id: string }>(
      "select schedule_asset($1, current_date - 1, 'organic', 'instagram', time '18:45') as id",
      [ASSET],
    );
    const row = await one<{ client_id: string | null; hour: string }>(
      "select client_id, to_char(scheduled_at at time zone 'Europe/London', 'HH24:MI') as hour from scheduled_posts where id = $1",
      [id],
    );
    expect(row.hour).toBe("18:45");
    expect(row.client_id).toBe(CLIENT);
  });

  it("refuses paid-channel, paid-campaign and legacy-campaign scheduling with no insert", async () => {
    await chain("paid");
    await expect(db.query("select schedule_asset($1, current_date, 'paid', 'instagram')", [ASSET]))
      .rejects.toThrow(/Ads Studio/);
    await expect(db.query("select schedule_asset($1, current_date, 'organic', 'instagram')", [ASSET]))
      .rejects.toThrow(/paid campaign/);
    await db.exec(`update client_campaigns set acquisition_mode = 'legacy', paid_platform = null`);
    await expect(db.query("select schedule_asset($1, current_date, 'organic', 'instagram')", [ASSET]))
      .rejects.toThrow(/no explicit organic route/);
    expect((await db.query("select 1 from scheduled_posts")).rows).toHaveLength(0);
  });

  it("refuses missing and cross-client chain links even for a caller with access", async () => {
    await chain();
    await db.exec(`update client_briefs set client_id = '${OTHER}' where id = '${BRIEF}'`);
    await expect(db.query("select schedule_asset($1, current_date)", [ASSET]))
      .rejects.toThrow(/same-client campaign idea/);
    await db.exec(`update client_briefs set client_id = '${CLIENT}', source_idea_id = null where id = '${BRIEF}'`);
    await expect(db.query("select schedule_asset($1, current_date)", [ASSET]))
      .rejects.toThrow(/same-client campaign idea/);
    await db.exec(`update client_briefs set source_idea_id = '${IDEA}'; update client_ideas set client_id = '${OTHER}'`);
    await expect(db.query("select schedule_asset($1, current_date)", [ASSET]))
      .rejects.toThrow(/same-client campaign/);
  });

  it("refuses unapproved assets, unauthorized clients and service-role calls", async () => {
    await chain();
    await db.exec(`update client_media_assets set human_approved_at = null`);
    await expect(db.query("select schedule_asset($1, current_date)", [ASSET]))
      .rejects.toThrow(/approved by a person/);
    await db.exec(`update client_media_assets set human_approved_at = now()`);
    await db.exec("select set_config('test.access', 'off', false)");
    await expect(db.query("select schedule_asset($1, current_date)", [ASSET]))
      .rejects.toThrow(/Not permitted/);
    await db.exec("select set_config('test.access', 'null', false)");
    await expect(db.query("select schedule_asset($1, current_date)", [ASSET]))
      .rejects.toThrow(/Not permitted/);
    await db.exec("select set_config('test.access', 'on', false)");
    await expect(asPublisher("select schedule_asset($1, current_date)", [ASSET]))
      .rejects.toThrow(/signed-in console user/);
  });

  it("keeps the human scheduling and publisher claim grants separate", async () => {
    const grants = await one<{
      schedule_anon: boolean; schedule_human: boolean; schedule_service: boolean;
      claim_anon: boolean; claim_human: boolean; claim_service: boolean;
    }>(`select
      has_function_privilege('anon', 'public.schedule_asset(uuid,date,post_channel,post_platform,time)', 'execute') as schedule_anon,
      has_function_privilege('authenticated', 'public.schedule_asset(uuid,date,post_channel,post_platform,time)', 'execute') as schedule_human,
      has_function_privilege('service_role', 'public.schedule_asset(uuid,date,post_channel,post_platform,time)', 'execute') as schedule_service,
      has_function_privilege('anon', 'public.claim_posts_for_publishing(integer)', 'execute') as claim_anon,
      has_function_privilege('authenticated', 'public.claim_posts_for_publishing(integer)', 'execute') as claim_human,
      has_function_privilege('service_role', 'public.claim_posts_for_publishing(integer)', 'execute') as claim_service`);
    expect(grants).toEqual({
      schedule_anon: false, schedule_human: true, schedule_service: false,
      claim_anon: false, claim_human: false, claim_service: true,
    });
  });
});

describe("the due view and service-role claim", () => {
  it("claims a same-client organic slot with approved media", async () => {
    await chain();
    await post();
    expect(await blocker()).toBeNull();
    expect(await asPublisher<{ post_id: string }>("select post_id from claim_posts_for_publishing(5)"))
      .toEqual([{ post_id: POST }]);
    expect(await asPublisher("select * from claim_posts_for_publishing(5)"))
      .toHaveLength(0);
  });

  it("shows the paid blocker and does not claim a manually inserted paid row", async () => {
    await chain();
    await post("paid");
    expect(await blocker()).toMatch(/Paid posts use the Ads Studio route/);
    expect(await asPublisher("select * from claim_posts_for_publishing(5)")).toHaveLength(0);
  });

  it("blocks a paid clone, legacy campaign and missing route", async () => {
    await chain();
    await db.exec(`
      insert into client_campaigns(id, client_id, acquisition_mode, paid_platform, cloned_from_campaign_id)
        values ('${PAID_CAMPAIGN}', '${CLIENT}', 'paid', 'meta', '${CAMPAIGN}');
      update client_ideas set campaign_id = '${PAID_CAMPAIGN}' where id = '${IDEA}';
    `);
    await post();
    expect(await blocker()).toMatch(/paid campaign/);
    expect(await asPublisher("select * from claim_posts_for_publishing(5)")).toHaveLength(0);
    await db.exec(`update client_ideas set campaign_id = '${CAMPAIGN}';
                   update client_campaigns set acquisition_mode='legacy' where id='${CAMPAIGN}'`);
    expect(await blocker()).toMatch(/no explicit organic publishing route/);
    await db.exec(`update client_ideas set campaign_id = null`);
    expect(await blocker()).toMatch(/no verified campaign/);
  });

  it("keeps manual rows visibly blocked until exact-version Inbox and slot binding", async () => {
    await chain();
    await post("organic", false);
    expect(await blocker()).toMatch(/no approved Engine slot.*Approval Inbox/);
    expect(await asPublisher("select * from claim_posts_for_publishing(5)")).toHaveLength(0);
  });

  it("blocks mismatched or duplicate slots and a cross-client asset", async () => {
    await chain();
    await post();
    await db.exec(`update content_slots set stage='awaiting_approval'`);
    expect(await blocker()).toMatch(/slot and asset campaign lineage/);
    await db.exec(`update content_slots set stage='scheduled'`);
    await db.exec(`update content_slots set client_id='${OTHER}'`);
    expect(await blocker()).toMatch(/slot and asset campaign lineage/);
    await db.exec(`update content_slots set client_id='${CLIENT}'`);
    await db.exec(`insert into content_slots(id, client_id, asset_id, brief_id, idea_id, platform, scheduled_post_id, stage)
      values (gen_random_uuid(), '${CLIENT}', '${ASSET}', '${BRIEF}', '${IDEA}', 'instagram', '${POST}', 'scheduled')`);
    expect(await blocker()).toMatch(/slot and asset campaign lineage/);
    await db.exec(`delete from content_slots where id <> '${SLOT}'`);
    await db.exec(`update client_media_assets set client_id = '${OTHER}'`);
    expect(await blocker()).toMatch(/different clients/);
    expect(await asPublisher("select * from claim_posts_for_publishing(5)")).toHaveLength(0);
  });

  it("rechecks changed lineage at claim time rather than trusting an old schedule", async () => {
    await chain();
    await post();
    expect(await blocker()).toBeNull();
    await db.exec(`
      insert into client_campaigns(id, client_id, acquisition_mode, paid_platform)
        values ('${PAID_CAMPAIGN}', '${CLIENT}', 'paid', 'meta');
      insert into client_ideas(id, client_id, campaign_id)
        values ('${PAID_IDEA}', '${CLIENT}', '${PAID_CAMPAIGN}');
      update client_briefs set source_idea_id = '${PAID_IDEA}' where id = '${BRIEF}';
    `);
    expect(await blocker()).toMatch(/paid campaign/);
    expect(await asPublisher("select * from claim_posts_for_publishing(5)")).toHaveLength(0);
  });
});
