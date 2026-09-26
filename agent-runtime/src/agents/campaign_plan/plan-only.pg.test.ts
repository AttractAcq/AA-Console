import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const campaign = "11111111-1111-4111-8111-111111111111";
const client = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    create table client_campaigns (
      id uuid primary key, client_id uuid not null, built_at timestamptz,
      objective text, audience text, offer_summary text, core_message text,
      channels text[] not null default '{}', budget numeric, starts_on date,
      ends_on date, kpi_metric text, kpi_target numeric, content_count integer not null default 0,
      needs_landing_page boolean not null default false,
      needs_sales_agent boolean not null default false, job_id uuid, updated_at timestamptz
    );
    create table agent_jobs (
      id uuid primary key, client_id uuid, agent_key text, input_table text, input_id uuid
    );
  `);
  const sql = await readFile(new URL("../../../../supabase/migrations/20260926100000_132_campaign_plan_without_ideas.sql", import.meta.url), "utf8");
  await db.exec(sql);
  await db.exec(`
    insert into client_campaigns(id,client_id,ideate_on_plan)
      values ('${campaign}','${client}',false);
    insert into agent_jobs(id,client_id,agent_key,input_table,input_id)
      values ('${job}','${client}','campaign_plan','client_campaigns','${campaign}');
    select set_config('request.jwt.claim.role','service_role',false);
  `);
});
afterAll(async () => { await db?.close(); });

const plan = {
  objective: "Applications", audience: "Experienced editors", offer_summary: "Editor role",
  core_message: "Join AA", channels: ["meta"], budget: null, starts_on: null,
  ends_on: null, kpi_metric: "Applications", kpi_target: null, content_count: 3,
  needs_landing_page: false, needs_sales_agent: false,
};

it("stores the campaign plan and reserved content count without generating ideas", async () => {
  await db.query("select save_campaign_plan_only($1,$2,$3,$4)", [campaign, client, job, plan]);
  const rows = await db.query<{ content_count: number; built_at: string; ideate_on_plan: boolean }>(
    "select content_count,built_at,ideate_on_plan from client_campaigns where id=$1", [campaign]);
  expect(rows.rows[0]).toMatchObject({ content_count: 3, ideate_on_plan: false });
  expect(rows.rows[0]?.built_at).toBeTruthy();
  await db.query("select save_campaign_plan_only($1,$2,$3,$4)", [campaign, client, job, plan]);
});

it("refuses an authenticated caller", async () => {
  await db.exec("select set_config('request.jwt.claim.role','authenticated',false);");
  await expect(db.query("select save_campaign_plan_only($1,$2,$3,$4)", [campaign, client, job, plan]))
    .rejects.toThrow(/agent runtime/);
  await db.exec("select set_config('request.jwt.claim.role','service_role',false);");
});
