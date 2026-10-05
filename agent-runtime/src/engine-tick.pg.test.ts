import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 150 against a real Postgres.
 *
 * This is the first part of the engine that reaches the job queue, so the
 * tests that matter most are the ones about it not doing so: four independent
 * switches, each of which is on its own sufficient to stop everything. Each
 * is tested with the other three left in the permissive position, because a
 * switch that only works while another switch is also off is not a switch.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MONDAY = "2026-11-02 06:00+00";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}
async function all<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}

const tick = (now = MONDAY) =>
  one<{
    clients_considered: number;
    clients_skipped: number;
    slots_planned: number;
    jobs_queued: number;
    notes: Array<{ reason: string; client_id?: string }>;
  }>(`select * from engine_tick(timestamptz '${now}')`);

const jobs = () =>
  all<{ agent_key: string; slot_id: string; status: string }>(
    `select agent_key, params->>'slot_id' as slot_id, status::text as status from agent_jobs order by created_at`,
  );

/** Everything switched on and in order: the state every test starts from. */
async function readyClient(
  client = CLIENT,
  opts: { cap?: number; perWeek?: number; inFlight?: number; horizon?: number } = {},
) {
  await db.exec(`select set_engine_platform('${client}', 'instagram', ${opts.perWeek ?? 2})`);
  await db.exec(`select add_engine_window('${client}', 1::smallint, time '09:00', time '11:00')`);
  await db.exec(`select add_engine_window('${client}', 3::smallint, time '09:00', time '11:00')`);
  await db.exec(
    `insert into client_content_pillars (client_id, name, target_share, active) values ('${client}', 'Proof', 100, true)`,
  );
  await db.exec(
    // A one-week horizon by default, so perWeek is also the number of slots
    // and a test that says "the slot" has exactly one to mean.
    `select set_engine_settings('${client}', ${opts.horizon ?? 7}, null, null, null, null, null, ${opts.inFlight ?? 5})`,
  );
  await db.exec(`select set_engine_enabled('${client}', true)`);
  if (opts.cap !== undefined) {
    await db.exec(
      `insert into client_engine_budgets (client_id, month, cap_usd)
       values ('${client}', date_trunc('month', timestamptz '${MONDAY}')::date, ${opts.cap})`,
    );
  }
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

    -- pg_cron is not in PGlite. The schedule is one line of the migration and
    -- is verified on staging instead; stubbing it lets the rest apply here.
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
    create function cron.schedule(p_name text, p_schedule text, p_command text)
      returns bigint language sql as
      $$ insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
         returning jobid $$;
    create function cron.unschedule(p_name text) returns boolean language sql as
      $$ delete from cron.job where jobname = p_name returning true $$;

    create type post_platform as enum ('facebook','instagram','tiktok','linkedin','youtube');
    create type content_format as enum ('single','carousel','story','reel');

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
      name text not null, target_share integer not null default 25, active boolean not null default true);
    create table client_engine_budgets (
      client_id uuid references clients(id) on delete cascade, month date, cap_usd numeric,
      primary key (client_id, month));
    create table client_ideas (id uuid primary key default gen_random_uuid());
    create table client_briefs (id uuid primary key default gen_random_uuid());
    create table client_media_assets (id uuid primary key default gen_random_uuid(), title text);
    create table scheduled_posts (
      id uuid primary key default gen_random_uuid(),
      client_id uuid, platform post_platform, scheduled_at timestamptz);

    create table agents (agent_key text primary key, paused boolean not null default false,
                         archived_at timestamptz);
    insert into agents (agent_key) values ('ideation'), ('brief'), ('creative_build'), ('video_build');

    create table agent_jobs (
      id uuid primary key default gen_random_uuid(),
      agent_key text not null references agents(agent_key),
      client_id uuid, input_table text, input_id uuid, created_by uuid,
      params jsonb not null default '{}'::jsonb,
      status text not null default 'queued',
      cost_usd numeric default 0,
      created_at timestamptz not null default clock_timestamp());
    create table agent_job_events (
      id uuid primary key default gen_random_uuid(), job_id uuid, description text, payload jsonb);

    create function can_run_agent(p_agent text, p_client uuid) returns boolean
      language sql stable as $$ select true $$;

    create function enqueue_agent_job_internal(
      p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
      p_actor uuid, p_params jsonb default '{}'::jsonb, p_description text default 'Queued')
      returns uuid language plpgsql security definer set search_path to 'public' as $$
      declare v_agent agents; v_job uuid;
      begin
        select * into v_agent from agents where agent_key = p_agent_key for share;
        if not found then raise exception 'Unknown agent: %', p_agent_key; end if;
        if v_agent.paused then raise exception 'Agent % is paused', p_agent_key; end if;
        if not can_run_agent(p_agent_key, p_client_id) then
          raise exception 'Agent % is missing required upstream intelligence', p_agent_key;
        end if;
        insert into agent_jobs (agent_key, client_id, input_table, input_id, created_by, params)
        values (p_agent_key, p_client_id, p_input_table, p_input_id, p_actor, p_params)
        returning id into v_job;
        insert into agent_job_events (job_id, description, payload) values (v_job, p_description, p_params);
        return v_job;
      end; $$;

    create function agent_spend_for_client(p_client uuid, p_month date) returns numeric
      language sql stable as
      $$ select coalesce(sum(cost_usd), 0) from agent_jobs where client_id = p_client $$;

    insert into auth.users (id) values ('${ADMIN}');
    insert into profiles (id, role) values ('${ADMIN}', 'admin');
    insert into clients (id, name) values ('${CLIENT}', 'Harbour'), ('${OTHER}', 'Southern');
  `);

  for (const file of [
    "20261005210000_146_engine_settings.sql",
    "20261005230000_147_content_slots.sql",
    "20261006020000_149_plan_slots.sql",
    "20261006040000_150_engine_tick.sql",
  ]) {
    await db.exec(await migration(file));
  }
  await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
});

beforeEach(async () => {
  await db.exec(`reset role;`);
  await db.exec(`delete from agent_job_events; delete from agent_jobs;
                 delete from content_slots;
                 delete from client_engine_settings; delete from client_engine_platforms;
                 delete from client_engine_windows; delete from client_content_pillars;
                 delete from client_engine_budgets; delete from engine_tick_runs;`);
  await db.exec(`update engine_controls set enabled = false where id;`);
  await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
});

describe("the four ways to stop it", () => {
  it("does nothing at all while the global switch is off", async () => {
    // Everything else permissive: a client switched on, in budget, with room.
    await readyClient(CLIENT, { cap: 100 });
    const run = await tick();
    expect(run.jobs_queued).toBe(0);
    expect(run.slots_planned).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(run.notes[0]!.reason).toMatch(/switched off globally/);
  });

  it("does nothing for a client whose own switch is off", async () => {
    await db.exec(`select set_engine_running(true)`);
    await readyClient(CLIENT, { cap: 100 });
    await db.exec(`select set_engine_enabled('${CLIENT}', false)`);
    const run = await tick();
    expect(run.clients_considered).toBe(0);
    expect(await jobs()).toHaveLength(0);
  });

  it("skips a client with no spend cap, and says so", async () => {
    // No cap means not cleared to spend, not cleared to spend without limit.
    await db.exec(`select set_engine_running(true)`);
    await readyClient(CLIENT);
    const run = await tick();
    expect(run.clients_considered).toBe(1);
    expect(run.clients_skipped).toBe(1);
    expect(run.jobs_queued).toBe(0);
    expect(run.notes[0]!.reason).toMatch(/No spend cap/);
  });

  it("skips a client that has spent its cap, and says what it spent", async () => {
    await db.exec(`select set_engine_running(true)`);
    await readyClient(CLIENT, { cap: 10 });
    // Spend is summed from agent_jobs in the fixture, as it is in production.
    await db.exec(`insert into agent_jobs (agent_key, client_id, cost_usd, status)
                   values ('ideation', '${CLIENT}', 12, 'completed')`);
    const run = await tick();
    expect(run.clients_skipped).toBe(1);
    expect(run.jobs_queued).toBe(0);
    expect(run.notes[0]!.reason).toMatch(/Over the monthly cap/);
  });

  it("stops queueing at the in-flight cap, without failing", async () => {
    await db.exec(`select set_engine_running(true)`);
    await readyClient(CLIENT, { cap: 100, perWeek: 2, inFlight: 1 });
    const run = await tick();
    expect(run.jobs_queued).toBe(1);
    expect(await jobs()).toHaveLength(1);
  });

  it("counts only the engine's own jobs against the cap", async () => {
    // A job without a slot_id is somebody running an agent by hand. It is
    // not the engine's work and must not use up the engine's allowance.
    await db.exec(`select set_engine_running(true)`);
    await readyClient(CLIENT, { cap: 100, inFlight: 2 });
    await db.exec(`insert into agent_jobs (agent_key, client_id, status)
                   values ('ideation', '${CLIENT}', 'running')`);
    const run = await tick();
    expect(run.jobs_queued).toBe(2);
  });
});

describe("a normal tick", () => {
  beforeEach(async () => {
    await db.exec(`select set_engine_running(true)`);
  });

  it("plans the horizon and queues the first job for each slot", async () => {
    await readyClient(CLIENT, { cap: 100, perWeek: 2, horizon: 14 });
    const run = await tick();
    expect(run.slots_planned).toBe(4);
    expect(run.jobs_queued).toBe(4);
    expect((await jobs()).every((j) => j.agent_key === "ideation")).toBe(true);
  });

  it("moves the slot into the stage the work belongs to", async () => {
    await readyClient(CLIENT, { cap: 100, perWeek: 1 });
    await tick();
    const { stage } = await one<{ stage: string }>(`select stage from content_slots limit 1`);
    expect(stage).toBe("ideating");
  });

  it("records the move as an engine event, not an anonymous one", async () => {
    await readyClient(CLIENT, { cap: 100, perWeek: 1 });
    await tick();
    const row = await one<{ actor: string; agent_key: string; to_stage: string }>(
      `select actor, agent_key, to_stage from slot_events where to_stage = 'ideating'`,
    );
    expect(row).toMatchObject({ actor: "engine", agent_key: "ideation", to_stage: "ideating" });
  });

  it("puts the slot in the job so the agent knows what it is working on", async () => {
    await readyClient(CLIENT, { cap: 100, perWeek: 1 });
    await tick();
    const { slot_id } = (await jobs())[0]!;
    const { id } = await one<{ id: string }>(`select id from content_slots limit 1`);
    expect(slot_id).toBe(id);
  });

  it("does the soonest slots first", async () => {
    await readyClient(CLIENT, { cap: 100, perWeek: 2, inFlight: 1 });
    await tick();
    const { slot_id } = (await jobs())[0]!;
    const { id } = await one<{ id: string }>(`select id from content_slots order by scheduled_at limit 1`);
    expect(slot_id).toBe(id);
  });
});

describe("running again", () => {
  beforeEach(async () => {
    await db.exec(`select set_engine_running(true)`);
  });

  it("does not queue a second job for a slot that already has one", async () => {
    await readyClient(CLIENT, { cap: 100, perWeek: 2, horizon: 14 });
    expect((await tick()).jobs_queued).toBe(4);
    const second = await tick();
    expect(second.jobs_queued).toBe(0);
    expect(second.slots_planned).toBe(0);
    expect(await jobs()).toHaveLength(4);
  });

  it("does not queue a second job while the first is still running", async () => {
    // The case the stage-has-no-agent skip hides: a slot sitting in a stage
    // that *does* have an agent, with that agent still working. Without the
    // in-flight check the next tick queues the same build again, and the
    // client pays twice for one asset.
    await readyClient(CLIENT, { cap: 100, perWeek: 1 });
    await tick();
    const { id } = await one<{ id: string }>(`select id from content_slots limit 1`);
    await db.exec(`update agent_jobs set status = 'completed'`);
    await db.exec(`select advance_slot('${id}', 'idea_selected'::slot_stage, 'agent')`);
    await db.exec(`select advance_slot('${id}', 'briefing'::slot_stage, 'engine')`);
    await db.exec(`select advance_slot('${id}', 'building'::slot_stage, 'agent')`);

    // First tick queues the build.
    expect((await tick()).jobs_queued).toBe(1);
    const after = (await jobs()).filter((j) => j.agent_key === "creative_build");
    expect(after).toHaveLength(1);

    // The build is still running. The next tick must leave it alone.
    expect((await tick()).jobs_queued).toBe(0);
    expect((await jobs()).filter((j) => j.agent_key === "creative_build")).toHaveLength(1);
  });

  it("queues again once the earlier job has finished and the slot moved on", async () => {
    await readyClient(CLIENT, { cap: 100, perWeek: 1 });
    await tick();
    const { id } = await one<{ id: string }>(`select id from content_slots limit 1`);
    // The ideation job finishes and selection picks an idea.
    await db.exec(`update agent_jobs set status = 'completed'`);
    await db.exec(`select advance_slot('${id}', 'idea_selected'::slot_stage, 'agent')`);

    expect((await tick()).jobs_queued).toBe(1);
    const latest = (await jobs()).at(-1)!;
    expect(latest.agent_key).toBe("brief");
    expect(latest.slot_id).toBe(id);
    expect(
      (await one<{ stage: string }>(`select stage from content_slots where id = '${id}'`)).stage,
    ).toBe("briefing");
  });
});

describe("the pipeline table", () => {
  beforeEach(async () => {
    await db.exec(`select set_engine_running(true)`);
  });

  it("sends a reel to the reel builder and everything else to the still builder", async () => {
    await readyClient(CLIENT, { cap: 100, perWeek: 1 });
    // The first tick is what creates the slot, so it has to come first.
    await tick();
    await db.exec(`update agent_jobs set status = 'completed'`);
    const slot = await one<{ id: string }>(`select id from content_slots limit 1`);
    await db.exec(`select advance_slot('${slot.id}', 'idea_selected'::slot_stage, 'agent')`);
    await db.exec(`select advance_slot('${slot.id}', 'briefing'::slot_stage, 'engine')`);
    await db.exec(`select advance_slot('${slot.id}', 'building'::slot_stage, 'agent')`);

    await db.exec(`update agent_jobs set status = 'completed'`);
    await db.exec(`update content_slots set format = 'single' where id = '${slot.id}'`);
    await tick();
    expect((await jobs()).at(-1)!.agent_key).toBe("creative_build");

    await db.exec(`update agent_jobs set status = 'completed'`);
    await db.exec(`update content_slots set format = 'reel' where id = '${slot.id}'`);
    await tick();
    expect((await jobs()).at(-1)!.agent_key).toBe("video_build");
  });

  it("leaves a slot alone at a stage no agent has claimed yet", async () => {
    // copywriting and qa have no row until M3.8 and M3.9. A slot resting
    // there must stay visible rather than being dropped or retried forever.
    await readyClient(CLIENT, { cap: 100, perWeek: 1 });
    await tick();
    const { id } = await one<{ id: string }>(`select id from content_slots limit 1`);
    await db.exec(`update agent_jobs set status = 'completed'`);
    for (const stage of ["idea_selected", "briefing", "building", "copywriting"]) {
      await db.exec(`select advance_slot('${id}', '${stage}'::slot_stage, 'agent')`);
    }
    const run = await tick();
    expect(run.jobs_queued).toBe(0);
    expect(
      (await one<{ stage: string }>(`select stage from content_slots where id = '${id}'`)).stage,
    ).toBe("copywriting");
  });
});

describe("one client's trouble", () => {
  it("does not stop the others", async () => {
    await db.exec(`select set_engine_running(true)`);
    await readyClient(CLIENT, { cap: 100, perWeek: 1 });
    // A client switched on with no pillars: plan_slots refuses it.
    await db.exec(`select set_engine_platform('${OTHER}', 'instagram', 1)`);
    await db.exec(`select add_engine_window('${OTHER}', 1::smallint, time '09:00', time '11:00')`);
    await db.exec(
      `insert into client_content_pillars (client_id, name, target_share, active) values ('${OTHER}', 'P', 100, true)`,
    );
    await db.exec(`select set_engine_settings('${OTHER}')`);
    await db.exec(`select set_engine_enabled('${OTHER}', true)`);
    await db.exec(
      `insert into client_engine_budgets (client_id, month, cap_usd)
       values ('${OTHER}', date_trunc('month', timestamptz '${MONDAY}')::date, 100)`,
    );
    await db.exec(`update client_content_pillars set active = false where client_id = '${OTHER}'`);

    const run = await tick();
    expect(run.clients_considered).toBe(2);
    expect(run.clients_skipped).toBe(1);
    // The healthy client still got its work.
    expect(run.jobs_queued).toBe(1);
    expect(run.notes.some((n) => n.client_id === OTHER)).toBe(true);
  });
});

describe("the record it leaves", () => {
  it("writes a row for every tick, even one that did nothing", async () => {
    await tick();
    await tick();
    expect((await one<{ n: number }>(`select count(*)::int as n from engine_tick_runs`)).n).toBe(2);
  });

  it("shows the newest first, with how long it took", async () => {
    await db.exec(`select set_engine_running(true)`);
    await readyClient(CLIENT, { cap: 100, perWeek: 1 });
    await tick();
    const row = await one<{ jobs_queued: number; took: unknown }>(
      `select jobs_queued, took from engine_activity limit 1`,
    );
    expect(row.jobs_queued).toBe(1);
    expect(row.took).not.toBeNull();
  });
});

describe("who may run it", () => {
  it("is not executable by a signed-in person", async () => {
    // The tick spends money. It belongs to cron and the service role.
    await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
    await db.exec(`set role authenticated;`);
    await expect(db.exec(`select engine_tick()`)).rejects.toThrow(/permission denied/i);
    await db.exec(`reset role;`);
  });

  it("refuses the global switch to anyone who is not an admin", async () => {
    await db.exec(`insert into auth.users (id) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
                   on conflict do nothing;
                   insert into profiles (id, role) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'staff')
                   on conflict do nothing;`);
    await db.exec(`select set_config('request.jwt.claim.sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', false);`);
    await db.exec(`set role authenticated;`);
    await expect(db.exec(`select set_engine_running(true)`)).rejects.toThrow(/Only an admin/);
    await db.exec(`reset role;`);
  });
});

describe("the schedule", () => {
  it("is registered, hourly, and calls the tick", async () => {
    const job = await one<{ jobname: string; schedule: string; command: string }>(
      `select jobname, schedule, command from cron.job where jobname = 'engine-tick'`,
    );
    expect(job.schedule).toBe("7 * * * *");
    expect(job.command).toMatch(/engine_tick/);
  });

  it("is registered exactly once, so re-applying does not double it", async () => {
    await db.exec(await migration("20261006040000_150_engine_tick.sql"));
    const { n } = await one<{ n: number }>(
      `select count(*)::int as n from cron.job where jobname = 'engine-tick'`,
    );
    expect(n).toBe(1);
  });
});
