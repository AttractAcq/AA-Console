import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = () => readFile(new URL(
  "../../supabase/migrations/20261012090000_190_v5_workflow_spine.sql", import.meta.url,
), "utf8");
const dailyMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012100000_191_v5_daily_package.sql", import.meta.url,
), "utf8");
const recoveryMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012130000_194_v5_daily_recovery.sql", import.meta.url,
), "utf8");
const alertMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012140000_195_v5_recovery_alert_delivery.sql", import.meta.url,
), "utf8");
const attributionMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012150000_196_v5_outcome_attribution.sql", import.meta.url,
), "utf8");
const learningMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012160000_197_v5_ideation_learning.sql", import.meta.url,
), "utf8");
const dailyQaMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012200000_201_v5_daily_internal_qa.sql", import.meta.url,
), "utf8");
const dailySequenceMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012210000_202_v5_daily_idea_sequence.sql", import.meta.url,
), "utf8");
const creativeRoutingMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012220000_203_v5_daily_creative_routing.sql", import.meta.url,
), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMPAIGN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PILLAR = "99999999-9999-4999-8999-999999999999";
const INPUT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTPUT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const IDEA = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const OTHER_OUTPUT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
let db: PGlite;

async function one<T>(query: string): Promise<T> {
  return (await db.query<T>(query)).rows[0]!;
}
async function service<T>(query: string): Promise<T> {
  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
  return one<T>(query);
}
async function makeRun(key = "day-1", snapshot = "'{\"brief\":\"one\"}'::jsonb") {
  return service<{ id: string; status: string }>(`select id, status from create_workflow_run(
    '${CLIENT}', 'daily_content_package', 'v5.1', '${key}', ${snapshot},
    timestamptz '2099-01-01 09:00+00', '${CAMPAIGN}', 'cos:request-1', '${ADMIN}')`);
}
async function addStep(runId: string, key: string, deps = "array[]::text[]") {
  return service<{ id: string; status: string }>(`select id, status from add_workflow_agent_step(
    '${runId}', '${key}', ${deps}, 'brief', 'client_ideas', '${INPUT}', '{}'::jsonb)`);
}
async function seal(runId: string) {
  return service<{ sealed_at: string }>(`select sealed_at from seal_workflow_run('${runId}')`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create type post_platform as enum ('facebook', 'instagram', 'tiktok', 'linkedin', 'youtube');
    create type media_type as enum ('image', 'text', 'video');
    create type content_format as enum ('single', 'carousel', 'story', 'reel');
    create schema auth;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table clients (id uuid primary key, name text not null default 'Test client',
      timezone text not null default 'Europe/London');
    create table profiles (id uuid primary key, email text);
    create table client_campaigns (id uuid primary key, client_id uuid not null,
      name text, audience text, offer_summary text, core_message text,
      status text not null default 'planning', ad_campaign_id uuid);
    create table client_content_pillars (id uuid primary key, client_id uuid not null,
      active boolean not null default true, premise text);
    create table client_proof_assets (id uuid primary key, client_id uuid not null);
    create table client_engine_settings (client_id uuid primary key, enabled boolean not null default false);
    create table content_slots (id uuid primary key, client_id uuid);
    create table client_agent_records (id uuid primary key, client_id uuid not null, job_id uuid, body text);
    create table client_ideas (id uuid primary key, client_id uuid not null, job_id uuid, title text,
      body text, created_at timestamptz default now(),
      campaign_id uuid, pillar_id uuid, target_platform post_platform,
      content_format content_format, media_type media_type,
      source_question text, strategic_reason text);
    create table client_briefs (id uuid primary key, client_id uuid not null, job_id uuid, body text, title text,
      created_at timestamptz default now(),
      source_idea_id uuid, content_format content_format, media_type media_type,
      target_platform post_platform, format_code text);
    create table client_media_assets (id uuid primary key, client_id uuid not null, brief_id uuid,
      created_at timestamptz default now(), updated_at timestamptz default now(),
      storage_path text, render_path text, content_format content_format,
      media_type media_type, review_status text default 'pending', human_approved_at timestamptz,
      title text);
    create table client_media_frames (asset_id uuid, clip_path text);
    create table video_render_candidates (id uuid primary key, asset_id uuid, job_id uuid,
      attempt integer, verdict text, render_path text, media_probe jsonb, creative_review jsonb);
    create table post_copy (asset_id uuid, platform post_platform, caption text);
    create table scheduled_posts (id uuid primary key, asset_id uuid);
    create table campaign_artifacts (campaign_id uuid, page_id uuid, asset_id uuid);
    create table client_leads (id uuid primary key, client_id uuid not null,
      source_asset_id uuid, source_post_id uuid, source_page_id uuid,
      source_campaign_id uuid, cash_collected numeric);
    create table client_asset_reviews (asset_id uuid, decision text, reason text,
      created_at timestamptz default now());
    create table client_pages (id uuid primary key, client_id uuid not null, job_id uuid, body text);
    create table client_sales_agents (id uuid primary key, client_id uuid not null, job_id uuid,
      built_at timestamptz, system_prompt text);
    create table agents (agent_key text primary key, paused boolean not null default false);
    create table agent_jobs (
      id uuid primary key default gen_random_uuid(), agent_key text,
      client_id uuid, input_table text, input_id uuid, params jsonb,
      created_by uuid, run_id uuid, status text not null default 'queued',
      terminal boolean not null default false, attempts integer not null default 0,
      cost_usd numeric not null default 0,
      max_attempts integer not null default 3, error text, created_at timestamptz default now());
    create table creative_generations (id uuid primary key default gen_random_uuid(),
      client_id uuid not null, brief_id uuid not null, media_type media_type not null,
      quality text not null, size text not null, job_id uuid, created_by uuid);
    create table creative_renders (id uuid primary key default gen_random_uuid(),
      generation_id uuid not null, client_id uuid not null, quality text not null,
      size text not null, job_id uuid, created_by uuid);
    create function can_access_client(p_client_id uuid) returns boolean language sql stable as
      $$ select p_client_id = '${CLIENT}' $$;
    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;
    create function active_video_approval_manager(uuid) returns uuid language sql stable as
      $$ select '${ADMIN}'::uuid $$;
    create function enqueue_agent_job_internal(
      p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
      p_actor uuid, p_params jsonb, p_description text
    ) returns uuid language plpgsql as $$
    declare v_id uuid;
    begin
      insert into agent_jobs (agent_key, client_id, input_table, input_id, created_by, params)
      values (p_agent_key, p_client_id, p_input_table, p_input_id, p_actor, p_params)
      returning id into v_id;
      return v_id;
    end; $$;
    insert into clients values ('${CLIENT}'), ('${OTHER}');
    insert into profiles values ('${ADMIN}', 'manager@example.com');
    insert into client_campaigns (id, client_id, name, audience, offer_summary)
      values ('${CAMPAIGN}', '${CLIENT}', 'Launch campaign', 'Founders', 'Premium service');
    insert into client_content_pillars values ('${PILLAR}', '${CLIENT}', true, 'Trusted expertise');
    insert into client_briefs (id, client_id, body, content_format, media_type)
      values ('${OUTPUT}', '${CLIENT}', 'A real brief', 'single', 'image');
    insert into client_briefs (id, client_id, body, content_format, media_type)
      values ('${OTHER_OUTPUT}', '${OTHER}', 'Other brief', 'single', 'image');
    insert into agents values ('brief', false), ('ideation', false),
      ('creative_build', false), ('video_build', false), ('video_edit', false);
  `);
  await db.exec(await migration());
  await db.exec(await dailyMigration());
  await db.exec(await recoveryMigration());
  await db.exec(await alertMigration());
  await db.exec(await attributionMigration());
  await db.exec(await learningMigration());
  await db.exec(await dailyQaMigration());
  await db.exec(await dailySequenceMigration());
  await db.exec(await creativeRoutingMigration());
});

beforeEach(async () => {
  await db.exec("delete from client_daily_package_settings; delete from client_engine_settings");
  await db.exec("delete from workflow_runs; delete from agent_jobs");
  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
});

describe("v5 workflow spine", () => {
  it("queues creative build with a persisted render for still and reel opening frames", async () => {
    const imageBrief = "33333333-3333-4333-8333-333333333331";
    const reelBrief = "33333333-3333-4333-8333-333333333332";
    await db.exec(`insert into client_briefs (id,client_id,body,content_format,media_type)
      values ('${imageBrief}','${CLIENT}','Static asset brief','single','image'),
        ('${reelBrief}','${CLIENT}','Reel opening frames','reel','video')`);
    const run = await makeRun("creative-routing");
    await service(`select id from add_workflow_agent_step('${run.id}','static_create','{}',
      'creative_build','client_briefs','${imageBrief}')`);
    await service(`select id from add_workflow_agent_step('${run.id}','reel_create','{}',
      'creative_build','client_briefs','${reelBrief}')`);
    await seal(run.id);
    expect((await service<{ steps_queued: number }>(
      "select * from reconcile_workflow_runs()")).steps_queued).toBe(2);
    const jobs = await db.query<{ input_id: string; render_id: string; media_type: string }>(`
      select j.input_id,j.params->>'render_id' as render_id,g.media_type::text
      from workflow_steps s join agent_jobs j on j.id=s.job_id
      join creative_renders r on r.id=(j.params->>'render_id')::uuid
      join creative_generations g on g.id=r.generation_id
      where s.run_id='${run.id}' order by s.step_key`);
    expect(jobs.rows).toEqual([
      { input_id: reelBrief, render_id: expect.any(String), media_type: "image" },
      { input_id: imageBrief, render_id: expect.any(String), media_type: "image" },
    ]);
    expect((await service<{ steps_queued: number }>(
      "select * from reconcile_workflow_runs()")).steps_queued).toBe(0);
    expect((await one<{ n: number }>("select count(*)::integer as n from creative_renders")).n).toBe(2);
  });

  it("recovers the missing-render failure without losing the failed job history", async () => {
    const run = await makeRun("creative-recovery");
    const step = await service<{ id: string }>(`select id from add_workflow_agent_step(
      '${run.id}','static_create','{}','creative_build','client_briefs','${OUTPUT}')`);
    await seal(run.id);
    await service("select * from reconcile_workflow_runs()");
    const oldJob = await one<{ job_id: string }>(`select job_id from workflow_steps where id='${step.id}'`);
    await db.exec(`update agent_jobs set status='failed',error='No render to produce.',
      terminal=true where id='${oldJob.job_id}'`);
    await service("select * from reconcile_workflow_runs()");
    expect((await one<{ status: string }>(`select status from workflow_runs where id='${run.id}'`)).status)
      .toBe("blocked");
    await service(`select id from retry_missing_render_workflow_step('${step.id}')`);
    expect((await service<{ steps_queued: number }>(
      "select * from reconcile_workflow_runs()")).steps_queued).toBe(1);
    const newJob = await one<{ job_id: string; render_id: string }>(`
      select s.job_id,j.params->>'render_id' as render_id from workflow_steps s
      join agent_jobs j on j.id=s.job_id where s.id='${step.id}'`);
    expect(newJob.job_id).not.toBe(oldJob.job_id);
    expect(newJob.render_id).toEqual(expect.any(String));
    expect((await one<{ status: string }>(`select status from agent_jobs where id='${oldJob.job_id}'`)).status)
      .toBe("failed");
    await expect(service(`select id from retry_missing_render_workflow_step('${step.id}')`))
      .rejects.toThrow(/not eligible/);
  });
  it("creates one root run for a repeated request and refuses changed inputs", async () => {
    const first = await makeRun();
    const second = await makeRun();
    expect(second.id).toBe(first.id);
    await expect(makeRun("day-1", "'{\"brief\":\"changed\"}'::jsonb"))
      .rejects.toThrow(/idempotency_conflict/);
    await expect(service(`select id from create_workflow_run(
      '${CLIENT}', 'daily_content_package', 'v5.1', 'wrong-campaign', '{}'::jsonb,
      timestamptz '2099-01-01', '${OTHER}')`)).rejects.toThrow(/Campaign/);
  });

  it("rejects unauthorized writers and unknown dependencies", async () => {
    const run = await makeRun();
    await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false)");
    await expect(one(`select id from create_workflow_run(
      '${CLIENT}', 'daily_content_package', 'v5.1', 'unauthorized', '{}'::jsonb,
      timestamptz '2099-01-01')`)).rejects.toThrow(/service role/);
    await expect(one(`select id from add_workflow_agent_step(
      '${run.id}', 'first', array[]::text[], 'brief', 'client_ideas', '${INPUT}')`))
      .rejects.toThrow(/service role/);
    await expect(addStep(run.id, "second", "array['missing']::text[]"))
      .rejects.toThrow(/Unknown or circular dependency/);
    await expect(seal(run.id)).rejects.toThrow(/at least one planned step/);
  });

  it("queues each step once, waits for verified output, then advances dependencies", async () => {
    const run = await makeRun();
    const first = await addStep(run.id, "first");
    const second = await addStep(run.id, "second", "array['first']::text[]");
    expect((await service<{ steps_queued: number }>("select * from reconcile_workflow_runs()"))
      .steps_queued).toBe(0);
    await seal(run.id);
    await expect(addStep(run.id, "late")).rejects.toThrow(/sealed/);

    const tick1 = await service<{ steps_queued: number }>("select * from reconcile_workflow_runs()");
    expect(tick1.steps_queued).toBe(1);
    const tick2 = await service<{ steps_queued: number }>("select * from reconcile_workflow_runs()");
    expect(tick2.steps_queued).toBe(0);
    const jobs1 = await one<{ n: number }>("select count(*)::integer as n from agent_jobs");
    expect(jobs1.n).toBe(1);

    await db.exec(`update agent_jobs set status = 'completed' where run_id = '${run.id}'`);
    const tick3 = await service<{ steps_for_qa: number }>("select * from reconcile_workflow_runs()");
    expect(tick3.steps_for_qa).toBe(1);
    expect((await one<{ status: string }>(`select status from workflow_steps where id = '${first.id}'`)).status)
      .toBe("needs_internal_qa");
    expect((await one<{ status: string }>(`select status from workflow_steps where id = '${second.id}'`)).status)
      .toBe("pending");
    await expect(service(`select id from accept_workflow_step(
      '${first.id}', 'brief', '${OUTPUT}', 'v1', '{}'::jsonb)`))
      .rejects.toThrow(/QA evidence/);
    await expect(service(`select id from accept_workflow_step(
      '${first.id}', 'brief', '${OTHER_OUTPUT}', 'v1',
      '{"result":"pass","checks":["brief_fields"]}'::jsonb)`))
      .rejects.toThrow(/another client/);
    await expect(service(`select id from accept_workflow_step(
      '${first.id}', 'brief', '${OUTPUT}', 'v1',
      '{"result":"pass","checks":["brief_fields"]}'::jsonb)`))
      .rejects.toThrow(/missing or belongs/);
    await db.exec(`update client_briefs set job_id = (select job_id from workflow_steps
      where id = '${first.id}') where id = '${OUTPUT}'`);
    await service(`select id from accept_workflow_step(
      '${first.id}', 'brief', '${OUTPUT}', 'v1', '{"result":"pass","checks":["brief_fields"]}'::jsonb)`);
    await expect(service(`select id from accept_workflow_step(
      '${first.id}', 'brief', '${OUTPUT}', 'different',
      '{"result":"pass","checks":["brief_fields"]}'::jsonb)`))
      .rejects.toThrow(/idempotency_conflict/);
    const again = await addStep(run.id, "first");
    expect(again.id).toBe(first.id);
    const tick4 = await service<{ steps_queued: number }>("select * from reconcile_workflow_runs()");
    expect(tick4.steps_queued).toBe(1);
    const jobs2 = await one<{ n: number }>("select count(*)::integer as n from agent_jobs");
    expect(jobs2.n).toBe(2);
    const linked = await one<{ n: number }>(`select count(*)::integer as n from agent_jobs
      where run_id = '${run.id}' and params->>'v5_workflow_run_id' = '${run.id}'`);
    expect(linked.n).toBe(2);

    await db.exec(`update agent_jobs set status = 'completed' where id = (
      select job_id from workflow_steps where id = '${second.id}')`);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`update client_briefs set job_id = (select job_id from workflow_steps
      where id = '${second.id}') where id = '${OUTPUT}'`);
    await service(`select id from accept_workflow_step(
      '${second.id}', 'brief', '${OUTPUT}', 'v2', '{"result":"pass","checks":["brief_fields"]}'::jsonb)`);
    expect((await one<{ status: string }>(`select status from workflow_runs where id = '${run.id}'`)).status)
      .toBe("awaiting_human_approval");
  });

  it("blocks a terminal failed job and never queues its dependent", async () => {
    const run = await makeRun();
    const first = await addStep(run.id, "first");
    await addStep(run.id, "second", "array['first']::text[]");
    await seal(run.id);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`update agent_jobs set status = 'failed', terminal = true, error = 'Provider failed.'
      where id = (select job_id from workflow_steps where id = '${first.id}')`);
    const result = await service<{ steps_blocked: number }>("select * from reconcile_workflow_runs()");
    expect(result.steps_blocked).toBe(1);
    const state = await one<{ status: string; blocker: string }>(`select status, blocker
      from workflow_runs where id = '${run.id}'`);
    expect(state).toEqual({ status: "blocked", blocker: "Provider failed." });
    expect((await one<{ n: number }>("select count(*)::integer as n from agent_jobs")).n).toBe(1);
  });

  it("passes only the accepted prior output into a dependent job", async () => {
    const run = await makeRun("derived-input");
    const ideaStep = await service<{ id: string }>(`select id from add_workflow_agent_step(
      '${run.id}', 'idea', array[]::text[], 'ideation', 'clients', '${CLIENT}')`);
    const briefStep = await service<{ id: string }>(`select id from add_workflow_agent_step(
      '${run.id}', 'brief', array['idea']::text[], 'brief', 'client_ideas', null,
      '{}'::jsonb, 'idea')`);
    await seal(run.id);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`insert into client_ideas (id, client_id, job_id, title)
      values ('${IDEA}', '${CLIENT}', (select job_id from workflow_steps where id = '${ideaStep.id}'),
      'An accepted idea')`);
    await db.exec(`update agent_jobs set status = 'completed' where id =
      (select job_id from workflow_steps where id = '${ideaStep.id}')`);
    await service("select * from reconcile_workflow_runs()");
    await service(`select id from accept_workflow_step('${ideaStep.id}', 'idea', '${IDEA}',
      'v1', '{"result":"pass","checks":["angle"]}'::jsonb)`);
    const queued = await service<{ steps_queued: number }>("select * from reconcile_workflow_runs()");
    expect(queued.steps_queued).toBe(1);
    const linked = await one<{ input_id: string; resolved_input_id: string }>(`
      select j.input_id, s.resolved_input_id from workflow_steps s
      join agent_jobs j on j.id = s.job_id where s.id = '${briefStep.id}'`);
    expect(linked).toEqual({ input_id: IDEA, resolved_input_id: IDEA });
  });

  it("automatically accepts one correctly scoped daily idea with persisted QA evidence", async () => {
    const ideaId = "88888888-8888-4888-8888-888888888888";
    const briefId = "99999999-9999-4999-8999-999999999998";
    const run = await makeRun("daily-auto-qa", `'{"pillar_id":"${PILLAR}"}'::jsonb`);
    const step = await service<{ id: string }>(`select id from add_workflow_agent_step(
      '${run.id}', 'reel_idea', '{}'::text[], 'ideation', 'clients', '${CLIENT}',
      '{"target_platform":"instagram","content_format":"reel","media_type":"video"}'::jsonb)`);
    const briefStep = await service<{ id: string }>(`select id from add_workflow_agent_step(
      '${run.id}','reel_brief',array['reel_idea'],'brief','client_ideas',null,
      '{}'::jsonb,'reel_idea')`);
    await seal(run.id);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`insert into client_ideas (id,client_id,job_id,title,body,campaign_id,
      pillar_id,target_platform,content_format,media_type,source_question)
      values ('${ideaId}','${CLIENT}',
        (select job_id from workflow_steps where id='${step.id}'),
        'Show the proof mechanism', 'An inspectable explanation of how the measurement works.',
        '${CAMPAIGN}','${PILLAR}','instagram','reel','video',
        'How will you prove which customers came from this?');
      update agent_jobs set status='completed' where id=
        (select job_id from workflow_steps where id='${step.id}')`);
    await service("select * from reconcile_workflow_runs()");
    const result = await service<{ steps_accepted: number; steps_blocked: number }>(
      "select * from accept_ready_daily_workflow_steps()");
    expect(result).toEqual({ steps_accepted: 1, steps_blocked: 0 });
    const accepted = await one<{ status: string; record_id: string; result: string }>(`
      select s.status,a.record_id,a.qa_evidence->>'result' as result
      from workflow_steps s join workflow_artifacts a on a.step_id=s.id
      where s.id='${step.id}'`);
    expect(accepted).toEqual({ status: "completed", record_id: ideaId, result: "pass" });
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`insert into client_briefs
      (id,client_id,job_id,source_idea_id,body,content_format,media_type,target_platform)
      values ('${briefId}','${CLIENT}',
        (select job_id from workflow_steps where id='${briefStep.id}'),
        '${ideaId}',
        'The reel opens with the buyer asking to inspect the attribution report, then shows each count and ends with a concrete request to see the method.',
        'reel','video','instagram');
      update agent_jobs set status='completed' where id=
        (select job_id from workflow_steps where id='${briefStep.id}')`);
    await service("select * from reconcile_workflow_runs()");
    expect((await service<{ steps_accepted: number }>(
      "select * from accept_ready_daily_workflow_steps()")).steps_accepted).toBe(1);
    expect((await service<{ steps_accepted: number }>(
      "select * from accept_ready_daily_workflow_steps()")).steps_accepted).toBe(0);
  });

  it("advances a daily reel only through stored opening, clips and accepted final review", async () => {
    const briefId = "33333333-3333-4333-8333-333333333333";
    const assetId = "44444444-4444-4444-8444-444444444444";
    const candidateId = "55555555-5555-4555-8555-555555555555";
    await db.exec(`insert into client_briefs (id,client_id,body,content_format,media_type)
      values ('${briefId}','${CLIENT}','A complete reel brief with a clear hook, mechanism, proof limitation and call to action.','reel','video')`);
    const run = await makeRun("daily-video-qa");
    await service(`select id from add_workflow_agent_step('${run.id}','reel_create','{}'::text[],
      'creative_build','client_briefs','${briefId}')`);
    await service(`select id from add_workflow_agent_step('${run.id}','reel_motion',
      array['reel_create'],'video_build','client_briefs','${briefId}')`);
    await service(`select id from add_workflow_agent_step('${run.id}','reel_edit',
      array['reel_motion'],'video_edit','client_media_assets',null,
      '{}'::jsonb,'reel_motion')`);
    await seal(run.id);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`insert into client_media_assets
      (id,client_id,brief_id,storage_path,content_format,media_type,created_at)
      values ('${assetId}','${CLIENT}','${briefId}','client/opening.jpg','reel','video',now());
      update agent_jobs set status='completed' where id=(select job_id from workflow_steps
        where run_id='${run.id}' and step_key='reel_create')`);
    await service("select * from reconcile_workflow_runs()");
    expect((await service<{ steps_accepted: number }>(
      "select * from accept_ready_daily_workflow_steps()")).steps_accepted).toBe(1);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`insert into client_media_frames (asset_id,clip_path)
      values ('${assetId}','clip-one.mp4'),('${assetId}','clip-two.mp4');
      update agent_jobs set status='completed' where id=(select job_id from workflow_steps
        where run_id='${run.id}' and step_key='reel_motion')`);
    await service("select * from reconcile_workflow_runs()");
    expect((await service<{ steps_accepted: number }>(
      "select * from accept_ready_daily_workflow_steps()")).steps_accepted).toBe(1);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`update client_media_assets set render_path='client/final.mp4',updated_at=now()
      where id='${assetId}';
      insert into video_render_candidates
      (id,asset_id,job_id,attempt,verdict,render_path,media_probe,creative_review)
      values ('${candidateId}','${assetId}',
        (select job_id from workflow_steps where run_id='${run.id}' and step_key='reel_edit'),
        1,'accepted','client/final.mp4','{"result":"pass"}','{"result":"pass"}');
      update agent_jobs set status='completed' where id=(select job_id from workflow_steps
        where run_id='${run.id}' and step_key='reel_edit')`);
    await service("select * from reconcile_workflow_runs()");
    expect((await service<{ steps_accepted: number }>(
      "select * from accept_ready_daily_workflow_steps()")).steps_accepted).toBe(1);
    const final = await one<{ status: string; candidate_id: string }>(`
      select r.status,a.qa_evidence->>'candidate_id' as candidate_id
      from workflow_runs r join workflow_artifacts a on a.run_id=r.id
      join workflow_steps s on s.id=a.step_id and s.step_key='reel_edit'
      where r.id='${run.id}'`);
    expect(final).toEqual({ status: "awaiting_human_approval", candidate_id: candidateId });
  });

  it("blocks a completed daily job with no output instead of advancing its graph", async () => {
    const run = await makeRun("daily-empty-output");
    const step = await service<{ id: string }>(`select id from add_workflow_agent_step(
      '${run.id}','reel_idea','{}'::text[],'ideation','clients','${CLIENT}')`);
    await seal(run.id);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`update agent_jobs set status='completed' where id=
      (select job_id from workflow_steps where id='${step.id}')`);
    await service("select * from reconcile_workflow_runs()");
    const result = await service<{ steps_accepted: number; steps_blocked: number }>(
      "select * from accept_ready_daily_workflow_steps()");
    expect(result).toEqual({ steps_accepted: 0, steps_blocked: 1 });
    const state = await one<{ status: string; blocker: string }>(`
      select status,blocker from workflow_runs where id='${run.id}'`);
    expect(state).toEqual({ status: "blocked", blocker: "Daily ideation must produce exactly one idea." });
  });

  it("plans exactly four roles once, freezes context, and seals the dependency graph", async () => {
    await db.exec(`insert into client_daily_package_settings
      (client_id, enabled, campaign_id, pillar_id)
      values ('${CLIENT}', true, '${CAMPAIGN}', '${PILLAR}')`);
    const first = await service<{ id: string; run_id: string }>(`
      select id, run_id from plan_daily_package('${CLIENT}', date '2099-01-02')`);
    const second = await service<{ id: string; run_id: string }>(`
      select id, run_id from plan_daily_package('${CLIENT}', date '2099-01-02')`);
    expect(second).toEqual(first);
    const roles = await db.query<{ role: string; content_format: string; media_type: string }>(`
      select role, content_format, media_type from daily_package_items
      where package_id = '${first.id}' order by role`);
    expect(roles.rows).toEqual([
      { role: "reel", content_format: "reel", media_type: "video" },
      { role: "static_a", content_format: "single", media_type: "image" },
      { role: "static_b", content_format: "single", media_type: "image" },
      { role: "story", content_format: "story", media_type: "image" },
    ]);
    const graph = await one<{ n: number; sealed: boolean; audience: string }>(`
      select (select count(*)::integer from workflow_steps where run_id = '${first.run_id}') as n,
        sealed_at is not null as sealed, input_snapshot->>'audience' as audience
      from workflow_runs where id = '${first.run_id}'`);
    expect(graph).toEqual({ n: 14, sealed: true, audience: "Founders" });
    const ideaDependencies = await db.query<{ step_key: string; dependencies: string[] }>(`
      select step_key,dependencies from workflow_steps
      where run_id='${first.run_id}' and agent_key='ideation' order by step_key`);
    expect(ideaDependencies.rows).toEqual([
      { step_key: "reel_idea", dependencies: [] },
      { step_key: "static_a_idea", dependencies: ["story_idea"] },
      { step_key: "static_b_idea", dependencies: ["static_a_idea"] },
      { step_key: "story_idea", dependencies: ["reel_idea"] },
    ]);
    const readiness = await service<{ result: {
      planned_count: number; accepted_count: number; ready_for_review: boolean;
    } }>(`select daily_package_readiness('${first.id}') as result`);
    expect(readiness.result).toMatchObject({
      planned_count: 4, accepted_count: 0, ready_for_review: false,
    });
    await service("select * from reconcile_workflow_runs()");
    const reelIdeaStep = await service<{ id: string }>(`select id from workflow_steps
      where run_id = '${first.run_id}' and step_key = 'reel_idea'`);
    const wrongIdea = "66666666-6666-4666-8666-666666666666";
    await db.exec(`insert into client_ideas (id, client_id, job_id, title,
      campaign_id, pillar_id, target_platform, content_format, media_type)
      values ('${wrongIdea}', '${CLIENT}',
        (select job_id from workflow_steps where id = '${reelIdeaStep.id}'),
        'Wrong campaign idea', '${OTHER}', '${PILLAR}', 'instagram', 'reel', 'video');
      update agent_jobs set status = 'completed' where id =
        (select job_id from workflow_steps where id = '${reelIdeaStep.id}')`);
    await service("select * from reconcile_workflow_runs()");
    await expect(service(`select id from accept_workflow_step('${reelIdeaStep.id}',
      'idea', '${wrongIdea}', 'v1', '{"result":"pass","checks":["scope"]}'::jsonb)`))
      .rejects.toThrow(/does not match its role/);
    await db.exec(`insert into client_engine_settings values ('${CLIENT}', true)`);
    await expect(service(`select id from plan_daily_package('${CLIENT}', date '2099-01-03')`))
      .rejects.toThrow(/legacy engine/);
  });

  it("accepts video motion only for the prior accepted still asset with every clip present", async () => {
    const run = await makeRun("video-chain");
    const still = await service<{ id: string }>(`select id from add_workflow_agent_step(
      '${run.id}', 'still', '{}', 'creative_build', 'client_briefs', '${OUTPUT}')`);
    const motion = await service<{ id: string }>(`select id from add_workflow_agent_step(
      '${run.id}', 'motion', array['still']::text[], 'video_build',
      'client_briefs', '${OUTPUT}')`);
    await seal(run.id);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`insert into client_media_assets
      (id, client_id, brief_id, storage_path) values
      ('${IDEA}', '${CLIENT}', '${OUTPUT}', 'client/generated/still.png')`);
    await db.exec(`update agent_jobs set status = 'completed' where id =
      (select job_id from workflow_steps where id = '${still.id}')`);
    await service("select * from reconcile_workflow_runs()");
    await service(`select id from accept_workflow_step('${still.id}', 'asset', '${IDEA}',
      'still-v1', '{"result":"pass","checks":["still"]}'::jsonb)`);
    await service("select * from reconcile_workflow_runs()");
    await db.exec(`insert into client_media_frames (asset_id, clip_path)
      values ('${IDEA}', 'client/generated/clip-1.mp4'), ('${IDEA}', null)`);
    await db.exec(`update agent_jobs set status = 'completed' where id =
      (select job_id from workflow_steps where id = '${motion.id}')`);
    await service("select * from reconcile_workflow_runs()");
    await expect(service(`select id from accept_workflow_step('${motion.id}', 'asset', '${IDEA}',
      'motion-v1', '{"result":"pass","checks":["clips"]}'::jsonb)`))
      .rejects.toThrow(/missing or belongs/);
    await db.exec(`update client_media_frames set clip_path = 'client/generated/clip-2.mp4'
      where asset_id = '${IDEA}' and clip_path is null`);
    await service(`select id from accept_workflow_step('${motion.id}', 'asset', '${IDEA}',
      'motion-v1', '{"result":"pass","checks":["clips"]}'::jsonb)`);
  });

  it("rejects a daily package configured with another client's campaign", async () => {
    await db.exec(`insert into client_daily_package_settings
      (client_id, enabled, campaign_id, pillar_id)
      values ('${OTHER}', true, '${CAMPAIGN}', '${PILLAR}')`);
    await expect(service(`select id from plan_daily_package('${OTHER}', date '2099-01-04')`))
      .rejects.toThrow(/same-client active pillar/);
    expect((await one<{ n: number }>("select count(*)::integer as n from workflow_runs")).n)
      .toBe(0);
  });

  it("uses only a compatible human-approved reserve for a blocked final item", async () => {
    const reserve = "88888888-8888-4888-8888-888888888888";
    const reserveIdea = "77777777-7777-4777-8777-777777777777";
    await db.exec(`insert into client_daily_package_settings
      (client_id, enabled, campaign_id, pillar_id)
      values ('${CLIENT}', true, '${CAMPAIGN}', '${PILLAR}')`);
    const pkg = await service<{ id: string; run_id: string }>(`
      select id, run_id from plan_daily_package('${CLIENT}', date '2099-01-05')`);
    const item = await service<{ id: string; final_step_id: string }>(`
      select id, final_step_id from daily_package_items where package_id = '${pkg.id}' and role = 'reel'`);
    await db.exec(`update workflow_steps set status = 'blocked', blocker = 'Motion failed.'
      where id = '${item.final_step_id}';
      update workflow_runs set status = 'blocked', blocker = 'Motion failed.'
      where id = '${pkg.run_id}';
      insert into client_ideas (id, client_id, title, campaign_id, pillar_id,
        target_platform, content_format, media_type)
        values ('${reserveIdea}', '${CLIENT}', 'Evergreen proof', '${CAMPAIGN}',
          '${PILLAR}', 'instagram', 'reel', 'video');
      update client_briefs set source_idea_id = '${reserveIdea}',
        content_format = 'reel', media_type = 'video', target_platform = 'instagram'
        where id = '${OUTPUT}';
      insert into client_media_assets (id, client_id, brief_id, storage_path, render_path,
        content_format, media_type, review_status, created_at)
        values ('${reserve}', '${CLIENT}', '${OUTPUT}', 'client/reserve/still.png',
          'client/reserve/cut.mp4', 'reel', 'video', 'approved', now() - interval '1 day');
      insert into post_copy values ('${reserve}', 'instagram', 'A finished reserve caption');`);
    const missing = await service<{ result: unknown }>(`
      select recover_daily_package_item('${item.id}', 'Provider failure') as result`);
    expect(missing.result).toBeNull();
    expect((await service<{ n: number }>(`select count(*)::integer as n
      from daily_package_recovery_alerts where item_id = '${item.id}' and resolved_at is null`)).n).toBe(1);
    const alert = await service<{ alert_id: string; manager_email: string; item_role: string }>(`
      select alert_id, manager_email, item_role from claim_daily_recovery_alert('worker-a')`);
    expect(alert.manager_email).toBe('manager@example.com');
    expect(alert.item_role).toBe('reel');
    await expect(service(`select id from complete_daily_recovery_alert(
      '${alert.alert_id}', 'another-worker', true, 'resend-1')`))
      .rejects.toThrow(/not leased/);
    await service(`select id from complete_daily_recovery_alert(
      '${alert.alert_id}', 'worker-a', true, 'resend-1')`);
    expect((await service<{ delivery_status: string }>(`select delivery_status
      from daily_package_recovery_alerts where id = '${alert.alert_id}'`)).delivery_status).toBe('sent');
    await db.exec(`update client_media_assets set human_approved_at = now()
      where id = '${reserve}'`);
    await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false)");
    await expect(one(`select id from recover_daily_package_item('${item.id}', 'Provider failure')`))
      .rejects.toThrow(/service role/);
    expect((await service<{ available: number; shortfall: number }>(`
      select available, shortfall from daily_reserve_coverage('${CLIENT}')
      where role = 'reel'`))).toEqual({ available: 1, shortfall: 6 });
    const selected = await service<{ reserve_asset_id: string }>(`
      select reserve_asset_id from recover_daily_package_item('${item.id}', 'Provider failure')`);
    expect(selected.reserve_asset_id).toBe(reserve);
    expect((await service<{ asset_id: string }>(`select asset_id from daily_package_items
      where id = '${item.id}'`)).asset_id).toBe(reserve);
    expect((await service<{ status: string }>(`select status from workflow_steps
      where id = '${item.final_step_id}'`)).status).toBe("completed");
    expect((await service<{ n: number }>(`select count(*)::integer as n
      from daily_package_recovery_alerts where item_id = '${item.id}' and resolved_at is null`)).n).toBe(0);
    expect((await service<{ available: number }>(`
      select available from daily_reserve_coverage('${CLIENT}') where role = 'reel'`)).available).toBe(0);
    await expect(service(`select id from recover_daily_package_item('${item.id}', 'Different reason')`))
      .rejects.toThrow(/idempotency_conflict/);
  });

  it("reports observed, unknown and missing attribution without inventing revenue", async () => {
    const run = await makeRun("outcome-report");
    const step = await addStep(run.id, "asset");
    const noData = await service<{ workflow_run_outcomes: Record<string, unknown> }>(
      `select workflow_run_outcomes('${run.id}')`,
    );
    expect(noData.workflow_run_outcomes.attribution_coverage).toBeNull();
    expect(noData.workflow_run_outcomes.observed_cash).toBeNull();
    expect(noData.workflow_run_outcomes.deadline_met).toBeNull();
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    await db.exec(`insert into client_media_assets (id, client_id)
      values ('${INPUT}', '${CLIENT}');
      insert into workflow_artifacts (run_id, artifact_kind, record_id, version_key,
        qa_evidence, step_id) values ('${run.id}', 'asset', '${INPUT}', 'v1',
        '{}'::jsonb, '${step.id}');
      insert into client_leads (id, client_id, source_asset_id, cash_collected)
      values ('${first}', '${CLIENT}', '${INPUT}', 100),
        ('${second}', '${CLIENT}', null, 200);`);
    await expect(service(`select * from record_workflow_lead_attribution(
      '${run.id}', '${second}', 'observed',
      '{"source":"asset","source_id":"${INPUT}"}'::jsonb)`))
      .rejects.toThrow(/linked source/);
    await service(`select * from record_workflow_lead_attribution(
      '${run.id}', '${first}', 'observed',
      '{"source":"asset","source_id":"${INPUT}"}'::jsonb)`);
    await service(`select * from record_workflow_lead_attribution(
      '${run.id}', '${second}', 'unknown', '{"reason":"No tracked source"}'::jsonb)`);
    await expect(service(`select * from record_workflow_lead_attribution(
      '${run.id}', '${first}', 'estimated',
      '{"method":"model","source_ids":["x"]}'::jsonb)`))
      .rejects.toThrow(/idempotency_conflict/);
    const result = await service<{ workflow_run_outcomes: Record<string, unknown> }>(
      `select workflow_run_outcomes('${run.id}')`,
    );
    expect(result.workflow_run_outcomes).toMatchObject({
      linked_leads: 2, observed_leads: 1, unknown_leads: 1,
      attribution_coverage: 0.5, observed_cash: 100, estimated_cash: 0,
    });
    await db.exec(`update workflow_runs set status = 'awaiting_human_approval'
      where id = '${run.id}'`);
    const ready = await service<{ workflow_run_outcomes: Record<string, unknown> }>(
      `select workflow_run_outcomes('${run.id}')`,
    );
    expect(ready.workflow_run_outcomes.review_ready_at).toBeTruthy();
    expect(ready.workflow_run_outcomes.deadline_met).toBe(true);
  });

  it("freezes review feedback and observed links for one ideation job", async () => {
    const run = await makeRun("learning-source");
    const step = await addStep(run.id, "asset");
    const asset = "00000000-0000-4000-8000-000000000011";
    const lead = "00000000-0000-4000-8000-000000000012";
    await db.exec(`insert into client_media_assets
      (id, client_id, brief_id, human_approved_at, title)
      values ('${asset}', '${CLIENT}', '${OUTPUT}', now(), 'A specific asset');
      insert into workflow_artifacts (run_id, step_id, artifact_kind, record_id,
        version_key, qa_evidence)
      values ('${run.id}', '${step.id}', 'asset', '${asset}', 'v1', '{}'::jsonb);
      insert into client_leads (id, client_id, source_asset_id, cash_collected)
      values ('${lead}', '${CLIENT}', '${asset}', 50);
      update workflow_runs set status = 'awaiting_human_approval' where id = '${run.id}';`);
    await service(`select * from record_workflow_lead_attribution(
      '${run.id}', '${lead}', 'observed',
      '{"source":"asset","source_id":"${asset}"}'::jsonb)`);
    const job = await one<{ id: string }>(`insert into agent_jobs (agent_key, client_id)
      values ('ideation', '${CLIENT}') returning id`);
    const first = await service<{ capture_ideation_learning_context: {
      creative: Array<{ asset_id: string; observed_linked_leads: number }>;
      runs: Array<{ observed_leads: number }>;
    } }>(`select capture_ideation_learning_context('${job.id}')`);
    expect(first.capture_ideation_learning_context.creative).toEqual(
      expect.arrayContaining([expect.objectContaining({
        asset_id: asset, observed_linked_leads: 1,
      })]),
    );
    expect(first.capture_ideation_learning_context.runs[0]?.observed_leads).toBe(1);
    await db.exec(`insert into client_asset_reviews (asset_id, decision, reason)
      values ('${asset}', 'rejected', 'The caption overstated the evidence.');`);
    const second = await service<typeof first>(
      `select capture_ideation_learning_context('${job.id}')`,
    );
    expect(second).toEqual(first);
    await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false)");
    await expect(one(`select capture_ideation_learning_context('${job.id}')`))
      .rejects.toThrow(/service role/);
  });
});
