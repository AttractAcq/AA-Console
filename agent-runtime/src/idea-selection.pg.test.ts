import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 152 against a real Postgres.
 *
 * Two things are being proved. That the selector is deterministic and says
 * why it chose what it chose, and -- the one that matters more -- that a
 * policy approval approves an idea and nothing else. A chain the engine has
 * approved end to end still cannot be published until a person signs the
 * asset off, and that is asserted directly rather than inferred from the
 * absence of code that would break it.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PILLAR = "33333333-3333-4333-8333-333333333333";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}
async function all<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}

/** The engine runs as service_role. Everything policy does requires it. */
async function asEngine<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  // service_role and no user. pg_cron runs with no jwt at all, so an engine
  // that still carried a subject would record its decisions against whoever
  // happened to be signed in. Leaving the admin's id set here made the test
  // of "attributed to the engine, not a person" pass for the wrong reason.
  await db.exec(
    `select set_config('request.jwt.claim.role', 'service_role', false);` +
      `select set_config('request.jwt.claim.sub', '', false);`,
  );
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(
      `select set_config('request.jwt.claim.role', 'authenticated', false);` +
        `select set_config('request.jwt.claim.sub', '${ADMIN}', false);`,
    );
  }
}

async function newSlot(client = CLIENT, at = "2026-11-02 09:00+00"): Promise<string> {
  const { id } = await one<{ id: string }>(
    `select id from create_content_slot('${client}', 'instagram', timestamptz '${at}', '${PILLAR}')`,
  );
  await db.exec(`select advance_slot('${id}', 'ideating'::slot_stage, 'engine')`);
  return id;
}

async function addIdea(
  slot: string,
  title: string,
  opts: { question?: string; reason?: string; client?: string; status?: string } = {},
): Promise<string> {
  const { id } = await one<{ id: string }>(`
    insert into client_ideas (client_id, slot_id, title, body, source_question, strategic_reason,
                              media_type, content_format, source, status)
    values ('${opts.client ?? CLIENT}', '${slot}', '${title}', 'A thing worth saying.',
            ${opts.question === undefined ? `'Why does content not compound at all?'` : `'${opts.question}'`},
            ${opts.reason === undefined ? `'It answers the question people actually ask.'` : `'${opts.reason}'`},
            'image', 'single', 'pillar', '${opts.status ?? "draft"}')
    returning id`);
  return id;
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
    create function cron.schedule(a text, b text, c text) returns bigint language sql as
      $$ insert into cron.job (jobname, schedule, command) values (a, b, c) returning jobid $$;
    create function cron.unschedule(a text) returns boolean language sql as
      $$ delete from cron.job where jobname = a returning true $$;

    create type post_platform as enum ('facebook','instagram','tiktok','linkedin','youtube');
    create type content_format as enum ('single','carousel','story','reel');
    create type media_type as enum ('image','text','video');
    create type idea_status as enum ('draft','approved','rejected','briefed');
    create type idea_source as enum ('manual','auto','proof','pillar');

    create table clients (id uuid primary key, name text not null, timezone text not null default 'Europe/London');
    create table profiles (id uuid primary key, role text);
    create table client_members (client_id uuid, user_id uuid);
    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role='admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable security definer as
      $$ select is_admin() or exists (select 1 from client_members m
            where m.client_id = p and m.user_id = auth.uid()) $$;
    create function client_timezone(p uuid) returns text language sql stable security definer as
      $$ select coalesce((select timezone from clients where id = p), 'Europe/London') $$;

    create table client_content_pillars (
      id uuid primary key default gen_random_uuid(),
      client_id uuid references clients(id) on delete cascade,
      name text not null, target_share integer not null default 100, active boolean not null default true);
    create table client_engine_budgets (
      client_id uuid references clients(id) on delete cascade, month date, cap_usd numeric,
      primary key (client_id, month));
    create table client_proof_assets (
      id uuid primary key default gen_random_uuid(), client_id uuid references clients(id) on delete cascade);
    create table client_briefs (id uuid primary key default gen_random_uuid());

    create table client_ideas (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients(id) on delete cascade,
      title text not null, body text,
      source_question text, strategic_reason text, content_territory text,
      media_type media_type not null, content_format content_format not null,
      source idea_source not null, status idea_status not null default 'draft',
      pillar_id uuid, job_id uuid, archived_at timestamptz,
      created_at timestamptz not null default clock_timestamp());

    -- The one human gate, as it exists in the real schema.
    create table client_media_assets (
      id uuid primary key default gen_random_uuid(),
      client_id uuid references clients(id) on delete cascade,
      title text, human_approved_at timestamptz);
    create table scheduled_posts (
      id uuid primary key default gen_random_uuid(),
      client_id uuid, platform post_platform, scheduled_at timestamptz);

    create function schedule_asset(p_asset_id uuid) returns uuid
      language plpgsql security definer set search_path to 'public' as $$
      declare v_human timestamptz;
      begin
        select human_approved_at into v_human from client_media_assets where id = p_asset_id;
        if v_human is null then
          raise exception 'That asset has not been approved by a person yet.';
        end if;
        return gen_random_uuid();
      end; $$;

    create view content_archive as
      select a.client_id, a.title, a.title as idea_title from client_media_assets a where false;

    create table agents (agent_key text primary key, name text, initials text, domain text,
      description text, requires_upstream text[], requires_input boolean default false,
      paused boolean not null default false, archived_at timestamptz, config jsonb default '{}'::jsonb);
    insert into agents (agent_key, name) values ('ideation','I'), ('brief','B'),
      ('creative_build','C'), ('video_build','V');
    create table agent_jobs (
      id uuid primary key default gen_random_uuid(), agent_key text references agents(agent_key),
      client_id uuid, input_table text, input_id uuid, created_by uuid,
      params jsonb not null default '{}'::jsonb, status text not null default 'queued',
      cost_usd numeric default 0, created_at timestamptz not null default clock_timestamp());
    create table agent_job_events (id uuid primary key default gen_random_uuid(),
      job_id uuid, description text, payload jsonb);
    create function can_run_agent(a text, c uuid) returns boolean language sql stable as $$ select true $$;
    create function enqueue_agent_job_internal(
      p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
      p_actor uuid, p_params jsonb default '{}'::jsonb, p_description text default 'Queued')
      returns uuid language plpgsql security definer set search_path to 'public' as $$
      declare v_job uuid;
      begin
        insert into agent_jobs (agent_key, client_id, input_table, input_id, created_by, params)
        values (p_agent_key, p_client_id, p_input_table, p_input_id, p_actor, p_params) returning id into v_job;
        return v_job;
      end; $$;
    create function agent_spend_for_client(c uuid, m date) returns numeric language sql stable as
      $$ select coalesce(sum(cost_usd), 0) from agent_jobs where client_id = c $$;

    insert into auth.users (id) values ('${ADMIN}');
    insert into profiles (id, role) values ('${ADMIN}', 'admin');
    insert into clients (id, name) values ('${CLIENT}', 'Harbour'), ('${OTHER}', 'Southern');
    insert into client_content_pillars (id, client_id, name) values ('${PILLAR}', '${CLIENT}', 'Proof');
  `);

  for (const file of [
    "20261005210000_146_engine_settings.sql",
    "20261005230000_147_content_slots.sql",
    "20261006020000_149_plan_slots.sql",
    "20261006040000_150_engine_tick.sql",
    "20261006060000_151_ideas_know_their_slot.sql",
    "20261006080000_152_idea_selection_and_policy.sql",
  ]) {
    await db.exec(await migration(file));
  }
  await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);
                 select set_config('request.jwt.claim.role', 'authenticated', false);`);
});

beforeEach(async () => {
  await db.exec(`reset role;`);
  await db.exec(`delete from engine_decisions; delete from client_ideas; delete from content_slots;
                 delete from client_proof_assets; delete from client_engine_settings;
                 delete from client_media_assets;`);
  await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);
                 select set_config('request.jwt.claim.role', 'authenticated', false);`);
  // Policy approval of ideas switched on for the client under test.
  await db.exec(`select set_engine_settings('${CLIENT}', 14, true)`);
});

describe("title_overlap", () => {
  it("is one for the same words and zero for none in common", async () => {
    const r = await one<{ same: string; none: string }>(`
      select title_overlap('Content compounds', 'compounds content') as same,
             title_overlap('Content compounds', 'Entirely different subject') as none`);
    expect(Number(r.same)).toBe(1);
    expect(Number(r.none)).toBe(0);
  });

  it("ignores short words, so stop words do not make everything look alike", async () => {
    const { v } = await one<{ v: string }>(
      `select title_overlap('the one and the other', 'and the and the') as v`,
    );
    // "one", "and", "the" are all too short to count; "other" is the only
    // significant word and it is not in the second title.
    expect(Number(v)).toBe(0);
  });

  it("handles an empty title without dividing by zero", async () => {
    const { v } = await one<{ v: string }>(`select title_overlap('', 'anything at all') as v`);
    expect(Number(v)).toBe(0);
  });
});

describe("scoring the candidates", () => {
  it("scores every undecided candidate, best first", async () => {
    const slot = await newSlot();
    await addIdea(slot, "Complete idea");
    await addIdea(slot, "Bare title", { question: "", reason: "" });
    const rows = await all<{ title: string; score: string; reasons: string[] }>(
      `select title, score, reasons from score_slot_ideas('${slot}')`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.title).toBe("Complete idea");
    expect(Number(rows[0]!.score)).toBeGreaterThan(Number(rows[1]!.score));
  });

  it("says why, in words, for every candidate", async () => {
    const slot = await newSlot();
    await addIdea(slot, "Complete idea");
    const { reasons } = await one<{ reasons: string[] }>(
      `select reasons from score_slot_ideas('${slot}')`,
    );
    expect(reasons).toHaveLength(3);
    expect(reasons.join(" ")).toMatch(/archive/);
    expect(reasons.join(" ")).toMatch(/proof/i);
    expect(reasons.join(" ")).toMatch(/question/);
  });

  it("rewards proof on file", async () => {
    const slot = await newSlot();
    await addIdea(slot, "An idea");
    const before = Number((await one<{ proof: string }>(`select proof from score_slot_ideas('${slot}')`)).proof);
    await db.exec(`insert into client_proof_assets (client_id) values ('${CLIENT}')`);
    const after = Number((await one<{ proof: string }>(`select proof from score_slot_ideas('${slot}')`)).proof);
    expect(before).toBe(10);
    expect(after).toBe(30);
  });

  it("gives full novelty when the client has published nothing", async () => {
    const slot = await newSlot();
    await addIdea(slot, "An idea");
    const { novelty } = await one<{ novelty: string }>(`select novelty from score_slot_ideas('${slot}')`);
    expect(Number(novelty)).toBe(50);
  });

  it("leaves out ideas already decided, and other slots' ideas", async () => {
    const slot = await newSlot();
    const other = await newSlot(CLIENT, "2026-11-04 09:00+00");
    await addIdea(slot, "Mine");
    await addIdea(slot, "Already approved", { status: "approved" });
    await addIdea(other, "Belongs to another slot");
    const rows = await all<{ title: string }>(`select title from score_slot_ideas('${slot}')`);
    expect(rows.map((r) => r.title)).toEqual(["Mine"]);
  });

  it("gives the same answer twice, including the tie-break", async () => {
    const slot = await newSlot();
    for (const t of ["Beta idea here", "Alpha idea here", "Gamma idea here"]) await addIdea(slot, t);
    const first = await all<{ title: string }>(`select title from score_slot_ideas('${slot}')`);
    const second = await all<{ title: string }>(`select title from score_slot_ideas('${slot}')`);
    expect(second).toEqual(first);
    // All three score identically, so the tie-break decides, alphabetically.
    expect(first.map((r) => r.title)).toEqual(["Alpha idea here", "Beta idea here", "Gamma idea here"]);
  });
});

describe("approving by policy", () => {
  it("is refused to a signed-in person", async () => {
    const slot = await newSlot();
    const idea = await addIdea(slot, "An idea");
    await expect(
      db.exec(`select approve_idea_by_policy('${idea}', '${slot}')`),
    ).rejects.toThrow(/Policy approvals are the engine/);
  });

  it("is refused for a client that has not switched it on", async () => {
    // auto_approve_ideas off means a person wanted to choose.
    await db.exec(`select set_engine_settings('${CLIENT}', 14, false)`);
    const slot = await newSlot();
    const idea = await addIdea(slot, "An idea");
    await expect(asEngine(`select approve_idea_by_policy('${idea}', '${slot}')`)).rejects.toThrow(
      /has not switched on policy approval/,
    );
  });

  it("refuses an idea generated for another slot", async () => {
    const slot = await newSlot();
    const other = await newSlot(CLIENT, "2026-11-04 09:00+00");
    const idea = await addIdea(other, "Idea for a different slot");
    await expect(asEngine(`select approve_idea_by_policy('${idea}', '${slot}')`)).rejects.toThrow(
      /not generated for this slot/,
    );
  });

  it("approves the idea and moves the slot, carrying the idea with it", async () => {
    const slot = await newSlot();
    const idea = await addIdea(slot, "The chosen one");
    await asEngine(`select approve_idea_by_policy('${idea}', '${slot}', 88, '["because"]'::jsonb)`);

    expect((await one<{ status: string }>(`select status from client_ideas where id = '${idea}'`)).status)
      .toBe("approved");
    const s = await one<{ stage: string; idea_id: string }>(
      `select stage, idea_id from content_slots where id = '${slot}'`,
    );
    expect(s).toMatchObject({ stage: "idea_selected", idea_id: idea });
  });

  it("records the move as policy, not as a person", async () => {
    const slot = await newSlot();
    const idea = await addIdea(slot, "The chosen one");
    await asEngine(`select approve_idea_by_policy('${idea}', '${slot}', 88)`);
    const e = await one<{ actor: string; actor_id: string | null }>(
      `select actor, actor_id from slot_events where to_stage = 'idea_selected'`,
    );
    expect(e.actor).toBe("policy");
    expect(e.actor_id).toBeNull();
  });

  it("leaves the idea at approved, not briefed, because no brief exists yet", async () => {
    const slot = await newSlot();
    const idea = await addIdea(slot, "The chosen one");
    await asEngine(`select approve_idea_by_policy('${idea}', '${slot}')`);
    expect((await one<{ status: string }>(`select status from client_ideas where id = '${idea}'`)).status)
      .toBe("approved");
  });

  it("queues nothing: the tick is the only way into the job queue", async () => {
    const slot = await newSlot();
    const idea = await addIdea(slot, "The chosen one");
    await asEngine(`select approve_idea_by_policy('${idea}', '${slot}')`);
    expect((await one<{ n: number }>(`select count(*)::int as n from agent_jobs`)).n).toBe(0);
  });
});

describe("the human gate", () => {
  it("still refuses to schedule an asset the engine approved but no person did", async () => {
    // M3.7's acceptance, stated directly. Every gate up to the asset has
    // been passed by policy; the asset itself has not been signed off, and
    // that is the one that decides whether anything goes out.
    const slot = await newSlot();
    const idea = await addIdea(slot, "The chosen one");
    await asEngine(`select approve_idea_by_policy('${idea}', '${slot}')`);

    const { id: asset } = await one<{ id: string }>(`
      insert into client_media_assets (client_id, title) values ('${CLIENT}', 'Built by the engine')
      returning id`);

    await expect(db.exec(`select schedule_asset('${asset}')`)).rejects.toThrow(
      /not been approved by a person/,
    );
  });

  it("touches human_approved_at nowhere in the policy path", async () => {
    const slot = await newSlot();
    const idea = await addIdea(slot, "The chosen one");
    const { id: asset } = await one<{ id: string }>(`
      insert into client_media_assets (client_id, title) values ('${CLIENT}', 'Asset') returning id`);
    await asEngine(`select approve_idea_by_policy('${idea}', '${slot}')`);
    const { human_approved_at } = await one<{ human_approved_at: string | null }>(
      `select human_approved_at from client_media_assets where id = '${asset}'`,
    );
    expect(human_approved_at).toBeNull();
  });

  it("does not mention human_approved_at in its source at all", async () => {
    // The strongest form of the claim: there is no path from the policy
    // functions to the human gate, not merely one that is not taken.
    const { def } = await one<{ def: string }>(`
      select string_agg(pg_get_functiondef(p.oid), ' ') as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('approve_idea_by_policy', 'select_idea_for_slot', 'score_slot_ideas')`);
    expect(def).not.toMatch(/human_approved_at/);
  });
});

describe("select_idea_for_slot", () => {
  it("picks the best and records what it passed over", async () => {
    const slot = await newSlot();
    await addIdea(slot, "Complete and whole");
    await addIdea(slot, "Bare title", { question: "", reason: "" });
    const d = await asEngine<{ score: string; considered: Array<{ title: string }>; idea_id: string }>(
      `select score, considered, idea_id from select_idea_for_slot('${slot}')`,
    );
    expect(Number(d[0]!.score)).toBeGreaterThan(0);
    expect(d[0]!.considered).toHaveLength(1);
    expect(d[0]!.considered[0]!.title).toBe("Bare title");
  });

  it("leaves the ones it passed over in the bank as drafts", async () => {
    const slot = await newSlot();
    await addIdea(slot, "Complete and whole");
    await addIdea(slot, "Bare title", { question: "", reason: "" });
    await asEngine(`select select_idea_for_slot('${slot}')`);
    const rows = await all<{ title: string; status: string }>(
      `select title, status from client_ideas order by title`,
    );
    expect(rows).toEqual([
      { title: "Bare title", status: "draft" },
      { title: "Complete and whole", status: "approved" },
    ]);
  });

  it("says so rather than choosing nothing when there are no candidates", async () => {
    const slot = await newSlot();
    await expect(asEngine(`select select_idea_for_slot('${slot}')`)).rejects.toThrow(/no undecided ideas/);
  });

  it("shows the decision on the slot, with what it passed over", async () => {
    const slot = await newSlot();
    await addIdea(slot, "Complete and whole");
    await addIdea(slot, "Bare title", { question: "", reason: "" });
    await asEngine(`select select_idea_for_slot('${slot}')`);
    const row = await one<{ chosen_title: string; passed_over: number; kind: string }>(
      `select chosen_title, passed_over, kind from slot_decisions where slot_id = '${slot}'`,
    );
    expect(row).toMatchObject({ chosen_title: "Complete and whole", passed_over: 1, kind: "idea_selected" });
  });
});

describe("the tick knows about the selector", () => {
  it("registers idea_select for a slot that is ideating", async () => {
    const row = await one<{ agent_key: string; enter_stage: string | null }>(
      `select agent_key, enter_stage from slot_pipeline where stage = 'ideating'`,
    );
    expect(row).toMatchObject({ agent_key: "idea_select", enter_stage: null });
  });
});
