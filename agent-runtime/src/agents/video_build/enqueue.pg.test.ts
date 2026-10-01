import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REEL = "11111111-1111-4111-8111-111111111111";
const STILL = "22222222-2222-4222-8222-222222222222";
const STORY = "33333333-3333-4333-8333-333333333333";
const LATER = "44444444-4444-4444-8444-444444444444";

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
  `);
  const sql = await readFile(
    new URL("../../../../supabase/migrations/20261001120000_136_enqueue_video_build.sql", import.meta.url),
    "utf8",
  );
  expect(sql).not.toMatch(/platform\.higgsfield\.ai/);
  expect(sql).not.toMatch(/HIGGSFIELD_/);
  await db.exec(sql);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate agent_job_events, agent_jobs, creative_renders, creative_generations, client_briefs, agents, clients, profiles;
    insert into profiles (id, role) values ('${ADMIN}', 'admin');
    insert into clients (id) values ('${CLIENT}');
    insert into agents (agent_key, paused) values ('creative_build', false), ('video_build', false);
    insert into client_briefs (id, client_id, media_type, content_format, format_code, frame_plan, status, title)
    values
      ('${REEL}', '${CLIENT}', 'video', 'reel', 'F6', array['${shot("Name the mechanism")}','${shot("Show the step")}']::text[], 'approved', 'How it works'),
      ('${STILL}', '${CLIENT}', 'image', 'carousel', null, null, 'approved', 'Five reasons'),
      ('${STORY}', '${CLIENT}', 'video', 'story', null, null, 'approved', 'A story'),
      ('${LATER}', '${CLIENT}', 'video', 'reel', 'F5', null, 'approved', 'Proof reel');
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

    const gens = await db.query(`select id from creative_generations`);
    expect(gens.rows).toHaveLength(0);

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
    const jobs = await db.query<{ agent_key: string }>(`select agent_key from agent_jobs`);
    expect(jobs.rows.map((row) => row.agent_key)).toEqual(["creative_build"]);
  });

  it("refuses a video story and a later-phase reel", async () => {
    await expect(db.query(`select build_brief_with_ai('${STORY}')`)).rejects.toThrow(/produced by people/);
    await expect(db.query(`select build_brief_with_ai('${LATER}')`)).rejects.toThrow(/F6 or F7/);
    const jobs = await db.query(`select id from agent_jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it("refuses a paused video_build", async () => {
    await db.exec(`update agents set paused = true where agent_key = 'video_build'`);
    await expect(db.query(`select build_brief_with_ai('${REEL}')`)).rejects.toThrow(/paused/);
  });

  it("refuses anyone who is not an admin", async () => {
    await db.exec(`select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false)`);
    await expect(db.query(`select build_brief_with_ai('${REEL}')`)).rejects.toThrow(/Only an admin/);
  });
});
