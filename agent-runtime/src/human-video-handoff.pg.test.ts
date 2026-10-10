import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const client = "11111111-1111-4111-8111-111111111111";
const brief = "22222222-2222-4222-8222-222222222222";
const avatar = "33333333-3333-4333-8333-333333333333";
const editor = "44444444-4444-4444-8444-444444444444";
const raw = "55555555-5555-4555-8555-555555555555";
const cut = "66666666-6666-4666-8666-666666666666";
const ready = "77777777-7777-4777-8777-777777777777";
const intake = "88888888-8888-4888-8888-888888888888";
const aiSource = "99999999-9999-4999-8999-999999999999";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid $$;
    create function auth.role() returns text language sql stable as $$ select 'service_role' $$;
    create function is_admin() returns boolean language sql stable as $$ select true $$;
    create function is_member(uuid) returns boolean language sql stable as $$ select true $$;
    create function can_access_client(uuid) returns boolean language sql stable as $$ select true $$;
    create type team_category as enum ('avatars','editors','smm');
    create type media_type as enum ('image','text','video');
    create type content_format as enum ('single','carousel','story','reel');
    create type review_status as enum ('pending','approved','rejected');
    create table storage.objects (bucket_id text, name text, owner uuid);
    alter table storage.objects enable row level security;
    create function storage.foldername(text) returns text[] language sql immutable
      as $$ select string_to_array($1, '/') $$;
    create function try_uuid(text) returns uuid language sql immutable
      as $$ select nullif($1, '')::uuid $$;
    create table clients(id uuid primary key);
    create table client_briefs (id uuid primary key default gen_random_uuid(), client_id uuid,
      title text, body text, media_type media_type, content_format content_format,
      status text, production_method text, format_code text, editor_brief text);
    create table team_members (id uuid primary key, category team_category, active boolean, user_id uuid);
    create table client_assignments (member_id uuid, ended_at timestamptz);
    create table client_media_assets (
      id uuid primary key, client_id uuid, brief_id uuid, member_id uuid,
      media_type media_type, content_format content_format, storage_path text,
      render_path text, title text, uploaded_by uuid, review_status review_status default 'pending',
      human_approved_at timestamptz, created_at timestamptz default now(),
      edit_plan jsonb, width integer, height integer, duration_sec numeric
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
    create table agents (agent_key text primary key, name text, initials text,
      domain text, description text, requires_upstream text[], requires_input boolean);
    create function enqueue_agent_job_internal(text, uuid, text, uuid, uuid, jsonb, text)
      returns uuid language plpgsql as $$ declare v_id uuid; begin
      insert into agent_jobs(agent_key,client_id,params,created_by) values ($1,$2,$6,$5)
        returning id into v_id; return v_id; end $$;
    create table client_asset_reviews (asset_id uuid, decision review_status, reason text, reviewed_by uuid);
    create function advance_assignment(uuid, text, text, text, uuid) returns void
      language plpgsql as $$ begin update job_assignments set stage = $2, asset_id = coalesce($5,asset_id) where id = $1; end $$;
    insert into clients values ('${client}');
    insert into auth.users values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    insert into client_briefs(id,client_id,title,media_type,content_format)
      values ('${brief}','${client}','Founder reel','video','reel');
    insert into team_members values ('${avatar}','avatars',true),('${editor}','editors',true);
  `);
  const migration = await readFile(new URL("../../supabase/migrations/20261010120000_174_human_video_edit_handoff.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(`create function active_video_approval_manager(uuid) returns uuid
    language sql stable as $$ select auth.uid() $$;`);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261010140000_176_finish_human_video_without_edit.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261010160000_178_video_edit_intake.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261010170000_179_source_video_ai_edit.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261010180000_180_source_video_ai_revisions.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261010190000_181_motion_design_projects.sql", import.meta.url), "utf8"));
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

it("can send a delivered human cut straight to approval when editing is unnecessary", async () => {
  await db.exec(`insert into client_media_assets
    (id,client_id,brief_id,member_id,media_type,content_format,storage_path,title)
    values ('${ready}','${client}','${brief}','${avatar}','video','reel','${client}/ready.mp4','Finished cut');`);
  await db.query("select accept_video_as_finished($1)", [ready]);
  const output = await db.query<{ edit_stage: string; render_path: string }>(
    "select edit_stage, render_path from client_media_assets where id=$1", [ready]);
  expect(output.rows[0]).toMatchObject({ edit_stage: "review_ready", render_path: `${client}/ready.mp4` });
});

it("registers supplied footage with rights and a standalone human brief", async () => {
  const path = `${client}/${intake}.mp4`;
  await db.query("insert into storage.objects(bucket_id,name) values ('client-media',$1)", [path]);
  const result = await db.query<{ result: { asset_id: string; brief_id: string } }>(
    "select intake_video_for_edit($1,$2,$3,$4,'reel','client_supplied','client_owned',null,$5) as result",
    [intake, client, "Client interview", path, "Remove pauses and add captions."]);
  expect(result.rows[0]?.result.asset_id).toBe(intake);
  const asset = await db.query<{ edit_stage: string; usage_rights: string; intake_source: string }>(
    "select edit_stage,usage_rights,intake_source from client_media_assets where id=$1", [intake]);
  expect(asset.rows[0]).toMatchObject({ edit_stage: "needs_edit", usage_rights: "client_owned",
    intake_source: "client_supplied" });
  const linked = await db.query<{ format_code: string; production_method: string }>(
    "select format_code,production_method from client_briefs where id=$1", [result.rows[0]?.result.brief_id]);
  expect(linked.rows[0]).toMatchObject({ format_code: "HUMAN", production_method: "human" });
  await db.exec("create or replace function is_admin() returns boolean language sql stable as $$ select false $$;");
  const smmAssignment = await db.query<{ id: string }>(
    "select request_human_video_edit($1,$2) as id", [intake, editor]);
  expect(smmAssignment.rows[0]?.id).toBeTruthy();
});

it("lets the assigned SMM queue one guarded source edit", async () => {
  await db.exec(`insert into client_media_assets
    (id,client_id,brief_id,media_type,content_format,storage_path,title,edit_stage)
    values ('${aiSource}','${client}','${brief}','video','reel','${client}/ai-raw.mp4','AI source','needs_edit');`);
  const args = [aiSource, "Cut pauses and keep the spoken point intact.", "vertical",
    true, true, true, "on_brand", "balanced"];
  const result = await db.query<{ id: string }>(
    "select request_source_video_edit($1,$2,$3,$4,$5,$6,$7,$8) as id", args);
  expect(result.rows[0]?.id).toBeTruthy();
  const state = await db.query<{ edit_stage: string }>(
    "select edit_stage from client_media_assets where id=$1", [aiSource]);
  expect(state.rows[0]?.edit_stage).toBe("editing");
  const request = await db.query<{ status: string; job_id: string }>(
    "select status,job_id from video_source_edit_requests where id=$1", [result.rows[0]?.id]);
  expect(request.rows[0]).toMatchObject({ status: "queued", job_id: expect.any(String) });
  await expect(db.query("select request_source_video_edit($1,$2,$3,$4,$5,$6,$7,$8)", args))
    .rejects.toThrow(/waiting for an edit/);
  await expect(db.query(`insert into client_media_assets
    (id,client_id,brief_id,media_type,content_format,storage_path,title,source_asset_id)
    values (gen_random_uuid(),$1,$2,'video','reel',$3,'Premature cut',$4)`,
  [client, brief, `${client}/premature.mp4`, aiSource])).rejects.toThrow(/Only the active AI edit/);
  await db.query("update video_source_edit_requests set status='running' where id=$1", [result.rows[0]?.id]);
  const path = `${client}/edits/${result.rows[0]?.id}/cut.mp4`;
  await db.query("insert into storage.objects(bucket_id,name) values ('client-media',$1)", [path]);
  await db.query("select complete_source_video_edit($1,$2,$3,$4,$5,$6)",
    [result.rows[0]?.id, path, { segments: [] }, 1080, 1920, 1.5]);
  const output = await db.query<{ edit_stage: string; render_path: string }>(
    "select edit_stage,render_path from client_media_assets where id=$1", [result.rows[0]?.id]);
  expect(output.rows[0]).toMatchObject({ edit_stage: "review_ready", render_path: path });
  const completed = await db.query<{ status: string; output_asset_id: string }>(
    "select status,output_asset_id from video_source_edit_requests where id=$1", [result.rows[0]?.id]);
  expect(completed.rows[0]).toMatchObject({ status: "completed", output_asset_id: result.rows[0]?.id });
  const revision = await db.query<{ id: string }>(
    "select request_source_video_edit($1,$2,$3,$4,$5,$6,$7,$8) as id",
    [aiSource, "Shorter hook, still keep the exact spoken claim.", "vertical", true, true, false, "on_brand", "expressive"]);
  const old = await db.query<{ edit_stage: string }>(
    "select edit_stage from client_media_assets where id=$1", [result.rows[0]?.id]);
  expect(old.rows[0]?.edit_stage).toBe("superseded");
  await db.query("select fail_source_video_edit($1,$2)", [revision.rows[0]?.id, "Provider unavailable"]);
  const restored = await db.query<{ edit_stage: string }>(
    "select edit_stage from client_media_assets where id=$1", [result.rows[0]?.id]);
  expect(restored.rows[0]?.edit_stage).toBe("review_ready");
  const sourceAfterFailure = await db.query<{ edit_stage: string }>(
    "select edit_stage from client_media_assets where id=$1", [aiSource]);
  expect(sourceAfterFailure.rows[0]?.edit_stage).toBe("edited");
  const retry = await db.query<{ id: string }>(
    "select request_source_video_edit($1,$2,$3,$4,$5,$6,$7,$8) as id",
    [aiSource, "Shorter hook, still keep the exact spoken claim.", "vertical", true, true, false, "on_brand", "expressive"]);
  const retryPath = `${client}/edits/${retry.rows[0]?.id}/cut.mp4`;
  await db.query("insert into storage.objects(bucket_id,name) values ('client-media',$1)", [retryPath]);
  await db.query("update video_source_edit_requests set status='running' where id=$1", [retry.rows[0]?.id]);
  await db.query("select complete_source_video_edit($1,$2,$3,$4,$5,$6)",
    [retry.rows[0]?.id, retryPath, { segments: [] }, 1080, 1920, 1.2]);
  const versions = await db.query<{ id: string; edit_stage: string }>(
    "select id,edit_stage from client_media_assets where id in ($1,$2) order by id",
    [result.rows[0]?.id, retry.rows[0]?.id]);
  expect(versions.rows).toContainEqual({ id: result.rows[0]?.id, edit_stage: "superseded" });
  expect(versions.rows).toContainEqual({ id: retry.rows[0]?.id, edit_stage: "review_ready" });
  await db.query("update client_media_assets set review_status='approved' where id=$1", [retry.rows[0]?.id]);
  await expect(db.query("select request_source_video_edit($1,$2,$3,$4,$5,$6,$7,$8)", args))
    .rejects.toThrow(/unfinalized AI cut/);
});

it("queues a standalone motion project and keeps revisions linked", async () => {
  const args = [client, "Explain our three-step production flow with clean typography.",
    "explainer", "horizontal", 8, "on_brand"];
  const first = await db.query<{ id: string }>(
    "select request_motion_design($1,$2,$3,$4,$5,$6) as id", args);
  expect(first.rows[0]?.id).toBeTruthy();
  const queued = await db.query<{ status: string; job_id: string }>(
    "select status,job_id from motion_design_projects where id=$1", [first.rows[0]?.id]);
  expect(queued.rows[0]).toMatchObject({ status: "queued", job_id: expect.any(String) });
  await expect(db.query("select request_motion_design($1,$2,$3,$4,$5,$6,$7)",
    [...args, first.rows[0]?.id])).rejects.toThrow(/completed motion design/);
  await db.query("update motion_design_projects set status='completed' where id=$1", [first.rows[0]?.id]);
  const revision = await db.query<{ id: string }>(
    "select request_motion_design($1,$2,$3,$4,$5,$6,$7) as id",
    [...args, first.rows[0]?.id]);
  const linked = await db.query<{ revision_of: string }>(
    "select revision_of from motion_design_projects where id=$1", [revision.rows[0]?.id]);
  expect(linked.rows[0]?.revision_of).toBe(first.rows[0]?.id);
  await db.exec("create or replace function active_video_approval_manager(uuid) returns uuid language sql stable as $$ select null::uuid $$;");
  await expect(db.query("select request_motion_design($1,$2,$3,$4,$5,$6)", args))
    .rejects.toThrow(/Only an admin or the assigned SMM/);
});
