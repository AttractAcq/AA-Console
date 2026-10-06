import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 158 and 159 against a real Postgres.
 *
 * The one human commit. Everything before it can happen without a person;
 * this is where that stops, so the tests are mostly about what cannot
 * happen: a slot reaching a person below the client's QA threshold, an
 * engine-approved chain scheduling itself, and a rejection with no reason.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const PILLAR = "33333333-3333-4333-8333-333333333333";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}

async function asEngine<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false);
                 select set_config('request.jwt.claim.sub','',false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                   select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
  }
}

/** A slot walked to awaiting_approval with an asset and copy, as the engine leaves it. */
async function slotAwaitingApproval(opts: { score?: number } = {}): Promise<{ slot: string; asset: string }> {
  const { id: asset } = await one<{ id: string }>(
    `insert into client_media_assets (client_id, title) values ('${CLIENT}','Built') returning id`,
  );
  const { id: idea } = await one<{ id: string }>(
    `insert into client_ideas (client_id) values ('${CLIENT}') returning id`,
  );
  const { id: slot } = await one<{ id: string }>(
    `select id from create_content_slot('${CLIENT}','instagram', now() + interval '2 days','${PILLAR}')`,
  );
  await db.exec(`
    select advance_slot('${slot}','ideating'::slot_stage,'engine');
    select advance_slot('${slot}','idea_selected'::slot_stage,'policy',null,null,null,null,'${idea}');
    select advance_slot('${slot}','briefing'::slot_stage,'engine');
    select advance_slot('${slot}','building'::slot_stage,'agent');
    select advance_slot('${slot}','copywriting'::slot_stage,'agent',null,null,null,null,null,null,'${asset}');
    select advance_slot('${slot}','qa'::slot_stage,'agent');
  `);
  await db.exec(`insert into post_copy (asset_id, platform, caption, source)
                 values ('${asset}','instagram','Five steps, one chain.','agent')`);
  await asEngine(
    `select record_qa_result('${slot}', ${opts.score ?? 100}, '[]'::jsonb, 'awaiting_approval'::slot_stage)`,
  );
  return { slot, asset };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema cron;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
    create function cron.schedule(a text,b text,c text) returns bigint language sql as
      $$ insert into cron.job (jobname,schedule,command) values (a,b,c) returning jobid $$;
    create function cron.unschedule(a text) returns boolean language sql as
      $$ delete from cron.job where jobname=a returning true $$;

    create type post_platform as enum ('facebook','instagram','tiktok','linkedin','youtube');
    create type post_channel as enum ('organic','paid');
    create type content_format as enum ('single','carousel','story','reel');
    create type media_type as enum ('image','text','video');
    create type review_status as enum ('pending','approved','rejected');

    create table clients (id uuid primary key, name text, timezone text not null default 'Europe/London');
    create table profiles (id uuid primary key, role text);
    create table client_members (client_id uuid, user_id uuid);
    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role='admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable security definer as
      $$ select is_admin() or exists (select 1 from client_members m
            where m.client_id=p and m.user_id=auth.uid()) $$;
    create function client_timezone(p uuid) returns text language sql stable security definer as
      $$ select coalesce((select timezone from clients where id=p),'Europe/London') $$;

    create table client_content_pillars (id uuid primary key default gen_random_uuid(),
      client_id uuid, name text, target_share int default 100, active boolean default true);
    create table client_engine_budgets (client_id uuid, month date, cap_usd numeric,
      primary key (client_id, month));
    create table client_proof_assets (id uuid primary key default gen_random_uuid(), client_id uuid);
    create table client_ideas (id uuid primary key default gen_random_uuid(), client_id uuid, slot_id uuid,
      title text, body text, source_question text, strategic_reason text, content_territory text,
      status text default 'draft', archived_at timestamptz, created_at timestamptz default now());
    create table client_briefs (id uuid primary key default gen_random_uuid());
    create table client_media_assets (id uuid primary key default gen_random_uuid(),
      client_id uuid, title text, review_status review_status not null default 'pending',
      human_approved_at timestamptz);
    create table client_asset_reviews (id uuid primary key default gen_random_uuid(),
      asset_id uuid, decision review_status, reason text, reviewed_by uuid,
      created_at timestamptz default now());
    create table scheduled_posts (id uuid primary key default gen_random_uuid(),
      client_id uuid, asset_id uuid, scheduled_for date, scheduled_at timestamptz,
      channel post_channel default 'organic', platform post_platform, created_by uuid);

    -- The real one, shortened to what these tests touch.
    create function review_media_asset(p_asset_id uuid, p_decision review_status, p_reason text default null)
      returns void language plpgsql security definer set search_path to 'public' as $$
      begin
        update client_media_assets
           set review_status = p_decision,
               human_approved_at = case when p_decision='approved' then now() else null end
         where id = p_asset_id;
        insert into client_asset_reviews (asset_id, decision, reason, reviewed_by)
        values (p_asset_id, p_decision, p_reason, auth.uid());
      end; $$;

    create table agents (agent_key text primary key, name text, initials text, domain text,
      description text, requires_upstream text[], requires_input boolean default false,
      paused boolean not null default false, archived_at timestamptz);
    insert into agents (agent_key) values ('ideation'),('brief'),('creative_build'),('video_build');
    create table agent_jobs (id uuid primary key default gen_random_uuid(),
      agent_key text references agents(agent_key), client_id uuid, input_table text, input_id uuid,
      created_by uuid, params jsonb default '{}'::jsonb, status text default 'queued',
      cost_usd numeric default 0, created_at timestamptz default clock_timestamp());
    create table agent_job_events (id uuid primary key default gen_random_uuid(),
      job_id uuid, description text, payload jsonb);
    create function can_run_agent(a text,c uuid) returns boolean language sql stable as $$ select true $$;
    create function enqueue_agent_job_internal(p_agent_key text,p_client_id uuid,p_input_table text,
      p_input_id uuid,p_actor uuid,p_params jsonb default '{}'::jsonb,p_description text default 'q')
      returns uuid language plpgsql security definer set search_path to 'public' as $$
      declare v uuid; begin
        insert into agent_jobs (agent_key,client_id,input_table,input_id,created_by,params)
        values (p_agent_key,p_client_id,p_input_table,p_input_id,p_actor,p_params) returning id into v;
        return v; end; $$;
    create function agent_spend_for_client(c uuid,m date) returns numeric language sql stable as
      $$ select 0::numeric $$;
    create view content_archive as select client_id, title, title as idea_title
      from client_media_assets where false;

    insert into auth.users (id) values ('${ADMIN}'), ('${OUTSIDER}');
    insert into profiles (id, role) values ('${ADMIN}','admin'), ('${OUTSIDER}','staff');
    insert into clients (id, name) values ('${CLIENT}','Harbour');
    insert into client_content_pillars (id, client_id, name) values ('${PILLAR}','${CLIENT}','Proof');
  `);

  for (const f of [
    "20261005210000_146_engine_settings.sql",
    "20261005230000_147_content_slots.sql",
    "20261005190000_145_post_copy.sql",
    "20261006020000_149_plan_slots.sql",
    "20261006040000_150_engine_tick.sql",
    "20261006060000_151_ideas_know_their_slot.sql",
    "20261006080000_152_idea_selection_and_policy.sql",
    "20261006140000_155_tick_queues_the_right_input.sql",
    "20261006200000_158_qa.sql",
    "20261006220000_159_approval_inbox.sql",
  ]) {
    await db.exec(await migration(f));
  }
  await db.exec(`select set_config('request.jwt.claim.sub','${ADMIN}',false);
                 select set_config('request.jwt.claim.role','authenticated',false);`);
});

beforeEach(async () => {
  await db.exec(`reset role;`);
  await db.exec(`delete from post_copy; delete from scheduled_posts; delete from client_asset_reviews;
                 delete from content_slots; delete from client_media_assets; delete from client_ideas;
                 delete from client_engine_settings;`);
  await db.exec(`select set_config('request.jwt.claim.sub','${ADMIN}',false);
                 select set_config('request.jwt.claim.role','authenticated',false);`);
  await db.exec(`select set_engine_settings('${CLIENT}', 14, true)`);
});

describe("QA will not put something in front of a person below the threshold", () => {
  it("refuses the move, naming the client's number", async () => {
    // The promise of the QA stage, enforced where it cannot be routed around
    // rather than only in the agent that normally calls it.
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (client_id, title) values ('${CLIENT}','x') returning id`,
    );
    const { id: slot } = await one<{ id: string }>(
      `select id from create_content_slot('${CLIENT}','instagram', now() + interval '1 day')`,
    );
    await db.exec(`
      select advance_slot('${slot}','ideating'::slot_stage,'engine');
      select advance_slot('${slot}','idea_selected'::slot_stage,'policy');
      select advance_slot('${slot}','briefing'::slot_stage,'engine');
      select advance_slot('${slot}','building'::slot_stage,'agent');
      select advance_slot('${slot}','copywriting'::slot_stage,'agent',null,null,null,null,null,null,'${asset}');
      select advance_slot('${slot}','qa'::slot_stage,'agent');`);

    await expect(
      asEngine(`select record_qa_result('${slot}', 40, '[]'::jsonb, 'awaiting_approval'::slot_stage)`),
    ).rejects.toThrow(/cannot go for approval/);
  });

  it("is written by the engine, not by a person", async () => {
    const { slot } = await slotAwaitingApproval();
    await expect(
      db.exec(`select record_qa_result('${slot}', 90, '[]'::jsonb, 'scheduled'::slot_stage)`),
    ).rejects.toThrow(/written by the engine/);
  });
});

describe("approving", () => {
  it("signs the asset off as a person and puts it on the calendar", async () => {
    const { slot, asset } = await slotAwaitingApproval();
    await db.exec(`select approve_slot('${slot}', 'Looks right.')`);

    const a = await one<{ review_status: string; human_approved_at: string | null }>(
      `select review_status, human_approved_at from client_media_assets where id = '${asset}'`,
    );
    expect(a.review_status).toBe("approved");
    expect(a.human_approved_at).not.toBeNull();

    const s = await one<{ stage: string; scheduled_post_id: string | null }>(
      `select stage, scheduled_post_id from content_slots where id = '${slot}'`,
    );
    expect(s.stage).toBe("scheduled");
    expect(s.scheduled_post_id).not.toBeNull();
  });

  it("schedules it for when it was planned, not when it was approved", async () => {
    const { slot } = await slotAwaitingApproval();
    const before = await one<{ at: string }>(`select scheduled_at as at from content_slots where id='${slot}'`);
    await db.exec(`select approve_slot('${slot}')`);
    const post = await one<{ at: string }>(
      `select sp.scheduled_at as at from scheduled_posts sp
        join content_slots s on s.scheduled_post_id = sp.id where s.id = '${slot}'`,
    );
    expect(post.at).toEqual(before.at);
  });

  it("carries the copy onto the post, so the publisher reads one row", async () => {
    const { slot } = await slotAwaitingApproval();
    await db.exec(`select approve_slot('${slot}')`);
    const { caption } = await one<{ caption: string }>(
      `select pc.caption from post_copy pc
        join content_slots s on s.scheduled_post_id = pc.scheduled_post_id where s.id='${slot}'`,
    );
    expect(caption).toBe("Five steps, one chain.");
  });

  it("records the decision against the person who made it", async () => {
    const { slot, asset } = await slotAwaitingApproval();
    await db.exec(`select approve_slot('${slot}', 'Fine.')`);
    const r = await one<{ reviewed_by: string; decision: string }>(
      `select reviewed_by, decision from client_asset_reviews where asset_id='${asset}'`,
    );
    expect(r).toMatchObject({ reviewed_by: ADMIN, decision: "approved" });
  });

  it("refuses a slot that is not waiting for approval", async () => {
    const { slot } = await slotAwaitingApproval();
    await db.exec(`select approve_slot('${slot}')`);
    await expect(db.exec(`select approve_slot('${slot}')`)).rejects.toThrow(/not waiting for approval/);
  });

  it("refuses someone with no access to the client", async () => {
    const { slot } = await slotAwaitingApproval();
    await db.exec(`select set_config('request.jwt.claim.sub','${OUTSIDER}',false)`);
    await expect(db.exec(`select approve_slot('${slot}')`)).rejects.toThrow(/Not permitted/);
    await db.exec(`select set_config('request.jwt.claim.sub','${ADMIN}',false)`);
  });
});

describe("rejecting", () => {
  it("needs a reason, because the engine makes the next one from it", async () => {
    const { slot } = await slotAwaitingApproval();
    await expect(db.exec(`select reject_slot('${slot}', '  ')`)).rejects.toThrow(/Say why/);
    await expect(db.exec(`select reject_slot('${slot}', null)`)).rejects.toThrow(/Say why/);
  });

  it("clears the sign-off rather than leaving one it no longer has", async () => {
    const { slot, asset } = await slotAwaitingApproval();
    await db.exec(`select reject_slot('${slot}', 'Off brand.')`);
    const a = await one<{ review_status: string; human_approved_at: string | null }>(
      `select review_status, human_approved_at from client_media_assets where id='${asset}'`,
    );
    expect(a).toMatchObject({ review_status: "rejected", human_approved_at: null });
    expect((await one<{ stage: string }>(`select stage from content_slots where id='${slot}'`)).stage)
      .toBe("rejected");
  });

  it("schedules nothing", async () => {
    const { slot } = await slotAwaitingApproval();
    await db.exec(`select reject_slot('${slot}', 'No.')`);
    expect((await one<{ n: number }>(`select count(*)::int as n from scheduled_posts`)).n).toBe(0);
  });
});

describe("making it again", () => {
  it("sends a rejected slot back to be briefed, counting the attempt", async () => {
    const { slot } = await slotAwaitingApproval();
    await db.exec(`select reject_slot('${slot}', 'Wrong angle.')`);
    await db.exec(`select regenerate_slot('${slot}')`);
    const s = await one<{ stage: string; attempts: number }>(
      `select stage, attempts from content_slots where id='${slot}'`,
    );
    expect(s).toMatchObject({ stage: "briefing", attempts: 1 });
  });

  it("only makes a rejected one again", async () => {
    const { slot } = await slotAwaitingApproval();
    await expect(db.exec(`select regenerate_slot('${slot}')`)).rejects.toThrow(/Only a rejected slot/);
  });

  it("is a slot the tick will pick up, rather than one resting forever", async () => {
    // 'briefing' had no pipeline row until 159: the tick only ever passed
    // through it. A regenerated slot would have sat there untouched.
    const row = await one<{ agent_key: string; input_column: string }>(
      `select agent_key, input_column from slot_pipeline where stage = 'briefing'`,
    );
    expect(row).toMatchObject({ agent_key: "brief", input_column: "idea_id" });
  });
});

describe("the inbox", () => {
  it("shows what is waiting, with what QA found", async () => {
    const { slot } = await slotAwaitingApproval();
    await asEngine(`select record_qa_result('${slot}', 92,
      '[{"area":"claims","severity":"warning","detail":"No proof on file."}]'::jsonb,
      'awaiting_approval'::slot_stage)`).catch(() => undefined);
    const row = await one<{ qa_score: number; finding_count: number; warnings: number }>(
      `select qa_score, finding_count, warnings from approval_inbox where slot_id='${slot}'`,
    );
    expect(row.qa_score).toBe(100);
    expect(row.finding_count).toBe(0);
  });

  it("says how long it has been waiting and when it was meant to go out", async () => {
    const { slot } = await slotAwaitingApproval();
    const row = await one<{ waiting_for: unknown; goes_out_in: unknown; overdue: boolean }>(
      `select waiting_for, goes_out_in, overdue from approval_inbox where slot_id='${slot}'`,
    );
    expect(row.waiting_for).not.toBeNull();
    expect(row.overdue).toBe(false);
  });

  it("marks one whose moment has passed", async () => {
    const { slot } = await slotAwaitingApproval();
    await db.exec(`update content_slots set scheduled_at = now() - interval '1 hour' where id='${slot}'`);
    const { overdue } = await one<{ overdue: boolean }>(
      `select overdue from approval_inbox where slot_id='${slot}'`,
    );
    expect(overdue).toBe(true);
  });

  it("empties as things are decided", async () => {
    const { slot } = await slotAwaitingApproval();
    expect((await one<{ n: number }>(`select count(*)::int as n from approval_inbox`)).n).toBe(1);
    await db.exec(`select approve_slot('${slot}')`);
    expect((await one<{ n: number }>(`select count(*)::int as n from approval_inbox`)).n).toBe(0);
  });
});
