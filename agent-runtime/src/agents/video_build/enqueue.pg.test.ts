import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REEL = "11111111-1111-4111-8111-111111111111";
const STILL = "22222222-2222-4222-8222-222222222222";
const STORY = "33333333-3333-4333-8333-333333333333";
const LATER = "44444444-4444-4444-8444-444444444444";
const UNTAGGED = "55555555-5555-4555-8555-555555555555";

const shot = (beat: string) =>
  JSON.stringify({
    beat,
    duration_sec: 3,
    motion_preset: "pending",
    shot_source_kind: "ai_generated",
  });

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table profiles (id uuid primary key, role text);
    create function is_admin() returns boolean language sql stable as
      $$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;

    create type media_type as enum ('image', 'text', 'video');
    create type content_format as enum ('single', 'carousel', 'story', 'reel');

    create table clients (id uuid primary key);
    create table agents (agent_key text primary key, paused boolean not null default false);
    create table client_briefs (
      id uuid primary key,
      client_id uuid not null references clients(id),
      media_type media_type not null,
      content_format content_format not null default 'single',
      format_code text,
      frame_count integer,
      frame_plan text[],
      status text not null default 'approved',
      title text
    );
    create table agent_jobs (
      id uuid primary key default gen_random_uuid(),
      agent_key text not null references agents(agent_key),
      client_id uuid,
      input_table text,
      input_id uuid,
      params jsonb not null default '{}'::jsonb,
      created_by uuid,
      status text not null default 'queued'
    );
    create table agent_job_events (
      id uuid primary key default gen_random_uuid(),
      job_id uuid not null references agent_jobs(id),
      description text not null
    );
    create table creative_generations (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null,
      brief_id uuid not null,
      job_id uuid,
      media_type media_type not null,
      quality text not null,
      size text not null,
      reference_path text,
      created_by uuid,
      constraint creative_generations_no_ai_video check (media_type <> 'video')
    );
    create table creative_renders (
      id uuid primary key default gen_random_uuid(),
      generation_id uuid not null,
      client_id uuid not null,
      job_id uuid,
      quality text not null,
      size text not null,
      reference_path text,
      created_by uuid
    );
    create schema mcp_internal;
    create function auth.role() returns text language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role') $$;

    create or replace function format_fits_media(p_format content_format, p_media media_type)
    returns boolean language sql immutable as $$
      select case p_format
        when 'carousel' then p_media = 'image'
        when 'story' then p_media in ('image', 'video')
        when 'reel' then p_media = 'video'
        else true
      end;
    $$;

    create table client_media_assets (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients(id),
      brief_id uuid references client_briefs(id),
      media_type media_type not null,
      title text,
      storage_path text not null,
      review_status text not null default 'pending',
      content_format content_format not null default 'single',
      constraint assets_format_fits check (format_fits_media(content_format, media_type))
    );
    create table client_media_frames (
      id uuid primary key default gen_random_uuid(),
      asset_id uuid not null references client_media_assets(id) on delete cascade,
      position integer not null,
      storage_path text not null,
      caption text,
      shot_source_kind text,
      beat text,
      duration_sec numeric,
      motion_preset text,
      unique (asset_id, position)
    );
  `);
  const sql = await readFile(
    new URL("../../../../supabase/migrations/20261001143000_137_reel_opening_stills.sql", import.meta.url),
    "utf8",
  );
  expect(sql).not.toMatch(/platform\.higgsfield\.ai/);
  expect(sql).not.toMatch(/HIGGSFIELD_/);
  await db.exec(sql);
  await db.exec(`
    create function mcp_internal.require_active_bot(text) returns void language plpgsql as $$ begin end $$;
    create function mcp_internal.require_bot_client_grant(text, uuid) returns void language plpgsql as $$ begin end $$;
    create function mcp_internal.require_mcp_ids(text, text) returns void language plpgsql as $$ begin end $$;
    create function mcp_internal.take_content_request(text, text, text, uuid, jsonb)
    returns jsonb language plpgsql as $$ begin return null; end $$;
    create table mcp_internal.mcp_content_requests (
      bot_id text,
      execution_id text,
      request_id text,
      tool text,
      client_id uuid,
      brief_id uuid,
      payload jsonb,
      result jsonb
    );
  `);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate client_media_frames, client_media_assets, agent_job_events, agent_jobs, creative_renders, creative_generations, client_briefs, agents, clients, profiles, mcp_internal.mcp_content_requests;
    insert into profiles (id, role) values ('${ADMIN}', 'admin');
    insert into clients (id) values ('${CLIENT}');
    insert into agents (agent_key, paused) values ('creative_build', false), ('video_build', false);
    insert into client_briefs (id, client_id, media_type, content_format, format_code, frame_plan, status, title)
    values
      ('${REEL}', '${CLIENT}', 'video', 'reel', 'F6', array['${shot("Name the mechanism")}','${shot("Show the step")}']::text[], 'approved', 'How it works'),
      ('${STILL}', '${CLIENT}', 'image', 'carousel', null, null, 'approved', 'Five reasons'),
      ('${STORY}', '${CLIENT}', 'video', 'story', null, null, 'approved', 'A story'),
      ('${LATER}', '${CLIENT}', 'video', 'reel', 'F5', null, 'approved', 'Proof reel'),
      ('${UNTAGGED}', '${CLIENT}', 'video', 'reel', null, array['${shot("Open on the problem")}','${shot("Leave the question")}']::text[], 'approved', 'Cold open');
    select set_config('request.jwt.claim.sub', '${ADMIN}', false);
  `);
});

describe("build_brief_with_ai reel enqueue", () => {
  it("queues video_build for an F6 reel and leaves the shot plan alone", async () => {
    const queued = await db.query<{ build_brief_with_ai: string }>(
      `select build_brief_with_ai('${REEL}', 'medium', '1024x1536', null, 9, array['plain line']::text[])`,
    );
    const jobId = queued.rows[0]?.build_brief_with_ai;
    const job = await db.query<{
      agent_key: string;
      input_table: string | null;
      input_id: string | null;
      client_id: string;
    }>(`select agent_key, input_table, input_id, client_id from agent_jobs where id = '${jobId}'`);
    expect(job.rows[0]).toMatchObject({
      agent_key: "video_build",
      input_table: "client_briefs",
      input_id: REEL,
      client_id: CLIENT,
    });

    const gens = await db.query<{ media_type: string }>(
      `select media_type::text as media_type from creative_generations`,
    );
    expect(gens.rows).toEqual([{ media_type: "image" }]);

    const jobs = await db.query<{ agent_key: string; params: { opening_stills?: boolean; render_id?: string } }>(
      `select agent_key, params from agent_jobs order by agent_key`,
    );
    expect(jobs.rows.map((row) => row.agent_key)).toEqual(["creative_build", "video_build"]);
    const stillsJob = jobs.rows.find((row) => row.agent_key === "creative_build");
    expect(stillsJob?.params.opening_stills).toBe(true);
    expect(stillsJob?.params.render_id).toBeTruthy();

    const brief = await db.query<{ status: string; frame_plan: string[] }>(
      `select status, frame_plan from client_briefs where id = '${REEL}'`,
    );
    expect(brief.rows[0]?.status).toBe("in_production");
    expect(brief.rows[0]?.frame_plan?.[0]).toContain("Name the mechanism");

    const event = await db.query<{ description: string }>(
      `select description from agent_job_events where job_id = '${jobId}'`,
    );
    expect(event.rows[0]?.description).toMatch(/No Higgsfield request was sent/);
    expect(event.rows[0]?.description).not.toMatch(/https?:/);
  });

  it("still queues creative_build for a carousel and does not queue video_build", async () => {
    const queued = await db.query<{ build_brief_with_ai: string }>(
      `select build_brief_with_ai('${STILL}', 'high', '1024x1024', null, null, null)`,
    );
    const id = queued.rows[0]?.build_brief_with_ai;
    const gen = await db.query(`select id from creative_generations where id = '${id}'`);
    expect(gen.rows).toHaveLength(1);
    const jobs = await db.query<{ agent_key: string; params: { opening_stills?: boolean } }>(
      `select agent_key, params from agent_jobs`,
    );
    expect(jobs.rows.map((row) => row.agent_key)).toEqual(["creative_build"]);
    expect(jobs.rows[0]?.params.opening_stills).toBeUndefined();
    const media = await db.query<{ media_type: string }>(
      `select media_type::text as media_type from creative_generations where id = '${id}'`,
    );
    expect(media.rows[0]?.media_type).toBe("image");
  });

  it("refuses a video story and a later-phase reel", async () => {
    await expect(db.query(`select build_brief_with_ai('${STORY}')`)).rejects.toThrow(/produced by people/);
    await expect(db.query(`select build_brief_with_ai('${LATER}')`)).rejects.toThrow(/F6 or F7/);
    const jobs = await db.query(`select id from agent_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it("queues the same image stills for a reel that has no format code yet", async () => {
    await db.query(`select build_brief_with_ai('${UNTAGGED}')`);
    const jobs = await db.query<{ agent_key: string }>(`select agent_key from agent_jobs order by agent_key`);
    expect(jobs.rows.map((row) => row.agent_key)).toEqual(["creative_build", "video_build"]);
    const gens = await db.query<{ media_type: string }>(
      `select media_type::text as media_type from creative_generations`,
    );
    expect(gens.rows).toEqual([{ media_type: "image" }]);
  });

  it("refuses a paused video_build and a paused creative_build", async () => {
    await db.exec(`update agents set paused = true where agent_key = 'video_build'`);
    await expect(db.query(`select build_brief_with_ai('${REEL}')`)).rejects.toThrow(/paused/);
    await db.exec(`update agents set paused = false where agent_key = 'video_build'`);
    await db.exec(`update agents set paused = true where agent_key = 'creative_build'`);
    await expect(db.query(`select build_brief_with_ai('${REEL}')`)).rejects.toThrow(/creative_build is paused/);
    const jobs = await db.query(`select id from agent_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it("refuses anyone who is not an admin", async () => {
    await db.exec(`select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false)`);
    await expect(db.query(`select build_brief_with_ai('${REEL}')`)).rejects.toThrow(/Only an admin/);
  });
});

describe("assign_production reel enqueue", () => {
  it("queues an image stills job and video_build for an F6 reel", async () => {
    const queued = await db.query<{ result: { agent_key: string; generation_media_type: string; stills_job_id: string } }>(
      `select mcp_internal.assign_production(
         'bot_production', 'req-reel', 'exec-reel', '${CLIENT}', '${REEL}', 'ai',
         null, null, null, 'medium', '1024x1536', null
       ) as result`,
    );
    expect(queued.rows[0]?.result.agent_key).toBe("video_build");
    expect(queued.rows[0]?.result.generation_media_type).toBe("image");
    const jobs = await db.query<{ agent_key: string }>(`select agent_key from agent_jobs order by agent_key`);
    expect(jobs.rows.map((row) => row.agent_key)).toEqual(["creative_build", "video_build"]);
    const gen = await db.query<{ media_type: string }>(
      `select media_type::text as media_type from creative_generations`,
    );
    expect(gen.rows).toEqual([{ media_type: "image" }]);
  });
});

describe("save_framed_asset reel stills", () => {
  it("files a reel as video and keeps shot columns on the frames", async () => {
    const saved = await db.query<{ save_framed_asset: string }>(
      `select save_framed_asset(
         '${CLIENT}', '${REEL}', 'reel', 'video', 'How it works',
         $json$[
           {"position":1,"storage_path":"c/01.png","caption":"open","beat":"Name the mechanism","duration_sec":3,"motion_preset":"pending","shot_source_kind":"ai_generated"},
           {"position":2,"storage_path":"c/02.png","beat":"Show the step","duration_sec":4,"motion_preset":"pending","shot_source_kind":"ai_generated"}
         ]$json$::jsonb
       )`,
    );
    const assetId = saved.rows[0]?.save_framed_asset;
    const asset = await db.query<{ media_type: string; content_format: string; storage_path: string }>(
      `select media_type::text as media_type, content_format::text as content_format, storage_path
         from client_media_assets where id = '${assetId}'`,
    );
    expect(asset.rows[0]).toMatchObject({
      media_type: "video",
      content_format: "reel",
      storage_path: "c/01.png",
    });
    const frames = await db.query<{ position: number; beat: string; motion_preset: string }>(
      `select position, beat, motion_preset from client_media_frames where asset_id = '${assetId}' order by position`,
    );
    expect(frames.rows.map((row) => row.beat)).toEqual(["Name the mechanism", "Show the step"]);
    expect(frames.rows[0]?.motion_preset).toBe("pending");
  });

  it("still files a carousel without shot columns", async () => {
    const saved = await db.query<{ save_framed_asset: string }>(
      `select save_framed_asset(
         '${CLIENT}', '${STILL}', 'carousel', 'image', 'Five reasons',
         '[{"position":1,"storage_path":"c/a.png","caption":"hook"},{"position":2,"storage_path":"c/b.png","caption":"proof"}]'::jsonb
       )`,
    );
    const assetId = saved.rows[0]?.save_framed_asset;
    const frames = await db.query<{ beat: string | null; shot_source_kind: string | null }>(
      `select beat, shot_source_kind from client_media_frames where asset_id = '${assetId}'`,
    );
    expect(frames.rows).toHaveLength(2);
    expect(frames.rows.every((row) => row.beat === null && row.shot_source_kind === null)).toBe(true);
  });

  it("refuses a reel filed as an image, and refuses a caller who is not the runtime", async () => {
    await expect(
      db.query(
        `select save_framed_asset(
           '${CLIENT}', '${REEL}', 'reel', 'image', 'Nope',
           '[{"position":1,"storage_path":"c/01.png"},{"position":2,"storage_path":"c/02.png"}]'::jsonb
         )`,
      ),
    ).rejects.toThrow(/reel asset is a video/);
    await db.exec(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    await expect(
      db.query(
        `select save_framed_asset(
           '${CLIENT}', '${REEL}', 'reel', 'video', 'Nope',
           '[{"position":1,"storage_path":"c/01.png"},{"position":2,"storage_path":"c/02.png"}]'::jsonb
         )`,
      ),
    ).rejects.toThrow(/Only the agent runtime/);
    await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
  });
});
