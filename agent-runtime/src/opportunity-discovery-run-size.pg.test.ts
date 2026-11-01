import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 304 against a real Postgres.
 *
 * The notes ask for the one thing a discovery run could never be told: how many
 * opportunities to look for. The channel for it existed -- agent_jobs.params is
 * jsonb and other callers use it -- but enqueue_agent_job, the RPC a browser
 * calls, takes no parameters at all.
 *
 * Adding p_params to that RPC would have been three lines and would have handed
 * any signed-in caller the ability to shape the input of every agent in the
 * system. So this is a narrow writer for one agent, and what is worth pinning
 * is the bounds it refuses and that it stays scoped to its own client.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

beforeEach(async () => {
  await db?.close();
  db = new PGlite();

  await db.exec(`
 create schema if not exists auth;
 create role authenticated; create role anon; create role service_role;

 create table clients(id uuid primary key);
 create table agent_jobs(
   id uuid primary key default gen_random_uuid(),
   agent_key text not null,
   client_id uuid references clients(id) on delete cascade,
   input_table text, input_id uuid,
   status text not null default 'queued',
   params jsonb not null default '{}',
   created_by uuid,
   created_at timestamptz not null default now());

 create function auth.uid() returns uuid language sql stable as $a$
   select '11111111-1111-4111-8111-111111111111'::uuid $a$;
 create function current_role_of() returns text language sql stable as $a$
   select nullif(current_setting('test.role', true), '') $a$;
 create function can_access_client(p uuid) returns boolean language sql stable as $a$
   select coalesce(current_setting('test.deny', true), '') <> p::text $a$;
 create function lock_down_definer_functions() returns void language sql as $l$
   select null::void $l$;

 create function enqueue_agent_job_internal(
   p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
   p_actor uuid, p_params jsonb, p_description text)
 returns uuid language plpgsql as $e$
 declare v uuid;
 begin
   insert into agent_jobs(agent_key, client_id, input_table, input_id, created_by, params)
   values (p_agent_key, p_client_id, p_input_table, p_input_id, p_actor, p_params)
   returning id into v;
   return v;
 end $e$;

 insert into clients(id) values('${CLIENT}');
 select set_config('test.role', 'admin', false);`);

  await db.exec(await sql("20261102020000_304_how_many_opportunities_to_look_for.sql"));
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("asking for a number of opportunities", () => {
  it("queues one job carrying the requested count", async () => {
    await db.query("select request_opportunity_discovery_v6($1, 6)", [CLIENT]);
    const job = await one<{ agent_key: string; params: Record<string, unknown> }>(
      "select agent_key, params from agent_jobs",
    );
    expect(job.agent_key).toBe("opportunity_discovery");
    expect(job.params).toEqual({ opportunity_count: 6 });
  });

  it("defaults to four when no number is given", async () => {
    await db.query("select request_opportunity_discovery_v6($1)", [CLIENT]);
    const job = await one<{ params: Record<string, unknown> }>("select params from agent_jobs");
    expect(job.params).toEqual({ opportunity_count: 4 });
  });

  it("accepts both ends of the range", async () => {
    await db.query("select request_opportunity_discovery_v6($1, 2)", [CLIENT]);
    await db.query("update agent_jobs set status = 'succeeded'");
    await db.query("select request_opportunity_discovery_v6($1, 8)", [CLIENT]);
    const counts = await rows<{ params: Record<string, unknown> }>(
      "select params from agent_jobs order by created_at",
    );
    expect(counts.map((c) => c.params.opportunity_count)).toEqual([2, 8]);
  });
});

describe("what it refuses", () => {
  it("refuses more than the agent is known to honour", async () => {
    // The ceiling is about cost and about the model holding a genuinely
    // distinct set in one pass, so the screen cannot talk past it.
    await expect(
      db.query("select request_opportunity_discovery_v6($1, 9)", [CLIENT]),
    ).rejects.toThrow(/between 2 and 8/);
    await expect(
      db.query("select request_opportunity_discovery_v6($1, 100)", [CLIENT]),
    ).rejects.toThrow(/between 2 and 8/);
  });

  it("refuses one, because one is not a comparison", async () => {
    await expect(
      db.query("select request_opportunity_discovery_v6($1, 1)", [CLIENT]),
    ).rejects.toThrow(/between 2 and 8/);
    await expect(
      db.query("select request_opportunity_discovery_v6($1, 0)", [CLIENT]),
    ).rejects.toThrow(/between 2 and 8/);
  });

  it("refuses a null count rather than quietly picking one", async () => {
    await expect(
      db.query("select request_opportunity_discovery_v6($1, null)", [CLIENT]),
    ).rejects.toThrow(/between 2 and 8/);
  });

  it("queues nothing when it refuses", async () => {
    await expect(
      db.query("select request_opportunity_discovery_v6($1, 40)", [CLIENT]),
    ).rejects.toThrow();
    const left = await one<{ n: number }>("select count(*)::int as n from agent_jobs");
    expect(left.n).toBe(0);
  });

  it("refuses a caller who may not reach this client", async () => {
    await db.exec(`set test.deny = '${CLIENT}'`);
    await expect(
      db.query("select request_opportunity_discovery_v6($1, 4)", [CLIENT]),
    ).rejects.toThrow("Not permitted for this client");
  });

  it("refuses a caller with no provisioned console account", async () => {
    await db.exec("select set_config('test.role', '', false)");
    await expect(
      db.query("select request_opportunity_discovery_v6($1, 4)", [CLIENT]),
    ).rejects.toThrow(/provisioned console account/);
  });

  it("refuses a null client rather than queueing agency-wide work", async () => {
    await expect(
      db.query("select request_opportunity_discovery_v6(null, 4)"),
    ).rejects.toThrow("Not permitted for this client");
  });
});

describe("one pass at a time", () => {
  it("refuses a second pass while one is already queued or running", async () => {
    // Two passes against the same intelligence produce two sets of hypotheses
    // and no way to tell which run proposed what.
    await db.query("select request_opportunity_discovery_v6($1, 4)", [CLIENT]);
    for (const status of ["queued", "claimed", "running"]) {
      await db.query("update agent_jobs set status = $1", [status]);
      await expect(
        db.query("select request_opportunity_discovery_v6($1, 4)", [CLIENT]),
      ).rejects.toThrow(/already queued or running/);
    }
  });

  it("allows another once the first has finished", async () => {
    await db.query("select request_opportunity_discovery_v6($1, 4)", [CLIENT]);
    await db.query("update agent_jobs set status = 'succeeded'");
    await db.query("select request_opportunity_discovery_v6($1, 5)", [CLIENT]);
    const all = await rows<{ n: number }>("select count(*)::int as n from agent_jobs");
    expect(all[0]!.n).toBe(2);
  });

  it("does not count another client's run against this one", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    await db.query("insert into clients(id) values($1)", [other]);
    await db.query("select request_opportunity_discovery_v6($1, 4)", [other]);
    await db.query("select request_opportunity_discovery_v6($1, 4)", [CLIENT]);
    const all = await one<{ n: number }>("select count(*)::int as n from agent_jobs");
    expect(all.n).toBe(2);
  });
});
