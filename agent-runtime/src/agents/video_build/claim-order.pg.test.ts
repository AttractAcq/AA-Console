import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role service_role;
    create role authenticated;
    create role anon;
    create schema auth;
    create function auth.role() returns text language sql stable as $$ select 'service_role' $$;
    create function auth.uid() returns uuid language sql stable as $$ select '60000000-0000-4000-8000-000000000001'::uuid $$;
    create function is_admin() returns boolean language sql stable as $$ select true $$;
    create function can_run_agent(text, uuid) returns boolean language sql stable as $$ select true $$;
    create type job_status as enum ('queued', 'claimed', 'running', 'completed', 'failed');
    create table agents (agent_key text primary key, paused boolean not null default false, archived_at timestamptz);
    create table agent_jobs (
      id uuid primary key default gen_random_uuid(), agent_key text not null, client_id uuid, input_table text, input_id uuid,
      params jsonb not null default '{}'::jsonb, status job_status not null default 'queued', created_by uuid,
      terminal boolean not null default false, run_after timestamptz, attempts integer not null default 0,
      max_attempts integer not null default 3, lease_until timestamptz, lease_owner text,
      started_at timestamptz, error text, created_at timestamptz not null default now()
    );
    create table creative_generations (id uuid primary key, brief_id uuid not null);
    create table creative_renders (id uuid primary key, generation_id uuid not null);
    create table client_briefs (id uuid primary key, client_id uuid, media_type text, content_format text, format_code text);
    create table client_media_assets (id uuid primary key, brief_id uuid);
    create table client_media_frames (asset_id uuid, storage_path text);
    create table agent_job_events (job_id uuid, description text);
    insert into agents(agent_key) values ('creative_build'), ('video_build');
    insert into creative_generations values
      ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');
    insert into creative_renders values
      ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    insert into client_briefs values
      ('20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'video', 'reel', 'F7'),
      ('20000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', 'video', 'reel', 'F6');
    insert into agent_jobs(id, agent_key, client_id, input_table, input_id, params, created_at) values
      ('40000000-0000-4000-8000-000000000001', 'creative_build', '50000000-0000-4000-8000-000000000001',
       'creative_renders', '30000000-0000-4000-8000-000000000001', '{"opening_stills":true}', now()),
      ('40000000-0000-4000-8000-000000000002', 'video_build', '50000000-0000-4000-8000-000000000001',
       'client_briefs', '20000000-0000-4000-8000-000000000001', '{}', now() + interval '1 second'),
      ('40000000-0000-4000-8000-000000000003', 'video_build', '50000000-0000-4000-8000-000000000001',
       'client_briefs', '20000000-0000-4000-8000-000000000002', '{}', now() + interval '2 seconds');
  `);
  const migration = await readFile(
    new URL("../../../../supabase/migrations/20261011080000_188_reel_stills_before_motion.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration);
});

afterAll(async () => db?.close());

describe("reel stills before motion claim", () => {
  it("holds the same brief's motion, allows unrelated work, then releases motion after stills", async () => {
    const first = await db.query<{ agent_key: string }>("select (claim_agent_job('worker')).agent_key");
    expect(first.rows[0]?.agent_key).toBe("creative_build");

    const unrelated = await db.query<{ input_id: string }>("select (claim_agent_job('worker')).input_id");
    expect(unrelated.rows[0]?.input_id).toBe("20000000-0000-4000-8000-000000000002");

    const held = await db.query<{ job: unknown }>("select claim_agent_job('worker') as job");
    expect(held.rows[0]?.job).toBeNull();

    await db.exec("update agent_jobs set status = 'completed' where id = '40000000-0000-4000-8000-000000000001'");
    const released = await db.query<{ input_id: string }>("select (claim_agent_job('worker')).input_id");
    expect(released.rows[0]?.input_id).toBe("20000000-0000-4000-8000-000000000001");
  });

  it("retries a failed reel only after its stills exist", async () => {
    await db.exec(`
      insert into agent_jobs(id, agent_key, client_id, input_table, input_id, status)
      values ('40000000-0000-4000-8000-000000000004', 'video_build',
        '50000000-0000-4000-8000-000000000001', 'client_briefs',
        '20000000-0000-4000-8000-000000000003', 'failed');
    `);
    await expect(db.query("select retry_reel_video_build('20000000-0000-4000-8000-000000000003')"))
      .rejects.toThrow(/No opening still/);
    await db.exec(`
      insert into client_media_assets values
        ('70000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003');
      insert into client_media_frames values
        ('70000000-0000-4000-8000-000000000001', 'still.png');
    `);
    const result = await db.query<{ retry_reel_video_build: string }>(
      "select retry_reel_video_build('20000000-0000-4000-8000-000000000003')",
    );
    expect(result.rows[0]?.retry_reel_video_build).toBeTruthy();
    await expect(db.query("select retry_reel_video_build('20000000-0000-4000-8000-000000000003')"))
      .rejects.toThrow(/not failed/);
  });
});
