import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const PILLAR = "33333333-3333-4333-8333-333333333333";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create type post_platform as enum ('facebook','instagram','tiktok','linkedin','youtube');
    create type media_type as enum ('image','text','video');
    create type content_format as enum ('single','carousel','story','reel');
    create table client_campaigns (
      id uuid primary key, client_id uuid, built_at timestamptz, archived_at timestamptz,
      content_count integer, content_ideas_generated_at timestamptz
    );
    create table client_content_pillars (id uuid primary key, client_id uuid);
    create table client_proof_assets (id uuid primary key, client_id uuid);
    create table agent_jobs (
      id uuid primary key default gen_random_uuid(), agent_key text, client_id uuid,
      input_table text, input_id uuid, params jsonb
    );
    create table client_ideas (
      id uuid primary key default gen_random_uuid(), client_id uuid, job_id uuid,
      campaign_id uuid, campaign_position integer,
      constraint campaign_pair check ((campaign_id is null and campaign_position is null)
        or (campaign_id is not null and campaign_position > 0))
    );
    create unique index campaign_position_unique on client_ideas(campaign_id, campaign_position);
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
      insert into agent_jobs(agent_key, client_id, input_table, input_id, params)
      values (p_agent_key, p_client_id, p_input_table, p_input_id, p_params)
      returning id into v_id;
      return v_id;
    end $$;
    insert into client_campaigns values ('${CAMPAIGN}', '${CLIENT}', now(), null, 3, null);
    insert into client_content_pillars values ('${PILLAR}', '${CLIENT}');
    select set_config('request.jwt.claim.sub','${ADMIN}',false);
  `);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011010000_187_scoped_ideation.sql", import.meta.url), "utf8"));
});

afterAll(async () => { await db?.close(); });

describe("scoped ideation", () => {
  it("queues requested destination, shape, quantity, campaign and pillar", async () => {
    const result = await db.query<{ id: string }>(`
      select enqueue_scoped_ideation('${CLIENT}', 'instagram', 'video', 'reel',
        '${CAMPAIGN}', 7, 'client_content_pillars', '${PILLAR}') as id`);
    const jobId = result.rows[0]!.id;
    const job = await db.query<{ params: Record<string, unknown> }>(`select params from agent_jobs where id = '${jobId}'`);
    expect(job.rows[0]?.params).toMatchObject({
      target_platform: "instagram", media_type: "video", content_format: "reel",
      campaign_id: CAMPAIGN, idea_count: 7,
    });
    await db.exec(`insert into client_ideas(client_id, job_id) values ('${CLIENT}', '${jobId}'), ('${CLIENT}', '${jobId}')`);
    const ideas = await db.query<{ campaign_id: string; campaign_position: number }>(`
      select campaign_id, campaign_position from client_ideas order by campaign_position`);
    expect(ideas.rows).toEqual([
      { campaign_id: CAMPAIGN, campaign_position: 4 },
      { campaign_id: CAMPAIGN, campaign_position: 5 },
    ]);
  });

  it("rejects invalid count and format before queueing", async () => {
    await expect(db.query(`select enqueue_scoped_ideation('${CLIENT}', 'instagram', 'video', 'reel', null, 61, null, null)`))
      .rejects.toThrow(/between 1 and 60/);
    await expect(db.query(`select enqueue_scoped_ideation('${CLIENT}', 'linkedin', 'video', 'reel', null, 5, null, null)`))
      .rejects.toThrow(/not supported/);
  });
});
