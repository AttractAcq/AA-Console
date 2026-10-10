import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const client = "11111111-1111-4111-8111-111111111111";
const brief = "22222222-2222-4222-8222-222222222222";
const avatar = "33333333-3333-4333-8333-333333333333";
const editor = "44444444-4444-4444-8444-444444444444";
const raw = "55555555-5555-4555-8555-555555555555";
const cut = "66666666-6666-4666-8666-666666666666";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as
      $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid $$;
    create function is_admin() returns boolean language sql stable as $$ select true $$;
    create function is_member(uuid) returns boolean language sql stable as $$ select true $$;
    create function can_access_client(uuid) returns boolean language sql stable as $$ select true $$;
    create type team_category as enum ('avatars','editors','smm');
    create type media_type as enum ('image','text','video');
    create type content_format as enum ('single','carousel','story','reel');
    create type review_status as enum ('pending','approved','rejected');
    create table storage.objects (bucket_id text, name text);
    create table client_briefs (id uuid primary key);
    create table team_members (id uuid primary key, category team_category, active boolean);
    create table client_media_assets (
      id uuid primary key, client_id uuid, brief_id uuid, member_id uuid,
      media_type media_type, content_format content_format, storage_path text,
      render_path text, title text, review_status review_status default 'pending',
      human_approved_at timestamptz, created_at timestamptz default now()
    );
    create table job_assignments (
      id uuid primary key default gen_random_uuid(), member_id uuid, client_id uuid,
      brief_id uuid, asset_id uuid, title text, due_date date,
      stage text default 'assigned', created_at timestamptz default now()
    );
    create table brief_dispatches (
      id uuid primary key default gen_random_uuid(), client_id uuid, brief_id uuid,
      member_id uuid, assignment_id uuid, sent_by uuid, brief_role text,
      email_status text default 'pending', email_error text, emailed_at timestamptz,
      job_id uuid
    );
    create unique index brief_dispatches_brief_member_role_uidx
      on brief_dispatches(brief_id,member_id,brief_role);
    alter table brief_dispatches add constraint brief_dispatches_brief_role_check
      check (brief_role in ('avatar','editor','full'));
    create table agent_jobs (
      id uuid primary key default gen_random_uuid(), agent_key text, client_id uuid,
      params jsonb, created_by uuid
    );
    create table client_asset_reviews (asset_id uuid, decision review_status, reason text, reviewed_by uuid);
    create function advance_assignment(uuid, text, text, text, uuid) returns void
      language plpgsql as $$ begin update job_assignments set stage = $2, asset_id = coalesce($5,asset_id) where id = $1; end $$;
    insert into client_briefs values ('${brief}');
    insert into team_members values ('${avatar}','avatars',true),('${editor}','editors',true);
  `);
  const migration = await readFile(new URL("../../supabase/migrations/20261010120000_174_human_video_edit_handoff.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(`create trigger car_assignment_follows_review after insert on client_asset_reviews
    for each row execute function assignment_follows_review();`);
});
afterAll(async () => { await db?.close(); });

it("keeps avatar footage out of approval and assigns one edit", async () => {
  await db.exec(`insert into client_media_assets
    (id,client_id,brief_id,member_id,media_type,content_format,storage_path,title)
    values ('${raw}','${client}','${brief}','${avatar}','video','reel','${client}/raw.mp4','Founder reel');
    insert into job_assignments(member_id,client_id,brief_id,asset_id,title,stage)
    values ('${avatar}','${client}','${brief}','${raw}','Record footage','delivered');`);
  const state = await db.query<{ edit_stage: string }>("select edit_stage from client_media_assets where id=$1", [raw]);
  expect(state.rows[0]?.edit_stage).toBe("needs_edit");
  await expect(db.query("select review_media_asset($1,'approved')", [raw]))
    .rejects.toThrow(/Edit the source footage/);
  const first = await db.query<{ id: string }>("select request_human_video_edit($1,$2) as id", [raw, editor]);
  const second = await db.query<{ id: string }>("select request_human_video_edit($1,$2) as id", [raw, editor]);
  expect(second.rows[0]?.id).toBe(first.rows[0]?.id);
  const dispatch = await db.query<{ brief_role: string }>("select brief_role from brief_dispatches");
  expect(dispatch.rows[0]?.brief_role).toBe("edit");
});

it("stores the edited video as a linked version and closes both assignments on approval", async () => {
  await db.exec(`insert into client_media_assets
    (id,client_id,brief_id,member_id,media_type,content_format,storage_path,title,source_asset_id)
    values ('${cut}','${client}','${brief}','${editor}','video','reel','${client}/cut.mp4','Founder edit','${raw}');
    update job_assignments set stage='delivered', asset_id='${cut}' where source_asset_id='${raw}';`);
  const output = await db.query<{ source_asset_id: string; render_path: string; edit_stage: string }>(
    "select source_asset_id,render_path,edit_stage from client_media_assets where id=$1", [cut]);
  expect(output.rows[0]).toMatchObject({ source_asset_id: raw, render_path: `${client}/cut.mp4`, edit_stage: "review_ready" });
  await db.query("select review_media_asset($1,'approved')", [cut]);
  const jobs = await db.query<{ stage: string }>("select stage from job_assignments order by member_id");
  expect(jobs.rows.every((job) => job.stage === "approved")).toBe(true);
  const original = await db.query<{ review_status: string; edit_stage: string }>(
    "select review_status,edit_stage from client_media_assets where id=$1", [raw]);
  expect(original.rows[0]).toMatchObject({ review_status: "pending", edit_stage: "edited" });
});
