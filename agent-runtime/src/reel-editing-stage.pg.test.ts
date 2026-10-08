import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 169 and 170 against a real Postgres.
 *
 * `slot_pipeline` had `building/reel -> video_build` and nothing after it,
 * and video_build finishes by advancing the slot to `copywriting` whether or
 * not anything was cut. So an engine-driven reel reached `awaiting_approval`
 * with `render_path` null — a person asked to approve a reel with no video.
 *
 * QA could not catch it: its aspect-ratio and duration checks read columns
 * only video_edit writes, and 158 deliberately treats a null as "not
 * recorded, nothing to check rather than a fault". An uncut reel scored 100.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const PILLAR = "33333333-3333-4333-8333-333333333333";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}
async function asEngine<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);`);
  }
}

/** A reel slot walked to qa, with or without a cut on its asset. */
async function reelAtQa(opts: { cut?: boolean } = {}): Promise<{ slot: string; asset: string }> {
  const { id: asset } = await one<{ id: string }>(
    `insert into client_media_assets (client_id, title, content_format, render_path)
     values ('${CLIENT}','The Chain','reel',
             ${opts.cut ? `'cuts/a.mp4'` : "null"}) returning id`,
  );
  const { id: slot } = await one<{ id: string }>(
    `select id from create_content_slot('${CLIENT}','instagram', now() + interval '2 days',
            '${PILLAR}', 'reel'::content_format)`,
  );
  await db.exec(`
    select advance_slot('${slot}','ideating'::slot_stage,'engine');
    select advance_slot('${slot}','idea_selected'::slot_stage,'policy');
    select advance_slot('${slot}','briefing'::slot_stage,'engine');
    select advance_slot('${slot}','building'::slot_stage,'agent');
    select advance_slot('${slot}','editing'::slot_stage,'agent',null,null,null,null,null,null,'${asset}');
    select advance_slot('${slot}','copywriting'::slot_stage,'agent');
    select advance_slot('${slot}','qa'::slot_stage,'agent');
  `);
  return { slot, asset };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema cron;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
    create function cron.schedule(a text,b text,c text) returns bigint language sql as
      $$ insert into cron.job (jobname,schedule,command) values (a,b,c) returning jobid $$;
    create function cron.unschedule(a text) returns boolean language sql as
      $$ delete from cron.job where jobname=a returning true $$;

    create type post_platform as enum ('facebook','instagram','tiktok','linkedin','youtube');
    create type post_channel as enum ('organic','paid');
    create type content_format as enum ('single','carousel','story','reel');
    create type media_type as enum ('image','text','video');
    create type review_status as enum ('pending','approved','rejected');

    create table clients (id uuid primary key, name text, timezone text not null default 'Europe/London');
    create table profiles (id uuid primary key, role text);
    create table client_members (client_id uuid, user_id uuid);
    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role='admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable security definer as
      $$ select is_admin() or exists (select 1 from client_members m
            where m.client_id=p and m.user_id=auth.uid()) $$;
    create function client_timezone(p uuid) returns text language sql stable security definer as
      $$ select 'Europe/London'::text $$;

    create table client_content_pillars (id uuid primary key default gen_random_uuid(),
      client_id uuid, name text, target_share int default 100, active boolean default true);
    create table client_engine_budgets (client_id uuid, month date, cap_usd numeric,
      primary key (client_id, month));
    create table client_proof_assets (id uuid primary key default gen_random_uuid(), client_id uuid);
    create table client_ideas (id uuid primary key default gen_random_uuid(), client_id uuid, slot_id uuid,
      title text, body text, source_question text, strategic_reason text, content_territory text,
      status text default 'draft', archived_at timestamptz, created_at timestamptz default now());
    create table client_briefs (id uuid primary key default gen_random_uuid());
    create table client_media_assets (id uuid primary key default gen_random_uuid(),
      client_id uuid, title text, content_format content_format,
      render_path text, review_status review_status not null default 'pending',
      human_approved_at timestamptz);
    create table client_asset_reviews (id uuid primary key default gen_random_uuid(),
      asset_id uuid, decision review_status, reason text, reviewed_by uuid,
      created_at timestamptz default now());
    create table scheduled_posts (id uuid primary key default gen_random_uuid(),
      client_id uuid, asset_id uuid, scheduled_for date, scheduled_at timestamptz,
      channel post_channel default 'organic', platform post_platform, created_by uuid);
    create function review_media_asset(a uuid, d review_status, r text default null)
      returns void language sql security definer as $$ select null::void $$;

    create table agents (agent_key text primary key, name text, initials text, domain text,
      description text, requires_upstream text[], requires_input boolean default false,
      paused boolean not null default false, archived_at timestamptz);
    insert into agents (agent_key) values
      ('ideation'),('brief'),('creative_build'),('video_build'),('video_edit'),('copywriter');
    create table agent_jobs (id uuid primary key default gen_random_uuid(),
      agent_key text references agents(agent_key), client_id uuid, input_table text, input_id uuid,
      created_by uuid, params jsonb default '{}'::jsonb, status text default 'queued',
      cost_usd numeric default 0, created_at timestamptz default clock_timestamp());
    create table agent_job_events (id uuid primary key default gen_random_uuid(),
      job_id uuid, description text, payload jsonb);
    create function can_run_agent(a text,c uuid) returns boolean language sql stable as $$ select true $$;
    create function enqueue_agent_job_internal(p_agent_key text,p_client_id uuid,p_input_table text,
      p_input_id uuid,p_actor uuid,p_params jsonb default '{}'::jsonb,p_description text default 'q')
      returns uuid language plpgsql security definer set search_path to 'public' as $$
      declare v uuid; begin
        insert into agent_jobs (agent_key,client_id,input_table,input_id,created_by,params)
        values (p_agent_key,p_client_id,p_input_table,p_input_id,p_actor,p_params) returning id into v;
        return v; end; $$;
    create function agent_spend_for_client(c uuid,m date) returns numeric language sql stable as
      $$ select 0::numeric $$;
    create view content_archive as select client_id, title, title as idea_title
      from client_media_assets where false;
    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;

    insert into auth.users (id) values ('${ADMIN}');
    insert into profiles (id, role) values ('${ADMIN}','admin');
    insert into clients (id, name) values ('${CLIENT}','Harbour');
    insert into client_content_pillars (id, client_id, name) values ('${PILLAR}','${CLIENT}','Proof');
  `);

  for (const f of [
    "20261005210000_146_engine_settings.sql",
    "20261005230000_147_content_slots.sql",
    "20261005190000_145_post_copy.sql",
    "20261006020000_149_plan_slots.sql",
    "20261006040000_150_engine_tick.sql",
    "20261006060000_151_ideas_know_their_slot.sql",
    "20261006080000_152_idea_selection_and_policy.sql",
    "20261006140000_155_tick_queues_the_right_input.sql",
    "20261006200000_158_qa.sql",
    "20261008100000_169_a_reel_waits_to_be_cut.sql",
  ]) {
    await db.exec(await migration(f));
  }
  // 170 separately: it uses the enum value 169 adds, and Postgres refuses a
  // new value in the transaction that added it.
  await db.exec(await migration("20261008110000_170_the_engine_cuts_the_reel.sql"));

  await db.exec(`select set_config('request.jwt.claim.sub','${ADMIN}',false);
                 select set_config('request.jwt.claim.role','authenticated',false);`);
});

beforeEach(async () => {
  await db.exec(`delete from agent_jobs; delete from content_slots;
                 delete from client_media_assets; delete from client_ideas;
                 delete from client_engine_settings;`);
  await db.exec(`select set_config('request.jwt.claim.sub','${ADMIN}',false);
                 select set_config('request.jwt.claim.role','authenticated',false);`);
  await db.exec(`select set_engine_settings('${CLIENT}', 14, true)`);
});

describe("the cut has a stage of its own", () => {
  it("routes a reel in editing to video_edit, keyed on the asset", async () => {
    const work = await one<{ agent_key: string; input_table: string; input_column: string }>(
      `select agent_key, input_table, input_column from slot_pipeline
        where stage = 'editing' and format = 'reel'`,
    );
    // The asset, not the brief: request_video_edit has keyed on the reel's
    // asset row since 141, and the EDL is stored there.
    expect(work).toMatchObject({
      agent_key: "video_edit",
      input_table: "client_media_assets",
      input_column: "asset_id",
    });
  });

  it("still routes building to video_build for a reel", async () => {
    const { agent_key } = await one<{ agent_key: string }>(
      `select agent_key from slot_pipeline where stage = 'building' and format = 'reel'`,
    );
    expect(agent_key).toBe("video_build");
  });

  it("lets a reel go building → editing → copywriting", async () => {
    const { slot } = await reelAtQa({ cut: true });
    const path = await rows<{ to_stage: string }>(
      `select to_stage from slot_events where slot_id = '${slot}' order by created_at`,
    );
    expect(path.map((r) => r.to_stage)).toEqual([
      "planned", "ideating", "idea_selected", "briefing",
      "building", "editing", "copywriting", "qa",
    ]);
  });

  it("will not skip editing straight to copywriting from building", async () => {
    // Not forbidden outright — a still goes building → copywriting — but the
    // reel path now has somewhere to wait, and the transition table is what
    // makes that legible rather than conventional.
    const legal = await rows<{ to_stage: string }>(
      `select to_stage from slot_transitions where from_stage = 'editing' order by to_stage`,
    );
    expect(legal.map((r) => r.to_stage)).toEqual(["copywriting", "failed"]);
  });

  it("does not offer editing → building, which would loop uncounted", async () => {
    // advance_slot counts an attempt only for qa → building/copywriting,
    // failed → planned and rejected → briefing. A route back from editing to
    // building would spin without ever incrementing.
    const back = await rows(
      `select 1 from slot_transitions where from_stage = 'editing' and to_stage = 'building'`,
    );
    expect(back).toHaveLength(0);
  });

  it("counts a reel waiting in editing as work in flight", async () => {
    // Otherwise the per-client cap in 150 would let the engine start another
    // slot while this one sits waiting on Higgsfield.
    const { indexdef } = await one<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'content_slots_in_flight_idx'`,
    );
    expect(indexdef).toContain("editing");
  });
});

describe("QA will not send an uncut reel to a person", () => {
  it("refuses the move, and says clips are not a cut", async () => {
    const { slot } = await reelAtQa({ cut: false });
    await expect(
      asEngine(`select record_qa_result('${slot}', 100, '[]'::jsonb, 'awaiting_approval'::slot_stage)`),
    ).rejects.toThrow(/no cut/);
  });

  it("allows it once there is a cut", async () => {
    const { slot } = await reelAtQa({ cut: true });
    await asEngine(`select record_qa_result('${slot}', 100, '[]'::jsonb, 'awaiting_approval'::slot_stage)`);
    const { stage } = await one<{ stage: string }>(`select stage from content_slots where id = '${slot}'`);
    expect(stage).toBe("awaiting_approval");
  });

  it("refuses an empty render path as firmly as a null one", async () => {
    const { slot, asset } = await reelAtQa({ cut: false });
    await db.exec(`update client_media_assets set render_path = '   ' where id = '${asset}'`);
    await expect(
      asEngine(`select record_qa_result('${slot}', 100, '[]'::jsonb, 'awaiting_approval'::slot_stage)`),
    ).rejects.toThrow(/no cut/);
  });

  it("still lets an uncut reel be sent back to be rebuilt", async () => {
    // The refusal is about reaching a person, not about moving at all.
    const { slot } = await reelAtQa({ cut: false });
    await asEngine(
      `select record_qa_result('${slot}', 40, '[]'::jsonb, 'building'::slot_stage, 'No cut.')`,
    );
    const { stage } = await one<{ stage: string }>(`select stage from content_slots where id = '${slot}'`);
    expect(stage).toBe("building");
  });

  it("says nothing about a render path on a format that is not a reel", async () => {
    // A single has no render_path and never will.
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (client_id, title, content_format)
       values ('${CLIENT}','Still','single') returning id`,
    );
    const { id: slot } = await one<{ id: string }>(
      `select id from create_content_slot('${CLIENT}','facebook', now() + interval '3 days')`,
    );
    await db.exec(`
      select advance_slot('${slot}','ideating'::slot_stage,'engine');
      select advance_slot('${slot}','idea_selected'::slot_stage,'policy');
      select advance_slot('${slot}','briefing'::slot_stage,'engine');
      select advance_slot('${slot}','building'::slot_stage,'agent');
      select advance_slot('${slot}','copywriting'::slot_stage,'agent',null,null,null,null,null,null,'${asset}');
      select advance_slot('${slot}','qa'::slot_stage,'agent');`);
    await asEngine(`select record_qa_result('${slot}', 100, '[]'::jsonb, 'awaiting_approval'::slot_stage)`);
    const { stage } = await one<{ stage: string }>(`select stage from content_slots where id = '${slot}'`);
    expect(stage).toBe("awaiting_approval");
  });

  it("still refuses a slot below the client's threshold", async () => {
    // The new check is in addition to the old one, not instead of it.
    const { slot } = await reelAtQa({ cut: true });
    await expect(
      asEngine(`select record_qa_result('${slot}', 40, '[]'::jsonb, 'awaiting_approval'::slot_stage)`),
    ).rejects.toThrow(/cannot go for approval/);
  });
});

describe("the tick queues the cut", () => {
  it("queues video_edit for a reel resting in editing", async () => {
    const { slot, asset } = await reelAtQa({ cut: true });
    // Walk it back to editing the only legal way, then let the tick see it.
    await db.exec(`delete from content_slots where id = '${slot}'`);
    const { id: fresh } = await one<{ id: string }>(
      `select id from create_content_slot('${CLIENT}','instagram', now() + interval '5 days',
              '${PILLAR}', 'reel'::content_format)`,
    );
    await db.exec(`
      select advance_slot('${fresh}','ideating'::slot_stage,'engine');
      select advance_slot('${fresh}','idea_selected'::slot_stage,'policy');
      select advance_slot('${fresh}','briefing'::slot_stage,'engine');
      select advance_slot('${fresh}','building'::slot_stage,'agent');
      select advance_slot('${fresh}','editing'::slot_stage,'agent',null,null,null,null,null,null,'${asset}');
      insert into client_engine_budgets (client_id, month, cap_usd)
      values ('${CLIENT}', date_trunc('month', now())::date, 500);
      update engine_controls set enabled = true where id;`);

    // set_engine_settings creates the row switched off and says so in its own
    // comment: "cannot switch it on: use set_engine_enabled". And that one
    // refuses a client with no platform, window or pillar, because an engine
    // with none would plan nothing — so the tick needs all three before it
    // considers this client at all.
    await db.exec(`
      select add_engine_window('${CLIENT}', 1::smallint, time '09:00', time '17:00');
      select set_engine_platform('${CLIENT}', 'instagram'::post_platform, 3, true);
      select set_engine_enabled('${CLIENT}', true);`);

    await asEngine(`select engine_tick()`);

    const queued = await one<{ agent_key: string; input_table: string; input_id: string }>(
      `select agent_key, input_table, input_id from agent_jobs
        where params->>'slot_id' = '${fresh}' order by created_at desc limit 1`,
    );
    expect(queued).toMatchObject({
      agent_key: "video_edit",
      input_table: "client_media_assets",
      input_id: asset,
    });
  });
});
