import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const client = "11111111-1111-4111-8111-111111111111";
const campaign = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    create type media_type as enum ('image', 'text', 'video');
    create type content_format as enum ('single', 'carousel', 'story', 'reel');
    create type post_platform as enum ('facebook', 'instagram', 'tiktok', 'linkedin', 'youtube');
    create table client_campaigns (
      id uuid primary key, client_id uuid, name text, brief text,
      built_at timestamptz, content_ideas_generated_at timestamptz,
      objective text, audience text, offer_summary text, core_message text,
      channels text[], budget numeric, starts_on date, ends_on date,
      kpi_metric text, kpi_target numeric, content_count integer,
      needs_landing_page boolean, needs_sales_agent boolean,
      job_id uuid, updated_at timestamptz
    );
    create table agent_jobs (id uuid, client_id uuid, input_table text, input_id uuid, agent_key text);
    create table campaign_content_pillars (campaign_id uuid, pillar_id uuid);
    create table client_content_pillars (id uuid, name text);
    create table client_ideas (
      client_id uuid, title text, body text, media_type media_type, source text,
      status text, job_id uuid, campaign_id uuid, campaign_position integer,
      content_territory text, source_question text, strategic_reason text,
      pillar_id uuid, content_format content_format, target_platform post_platform
    );
    insert into client_campaigns (id, client_id, name, brief, built_at, content_count, channels)
      values ('${campaign}', '${client}', 'Launch', 'Show the offer', now(), 1, array['instagram']);
    insert into agent_jobs values ('${job}', '${client}', 'client_campaigns', '${campaign}', 'campaign_plan');
    select set_config('request.jwt.claim.role', 'service_role', false);
  `);
  const sql = await readFile(new URL("../../../../supabase/migrations/20261010110000_173_campaign_idea_destinations.sql", import.meta.url), "utf8");
  await db.exec(sql);
});

afterAll(async () => { await db?.close(); });

const reel = (channel: string) => [{
  title: "Three shots", body: "A clear offer demonstration", media_type: "video",
  channel, strategic_reason: "Show the product", content_format: "reel",
}];

it("rejects an unsupported social format before writing campaign ideas", async () => {
  await expect(db.query("select save_campaign_plan_with_ideas($1,$2,$3,$4,$5)",
    [campaign, client, job, {}, reel("linkedin")])).rejects.toThrow(/unsupported destination and format pair/);
  const result = await db.query("select count(*)::integer as count from client_ideas");
  expect(result.rows[0]).toMatchObject({ count: 0 });
});

it("saves a reel and its exact destination", async () => {
  await db.query("select save_campaign_plan_with_ideas($1,$2,$3,$4,$5)",
    [campaign, client, job, {}, reel("instagram")]);
  const result = await db.query("select content_format, target_platform from client_ideas");
  expect(result.rows[0]).toMatchObject({ content_format: "reel", target_platform: "instagram" });
});
