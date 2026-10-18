import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDEA = "22222222-2222-4222-8222-222222222222";
const BRIEF = "33333333-3333-4333-8333-333333333333";
const REEL = "44444444-4444-4444-8444-444444444444";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    create type post_platform as enum ('facebook','instagram','tiktok','linkedin','youtube');
    create type media_type as enum ('image','text','video');
    create type content_format as enum ('single','carousel','story','reel');
    create type review_status as enum ('pending','approved','rejected');
    create table clients (id uuid primary key);
    create table client_ideas (id uuid primary key, client_id uuid);
    create table client_briefs (id uuid primary key, client_id uuid);
    create table client_media_assets (
      id uuid primary key, client_id uuid, media_type media_type,
      content_format content_format, render_path text,
      review_status review_status not null default 'pending', human_approved_at timestamptz
    );
    create table client_media_frames (asset_id uuid, clip_path text);
    create table client_asset_reviews (
      asset_id uuid, decision review_status, reason text, reviewed_by uuid
    );
    create table agent_jobs (
      id uuid primary key default gen_random_uuid(), agent_key text,
      client_id uuid, input_table text, input_id uuid, created_at timestamptz default now(),
      status text default 'queued', params jsonb
    );
    create function can_access_client(p uuid) returns boolean language sql stable as
      $$ select p = '${CLIENT}'::uuid and auth.uid() = '${ADMIN}'::uuid $$;
    create function format_fits_media(f content_format, m media_type)
      returns boolean language sql immutable as $$
      select case f when 'carousel' then m = 'image'
        when 'story' then m in ('image','video') when 'reel' then m = 'video' else true end
      $$;
    create function enqueue_agent_job_internal(
      p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
      p_actor uuid, p_params jsonb default '{}'::jsonb, p_description text default 'Queued'
    ) returns uuid language plpgsql as $$
    declare v_id uuid;
    begin
      insert into agent_jobs (agent_key, client_id, input_table, input_id, params)
      values (p_agent_key, p_client_id, p_input_table, p_input_id, p_params)
      returning id into v_id;
      return v_id;
    end $$;
    insert into clients values ('${CLIENT}');
    insert into client_ideas values ('${IDEA}', '${CLIENT}');
    insert into client_briefs values ('${BRIEF}', '${CLIENT}');
    insert into client_media_assets (id, client_id, media_type, content_format)
      values ('${REEL}', '${CLIENT}', 'video', 'reel');
    select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claim.sub','${ADMIN}',false);
  `);
  const migration = await readFile(new URL("../../supabase/migrations/20261010100000_172_content_flow_p0.sql", import.meta.url), "utf8");
  await db.exec(migration);
});

afterAll(async () => { await db?.close(); });

describe("P0 content flow migration", () => {
  it("queues format-directed ideation and rejects incompatible choices", async () => {
    const queued = await db.query<{ id: string }>(`
      select enqueue_format_ideation('${CLIENT}', 'instagram', 'video', 'reel') as id`);
    const result = await db.query<{ params: Record<string, string> }>(
      `select params from agent_jobs where id = '${queued.rows[0]?.id}'`);
    expect(result.rows[0]?.params).toMatchObject({ target_platform: "instagram", media_type: "video", content_format: "reel" });
    await expect(db.query(`select enqueue_format_ideation('${CLIENT}', 'linkedin', 'video', 'reel')`))
      .rejects.toThrow(/not supported/);
  });

  it("waits for clips, queues one cut, and refuses approval before rendering", async () => {
    await db.exec(`insert into client_media_frames values ('${REEL}', null)`);
    await expect(db.query(`select request_video_edit('${REEL}')`)).rejects.toThrow(/every Higgsfield clip/);
    await expect(db.query(`select review_media_asset('${REEL}', 'approved')`)).rejects.toThrow(/Finish the reel cut/);
    await db.exec(`update client_media_frames set clip_path = '${CLIENT}/clips/one.mp4' where asset_id = '${REEL}'`);
    const first = await db.query<{ id: string }>(`select request_video_edit('${REEL}') as id`);
    const second = await db.query<{ id: string }>(`select request_video_edit('${REEL}') as id`);
    expect(second.rows[0]?.id).toBe(first.rows[0]?.id);
    await db.exec(`update client_media_assets set render_path = '${CLIENT}/reels/cut.mp4' where id = '${REEL}'`);
    await db.query(`select review_media_asset('${REEL}', 'approved')`);
    const approved = await db.query<{ review_status: string; human_approved_at: string }>(
      `select review_status, human_approved_at from client_media_assets where id = '${REEL}'`);
    expect(approved.rows[0]?.review_status).toBe("approved");
    expect(approved.rows[0]?.human_approved_at).toBeTruthy();
  });
});
