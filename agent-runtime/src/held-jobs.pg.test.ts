import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 163 and 164 against a real Postgres.
 *
 * A client reaching its monthly cap used to have its job failed
 * non-retryably and its slot failed with it, and nothing resumed either when
 * the cap was raised or when the month rolled over. A cap reached on the 3rd
 * threw away the rest of that client's engine work, and the only way out of
 * a failed slot is back to planned — which pays for the ideation, the brief
 * and the build a second time.
 *
 * The subtle half is the tick: a held job still exists for its slot, so it
 * has to count as in flight. Without that, one held job becomes a new job
 * every hour, each refused and failed.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SLOT = "44444444-4444-4444-8444-444444444444";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}
async function asEngine<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);`);
  }
}

/** A queued engine job for a slot, as the tick leaves one. */
async function job(over: { agent?: string; client?: string | null; slot?: string } = {}) {
  const client = over.client === undefined ? `'${CLIENT}'` : over.client === null ? "null" : `'${over.client}'`;
  const { id } = await one<{ id: string }>(
    `insert into agent_jobs (agent_key, client_id, params)
     values ('${over.agent ?? "ideation"}', ${client},
             jsonb_build_object('slot_id','${over.slot ?? SLOT}'))
     returning id`,
  );
  return id;
}

/** Set a cap and a spend for this month. */
async function cap(capUsd: number | null, spent: number) {
  await db.exec(`delete from client_engine_budgets where client_id = '${CLIENT}';`);
  if (capUsd !== null) {
    await db.exec(`insert into client_engine_budgets (client_id, month, cap_usd)
                   values ('${CLIENT}', date_trunc('month', now())::date, ${capUsd})`);
  }
  await db.exec(`update aa_spend set spent = ${spent}`);
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
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
    create function cron.schedule(a text,b text,c text) returns bigint language sql as
      $$ insert into cron.job (jobname,schedule,command) values (a,b,c) returning jobid $$;
    create function cron.unschedule(a text) returns boolean language sql as
      $$ delete from cron.job where jobname=a returning true $$;

    create type job_status as enum ('queued','claimed','running','completed','failed','cancelled');
    create table clients (id uuid primary key, name text);
    create table profiles (id uuid primary key, role text);
    create function is_admin() returns boolean language sql stable as
      $$ select exists (select 1 from profiles where id = auth.uid() and role='admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable as $$ select true $$;

    create table agents (agent_key text primary key, name text,
      paused boolean not null default false, archived_at timestamptz);
    insert into agents (agent_key, name) values ('ideation','Ideation'), ('brief','Brief');

    create table agent_jobs (id uuid primary key default gen_random_uuid(),
      agent_key text references agents(agent_key), client_id uuid, input_table text, input_id uuid,
      status job_status not null default 'queued', attempts int not null default 0,
      max_attempts int not null default 3, lease_until timestamptz, error text,
      input_tokens int not null default 0, output_tokens int not null default 0,
      cost_usd numeric not null default 0, created_by uuid,
      created_at timestamptz not null default now(), started_at timestamptz,
      completed_at timestamptz, lease_owner text, run_id uuid,
      params jsonb not null default '{}'::jsonb, terminal boolean not null default false,
      run_after timestamptz);

    create table client_engine_budgets (client_id uuid, month date, cap_usd numeric,
      primary key (client_id, month));
    -- A knob the tests turn, standing in for the real spend sum.
    create table aa_spend (spent numeric not null default 0);
    insert into aa_spend values (0);
    create function client_budget_state(p_client_id uuid)
      returns table (capped boolean, cap_usd numeric, spent_usd numeric, remaining_usd numeric)
      language sql stable as $$
      select (b.cap_usd is not null) as capped, b.cap_usd,
             (select spent from aa_spend) as spent_usd,
             b.cap_usd - (select spent from aa_spend) as remaining_usd
        from client_engine_budgets b
       where b.client_id = p_client_id and b.month = date_trunc('month', now())::date
      union all
      select false, null::numeric, (select spent from aa_spend), null::numeric
       where not exists (select 1 from client_engine_budgets b2
                          where b2.client_id = p_client_id
                            and b2.month = date_trunc('month', now())::date)
      limit 1 $$;

    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;

    create function engine_jobs_in_flight(p_client_id uuid) returns integer language sql stable as $$
      select count(*)::integer from agent_jobs j
       where j.client_id = p_client_id and j.params ? 'slot_id'
         and j.status in ('queued','claimed','running') $$;
    create function slot_has_job_in_flight(p_slot_id uuid) returns boolean language sql stable as $$
      select exists (select 1 from agent_jobs j
        where j.params->>'slot_id' = p_slot_id::text
          and j.status in ('queued','claimed','running')) $$;

    insert into auth.users (id) values ('${ADMIN}');
    insert into profiles (id, role) values ('${ADMIN}','admin');
    insert into clients (id, name) values ('${CLIENT}','Harbour');
  `);

  // 163 adds the enum value. Postgres refuses to use a new enum value in the
  // transaction that adds it, which is why this is two files and two execs.
  await db.exec(await migration("20261007110000_163_a_job_can_be_held.sql"));
  await db.exec(await migration("20261007120000_164_holding_and_resuming.sql"));

  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                 select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
});

beforeEach(async () => {
  await db.exec(`delete from agent_jobs; delete from client_engine_budgets;
                 update aa_spend set spent = 0;
                 update agents set paused = false, archived_at = null;`);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                 select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
});

describe("holding a job", () => {
  it("records why, and leaves it un-finished", async () => {
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Spent $500 of its $500 cap.')`);
    const j = await one<{
      status: string;
      error: string;
      terminal: boolean;
      completed_at: string | null;
      lease_owner: string | null;
    }>(`select status, error, terminal, completed_at, lease_owner from agent_jobs where id = '${id}'`);
    expect(j.status).toBe("paused");
    expect(j.error).toMatch(/\$500 cap/);
    expect(j.terminal).toBe(false);
    expect(j.completed_at).toBeNull();
    expect(j.lease_owner).toBeNull();
  });

  it("does not spend one of the job's attempts", async () => {
    // Waiting is not trying. Counting it would let a job that was held
    // three times run out of retries without ever having run.
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Over cap.')`);
    await asEngine(`select resume_paused_jobs()`);
    await asEngine(`select pause_agent_job('${id}', 'Over cap again.')`);
    const { attempts } = await one<{ attempts: number }>(
      `select attempts from agent_jobs where id = '${id}'`,
    );
    expect(attempts).toBe(0);
  });

  it("insists on a reason, because it is what says when it will resume", async () => {
    const id = await job();
    await expect(asEngine(`select pause_agent_job('${id}', '  ')`)).rejects.toThrow(/Say why it is held/);
  });

  it("will not hold work that is already finished", async () => {
    const id = await job();
    await db.exec(`update agent_jobs set status = 'completed' where id = '${id}'`);
    await expect(asEngine(`select pause_agent_job('${id}', 'Over cap.')`)).rejects.toThrow(
      /finished work is not held/,
    );
  });

  it("is the runtime's to call, not a person's", async () => {
    const id = await job();
    await expect(db.exec(`select pause_agent_job('${id}', 'Over cap.')`)).rejects.toThrow(
      /held by the runtime/,
    );
  });
});

describe("the tick must not queue a second job for a held slot", () => {
  it("counts a held job as in flight", async () => {
    // Without this, one held job becomes a new job every hour, each refused
    // by the cap and failed, and a pile of duplicates the moment it lifts.
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Over cap.')`);
    const { n } = await one<{ n: number }>(`select engine_jobs_in_flight('${CLIENT}') as n`);
    expect(n).toBe(1);
  });

  it("says the slot already has something on it", async () => {
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Over cap.')`);
    const { busy } = await one<{ busy: boolean }>(
      `select slot_has_job_in_flight('${SLOT}') as busy`,
    );
    expect(busy).toBe(true);
  });

  it("still does not count work that is genuinely finished", async () => {
    const id = await job();
    await db.exec(`update agent_jobs set status = 'completed' where id = '${id}'`);
    const { n } = await one<{ n: number }>(`select engine_jobs_in_flight('${CLIENT}') as n`);
    expect(n).toBe(0);
  });
});

describe("resuming", () => {
  it("puts it back in the queue once the cap is raised", async () => {
    await cap(100, 150);
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Over cap.')`);

    // Nothing yet: still over.
    expect((await asEngine<{ n: number }>(`select resume_paused_jobs() as n`))[0]!.n).toBe(0);

    await cap(500, 150);
    expect((await asEngine<{ n: number }>(`select resume_paused_jobs() as n`))[0]!.n).toBe(1);
    const j = await one<{ status: string; error: string | null }>(
      `select status, error from agent_jobs where id = '${id}'`,
    );
    expect(j.status).toBe("queued");
    // The reason goes with the hold: a queued job carrying last month's
    // explanation reads as a job that failed.
    expect(j.error).toBeNull();
  });

  it("resumes on its own when the month rolls, with nobody raising anything", async () => {
    // The cap row is per month, so a cap reached in one month is simply not
    // a cap in the next. This is the case that used to throw the work away.
    await cap(100, 150);
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Over cap.')`);
    expect((await asEngine<{ n: number }>(`select resume_paused_jobs() as n`))[0]!.n).toBe(0);

    // Last month's cap, this month's spend.
    await db.exec(`update client_engine_budgets
                      set month = (date_trunc('month', now()) - interval '1 month')::date
                    where client_id = '${CLIENT}'`);
    expect((await asEngine<{ n: number }>(`select resume_paused_jobs() as n`))[0]!.n).toBe(1);
  });

  it("leaves a job held while its agent is still paused", async () => {
    // Re-checks the reason rather than trusting the recorded one: a job held
    // for a cap, whose agent has since been paused, must stay held.
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Over cap.')`);
    await db.exec(`update agents set paused = true where agent_key = 'ideation'`);
    expect((await asEngine<{ n: number }>(`select resume_paused_jobs() as n`))[0]!.n).toBe(0);
    await db.exec(`update agents set paused = false where agent_key = 'ideation'`);
    expect((await asEngine<{ n: number }>(`select resume_paused_jobs() as n`))[0]!.n).toBe(1);
  });

  it("leaves a job held while its agent is archived", async () => {
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Over cap.')`);
    await db.exec(`update agents set archived_at = now() where agent_key = 'ideation'`);
    expect((await asEngine<{ n: number }>(`select resume_paused_jobs() as n`))[0]!.n).toBe(0);
  });

  it("resumes a house job, which has no client to charge", async () => {
    const id = await job({ client: null });
    await asEngine(`select pause_agent_job('${id}', 'Agent was paused.')`);
    expect((await asEngine<{ n: number }>(`select resume_paused_jobs() as n`))[0]!.n).toBe(1);
  });

  it("touches nothing that is not held", async () => {
    const queued = await job();
    const failed = await job({ slot: "55555555-5555-4555-8555-555555555555" });
    await db.exec(`update agent_jobs set status = 'failed', terminal = true where id = '${failed}'`);
    await asEngine(`select resume_paused_jobs()`);
    const after = await rows<{ id: string; status: string }>(
      `select id, status from agent_jobs order by created_at`,
    );
    expect(after.find((r) => r.id === queued)!.status).toBe("queued");
    expect(after.find((r) => r.id === failed)!.status).toBe("failed");
  });

  it("is the runtime's to call", async () => {
    await expect(db.exec(`select resume_paused_jobs()`)).rejects.toThrow(/resumed by the runtime/);
  });

  it("runs on its own, after the tick rather than racing it", async () => {
    const { schedule } = await one<{ schedule: string }>(
      `select schedule from cron.job where jobname = 'resume-paused-jobs'`,
    );
    expect(schedule).toBe("10 * * * *");
  });
});

describe("what is being held, and why", () => {
  it("says the reason and whether it has passed", async () => {
    await cap(100, 150);
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Spent $150 of its $100 cap.')`);
    const held = await one<{
      held_because: string;
      would_resume_now: boolean;
      agent_name: string;
      client_name: string;
      slot_id: string;
    }>(`select held_because, would_resume_now, agent_name, client_name, slot_id from held_jobs`);
    expect(held.held_because).toMatch(/\$100 cap/);
    expect(held.would_resume_now).toBe(false);
    expect(held.agent_name).toBe("Ideation");
    expect(held.client_name).toBe("Harbour");
    expect(held.slot_id).toBe(SLOT);
  });

  it("flags a job whose reason has passed, which means the resume is not running", async () => {
    const id = await job();
    await asEngine(`select pause_agent_job('${id}', 'Over cap.')`);
    const { would_resume_now } = await one<{ would_resume_now: boolean }>(
      `select would_resume_now from held_jobs`,
    );
    expect(would_resume_now).toBe(true);
  });

  it("lists nothing when nothing is held", async () => {
    await job();
    expect(await rows(`select 1 from held_jobs`)).toHaveLength(0);
  });
});
