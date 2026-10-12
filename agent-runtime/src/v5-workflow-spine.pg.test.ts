import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = () => readFile(new URL(
  "../../supabase/migrations/20261012090000_190_v5_workflow_spine.sql", import.meta.url,
), "utf8");
const attributionMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012150000_196_v5_outcome_attribution.sql", import.meta.url,
), "utf8");
const learningMigration = () => readFile(new URL(
  "../../supabase/migrations/20261012160000_197_v5_ideation_learning.sql", import.meta.url,
), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMPAIGN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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
    create schema auth;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table clients (id uuid primary key);
    create table profiles (id uuid primary key);
    create table client_campaigns (id uuid primary key, client_id uuid not null, ad_campaign_id uuid);
    create table client_agent_records (id uuid primary key, client_id uuid not null, job_id uuid, body text);
    create table client_ideas (id uuid primary key, client_id uuid not null, job_id uuid,
      title text, source_question text, strategic_reason text);
    create table client_briefs (id uuid primary key, client_id uuid not null, job_id uuid,
      title text, body text, source_idea_id uuid);
    create table client_media_assets (id uuid primary key, client_id uuid not null, brief_id uuid,
      created_at timestamptz default now(), updated_at timestamptz default now(),
      storage_path text, render_path text, human_approved_at timestamptz, title text);
    create table client_media_frames (asset_id uuid, clip_path text);
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
    create function can_access_client(p_client_id uuid) returns boolean language sql stable as
      $$ select p_client_id = '${CLIENT}' $$;
    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;
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
    insert into profiles values ('${ADMIN}');
    insert into client_campaigns (id, client_id) values ('${CAMPAIGN}', '${CLIENT}');
    insert into client_briefs (id, client_id, body, title)
      values ('${OUTPUT}', '${CLIENT}', 'A real brief', 'Brief');
    insert into client_briefs (id, client_id, body, title)
      values ('${OTHER_OUTPUT}', '${OTHER}', 'Other brief', 'Other brief');
    insert into agents values ('brief', false), ('ideation', false);
  `);
  await db.exec(await migration());
  await db.exec(await attributionMigration());
  await db.exec(await learningMigration());
});

beforeEach(async () => {
  await db.exec("delete from workflow_runs; delete from agent_jobs");
  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
});

describe("v5 workflow spine", () => {
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
