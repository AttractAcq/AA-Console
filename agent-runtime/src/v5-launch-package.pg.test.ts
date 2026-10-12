import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PAGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let db: PGlite;

async function service<T>(sql: string): Promise<T> {
  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
  return (await db.query<T>(sql)).rows[0]!;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create table clients (id uuid primary key);
    create table profiles (id uuid primary key);
    create table client_campaigns (id uuid primary key, client_id uuid, name text,
      built_at timestamptz, audience text, offer_summary text, core_message text,
      status text, needs_landing_page boolean, needs_sales_agent boolean,
      content_count integer, meta_campaign_id text);
    create table client_agent_records (id uuid primary key, client_id uuid,
      domain text, body text, updated_at timestamptz default now(), job_id uuid);
    create table client_proof_assets (id uuid primary key, client_id uuid,
      usage_rights text, expires_on date, strength integer, created_at timestamptz default now());
    create table client_ideas (id uuid primary key, client_id uuid, job_id uuid, title text);
    create table client_briefs (id uuid primary key, client_id uuid, job_id uuid, body text);
    create table client_media_assets (id uuid primary key, client_id uuid,
      brief_id uuid, storage_path text, render_path text, media_type text,
      created_at timestamptz default now(), updated_at timestamptz default now());
    create table client_media_frames (asset_id uuid, clip_path text);
    create table client_pages (id uuid primary key, client_id uuid, job_id uuid, body text, html text);
    create table client_sales_agents (id uuid primary key, client_id uuid,
      job_id uuid, built_at timestamptz, system_prompt text);
    create table campaign_artifacts (campaign_id uuid, asset_id uuid,
      page_id uuid, sales_agent_id uuid);
    create table agents (agent_key text primary key);
    create table agent_jobs (id uuid primary key default gen_random_uuid(),
      client_id uuid, agent_key text, input_table text, input_id uuid,
      created_by uuid, params jsonb, run_id uuid, status text,
      terminal boolean default false, attempts integer default 0,
      max_attempts integer default 3, error text, created_at timestamptz default now());
    create function can_access_client(uuid) returns boolean language sql as $$ select true $$;
    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;
    create function enqueue_agent_job_internal(text, uuid, text, uuid, uuid, jsonb, text)
      returns uuid language sql as $$ select gen_random_uuid() $$;
    insert into clients values ('${CLIENT}'), ('${OTHER}');
    insert into client_campaigns values ('${CAMPAIGN}', '${CLIENT}', 'Campaign',
      now(), 'Founders', 'Premium service', 'Diagnose before buying traffic',
      'planning', true, true, 1, 'paused-meta-123');
  `);
  const path = (name: string) => new URL(`../../supabase/migrations/${name}`, import.meta.url);
  await db.exec(await readFile(path("20261012090000_190_v5_workflow_spine.sql"), "utf8"));
  await db.exec(await readFile(path("20261012120000_193_v5_launch_package.sql"), "utf8"));
});

describe("client launch package", () => {
  it("records missing preflight facts as an explicit blocker", async () => {
    const result = await service<{ id: string; run_id: string }>(`
      select id, run_id from start_client_launch_package('${CAMPAIGN}', 'missing-inputs',
      timestamptz '2099-01-01')`);
    const state = (await db.query<{ status: string; blocker: string }>(`
      select status, blocker from workflow_runs where id = '${result.run_id}'`)).rows[0];
    expect(state?.status).toBe("needs_input");
    expect(state?.blocker).toMatch(/Brand context/);
    expect(state?.blocker).toMatch(/Cleared proof/);
    await expect(service(`select check_key from record_client_launch_check('${result.id}',
      'measurement', '${CAMPAIGN}', '{"result":"pass","checks":["events"]}'::jsonb)`))
      .rejects.toThrow(/preflight inputs/);
  });

  it("needs real linked components and conversion evidence before human review", async () => {
    await db.exec(`
      insert into client_agent_records (id, client_id, domain, body) values
        ('11111111-1111-4111-8111-111111111112','${CLIENT}','brand_strategy','Brand rules'),
        ('11111111-1111-4111-8111-111111111113','${CLIENT}','icp','Buyer questions');
      insert into client_proof_assets (id, client_id, usage_rights, strength)
        values ('11111111-1111-4111-8111-111111111114','${CLIENT}','approved',5);
      insert into client_pages values ('${PAGE}','${CLIENT}',null,'Summary','<html>Page</html>');
      insert into client_sales_agents values ('${AGENT}','${CLIENT}',null,now(),'Safe prompt');
      insert into client_media_assets (id,client_id,storage_path,media_type)
        values ('${ASSET}','${CLIENT}','client/creative.png','image');
      insert into campaign_artifacts values ('${CAMPAIGN}','${ASSET}',null,null),
        ('${CAMPAIGN}',null,'${PAGE}',null), ('${CAMPAIGN}',null,null,'${AGENT}');
    `);
    const result = await service<{ id: string; run_id: string }>(`
      select id, run_id from start_client_launch_package('${CAMPAIGN}', 'complete-inputs',
      timestamptz '2099-01-01')`);
    expect((await service<{ id: string }>(`select id from start_client_launch_package(
      '${CAMPAIGN}', 'complete-inputs', timestamptz '2099-01-01')`)).id).toBe(result.id);
    await expect(service(`select check_key from record_client_launch_check('${result.id}',
      'organic_creative', '${ASSET}', '{"result":"pass","checks":["brand"]}'::jsonb)`))
      .rejects.toThrow(/missing, unbuilt/);
    await service(`select asset_id from record_client_launch_asset_check('${result.id}', '${ASSET}',
      '{"result":"pass","checks":["brand","dimensions"]}'::jsonb)`);
    for (const [key, id, checks] of [
      ["page", PAGE, '["page_audit"]'],
      ["sales_agent", AGENT, '["scenario_tests"]'],
      ["organic_creative", ASSET, '["asset_qa"]'],
      ["meta_handoff", CAMPAIGN, '["paused"]'],
      ["measurement", CAMPAIGN, '["tracking_ids","ingest"]'],
    ]) {
      await service(`select check_key from record_client_launch_check('${result.id}',
        '${key}', '${id}', '{"result":"pass","checks":${checks}}'::jsonb)`);
    }
    await expect(service(`select check_key from record_client_launch_check('${result.id}',
      'conversion_path', '${PAGE}', '{"result":"pass","checks":["links"]}'::jsonb)`))
      .rejects.toThrow(/end-to-end probe/);
    await expect(service(`select check_key from record_client_launch_check('${result.id}',
      'conversion_path', '${PAGE}',
      '{"result":"pass","checks":["links","lead_form","lead_routing","consent","events"]}'::jsonb)`))
      .rejects.toThrow(/checklist labels are not verification/);
    expect((await db.query<{ status: string }>(`select status from workflow_runs
      where id = '${result.run_id}'`)).rows[0]?.status).toBe("needs_internal_qa");
  });
});
