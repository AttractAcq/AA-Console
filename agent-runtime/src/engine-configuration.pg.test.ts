import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 282 against a real Postgres.
 *
 * `engine_tick` reads three gates before it will plan anything, and two of
 * them had no writer anywhere in the system. The tests below are mostly about
 * the readiness row, because that row is what an operator reads to decide
 * what to fix, and it was capable of saying "Running" about a client whose
 * engine was switched off globally and whose pipeline would park at the
 * second of nine stages waiting for a person.
 *
 * So the ladder is walked one rung at a time: each gate is cleared, and the
 * row is asked what is wrong next. The order matters as much as the content,
 * because the first thing it names is the thing someone will go and do.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(query, params)).rows;
}
async function one<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(query, params))[0]!;
}

/** The sentence an operator reads, for this client, right now. */
async function readiness(): Promise<string> {
  return (
    await one<{ readiness: string }>("select readiness from engine_readiness where client_id = $1", [CLIENT])
  ).readiness;
}

/** Clear one gate at a time, in the order the ladder names them. */
const give = {
  settings: () => db.query("insert into client_engine_settings(client_id) values($1)", [CLIENT]),
  platform: () =>
    db.query("insert into client_engine_platforms(client_id, active, posts_per_week) values($1,true,4)", [
      CLIENT,
    ]),
  window: () => db.query("insert into client_engine_windows(client_id) values($1)", [CLIENT]),
  pillar: () => db.query("insert into client_content_pillars(client_id, active) values($1,true)", [CLIENT]),
  cap: () => db.query("select set_client_engine_budget_v6($1, current_date, 250)", [CLIENT]),
  clientSwitch: () => db.query("update client_engine_settings set enabled = true where client_id = $1", [CLIENT]),
  globalSwitch: () => db.query("update engine_controls set enabled = true where id"),
  ideaPolicy: () =>
    db.query("update client_engine_settings set auto_approve_ideas = true where client_id = $1", [CLIENT]),
  briefPolicy: () =>
    db.query("update client_engine_settings set auto_approve_briefs = true where client_id = $1", [CLIENT]),
};

beforeEach(async () => {
  await db?.close();
  db = new PGlite();

  await db.exec(`
 create schema if not exists auth;
 create role authenticated; create role anon; create role service_role;

 create table clients(
   id uuid primary key,
   name text not null default 'A client',
   timezone text not null default 'Europe/London');

 create table client_engine_settings(
   client_id uuid primary key references clients(id) on delete cascade,
   enabled boolean not null default false,
   plan_horizon_days integer not null default 14,
   auto_approve_ideas boolean not null default false,
   auto_approve_briefs boolean not null default false,
   approval_mode text not null default 'per_post');

 create table client_engine_platforms(
   client_id uuid not null references clients(id) on delete cascade,
   active boolean not null default false,
   posts_per_week integer not null default 0);

 create table client_engine_windows(
   client_id uuid not null references clients(id) on delete cascade);

 create table client_content_pillars(
   client_id uuid not null references clients(id) on delete cascade,
   active boolean not null default false);

 create table client_engine_budgets(
   client_id uuid not null references clients(id) on delete cascade,
   month date not null,
   cap_usd numeric not null check (cap_usd >= 0),
   note text,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now(),
   primary key (client_id, month),
   constraint client_engine_budgets_month_start
     check (month = (date_trunc('month', month::timestamptz))::date));

 -- The singleton global switch: id is a boolean so only one row can exist.
 create table engine_controls(
   id boolean primary key default true check (id),
   enabled boolean not null default false,
   note text,
   updated_at timestamptz not null default now(),
   updated_by uuid);
 insert into engine_controls(id, enabled) values(true, false);

 create function auth.uid() returns uuid language sql stable as $a$
   select '11111111-1111-4111-8111-111111111111'::uuid $a$;

 create function can_access_client(p_client_id uuid) returns boolean
  language sql stable as $c$
   select coalesce(current_setting('test.deny', true), '') <> p_client_id::text $c$;

 create function lock_down_definer_functions() returns void language sql as $l$
   select null::void $l$;

 insert into clients(id, name) values('${CLIENT}', 'Attract Acquisition');`);

  await db.exec(await sql("20261030190000_282_the_engines_own_configuration.sql"));
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("the monthly spend cap, which nothing could set", () => {
  it("sets it for the month engine_tick will read", async () => {
    const row = await one<{ cap_usd: string; month: Date }>(
      "select * from set_client_engine_budget_v6($1, current_date, 250, 'First month')",
      [CLIENT],
    );
    expect(Number(row.cap_usd)).toBe(250);
    // Normalised to the month start, which is what the engine joins on.
    // PGlite hands a date column back as a Date, not a string.
    expect(new Date(row.month).getUTCDate()).toBe(1);
  });

  it("raises the cap in place rather than adding a second row for the month", async () => {
    await db.query("select set_client_engine_budget_v6($1, current_date, 250)", [CLIENT]);
    await db.query("select set_client_engine_budget_v6($1, current_date, 400)", [CLIENT]);
    const all = await rows<{ cap_usd: string }>("select cap_usd from client_engine_budgets where client_id = $1", [
      CLIENT,
    ]);
    expect(all).toHaveLength(1);
    expect(Number(all[0]!.cap_usd)).toBe(400);
  });

  it("refuses a cap of zero, which stops the engine rather than configuring it", async () => {
    await expect(
      db.query("select set_client_engine_budget_v6($1, current_date, 0)", [CLIENT]),
    ).rejects.toThrow(/positive amount/);
  });

  it("refuses an implausible cap, because the realistic mistake is an extra zero", async () => {
    await expect(
      db.query("select set_client_engine_budget_v6($1, current_date, 25000)", [CLIENT]),
    ).rejects.toThrow(/deliberate change to this limit/);
  });

  it("refuses a month already gone, which could never restrain anything", async () => {
    await expect(
      db.query("select set_client_engine_budget_v6($1, (current_date - interval '2 months')::date, 250)", [
        CLIENT,
      ]),
    ).rejects.toThrow(/already passed/);
  });

  it("accepts next month, so a cap can be set in advance", async () => {
    const row = await one<{ cap_usd: string }>(
      "select * from set_client_engine_budget_v6($1, (current_date + interval '1 month')::date, 300)",
      [CLIENT],
    );
    expect(Number(row.cap_usd)).toBe(300);
  });

  it("refuses a caller who may not configure this client", async () => {
    await db.exec(`set test.deny = '${CLIENT}'`);
    await expect(
      db.query("select set_client_engine_budget_v6($1, current_date, 250)", [CLIENT]),
    ).rejects.toThrow("Not permitted for this client");
  });
});

describe("the client's timezone, which nothing could set", () => {
  it("sets a zone the server knows", async () => {
    const row = await one<{ timezone: string }>("select * from set_client_timezone_v6($1,'Africa/Johannesburg')", [
      CLIENT,
    ]);
    expect(row.timezone).toBe("Africa/Johannesburg");
  });

  it("refuses a zone the server does not know, rather than planning at the wrong hour", async () => {
    await expect(db.query("select set_client_timezone_v6($1,'Mars/Olympus_Mons')", [CLIENT])).rejects.toThrow(
      /Unknown timezone/,
    );
    // And the old zone is untouched.
    const kept = await one<{ timezone: string }>("select timezone from clients where id = $1", [CLIENT]);
    expect(kept.timezone).toBe("Europe/London");
  });

  it("refuses a caller who may not configure this client", async () => {
    await db.exec(`set test.deny = '${CLIENT}'`);
    await expect(db.query("select set_client_timezone_v6($1,'Africa/Johannesburg')", [CLIENT])).rejects.toThrow(
      "Not permitted for this client",
    );
  });
});

describe("the readiness ladder", () => {
  it("names each gate in the order someone should clear them", async () => {
    expect(await readiness()).toBe("Not configured");

    await give.settings();
    expect(await readiness()).toBe("No platform with a cadence");

    await give.platform();
    expect(await readiness()).toBe("No posting windows");

    await give.window();
    expect(await readiness()).toBe("No active content pillars");

    await give.pillar();
    // The gate that had no writer before this migration, and the only one the
    // old view ever reported.
    expect(await readiness()).toBe("No spend cap set");

    await give.cap();
    expect(await readiness()).toBe("Ready, switched off");

    await give.clientSwitch();
    // The rung the old view skipped entirely: it would have said "Running".
    expect(await readiness()).toBe("Ready and switched on, but the engine is off globally");

    await give.globalSwitch();
    // And the two rungs that decide whether "running" means unattended.
    expect(await readiness()).toBe("Running, but a person must choose each idea");

    await give.ideaPolicy();
    expect(await readiness()).toBe("Running, but a person must approve each brief");

    await give.briefPolicy();
    expect(await readiness()).toBe("Running");
  });

  it("reports the global switch separately, so a screen can show why", async () => {
    await give.settings();
    const off = await one<{ engine_running: boolean }>(
      "select engine_running from engine_readiness where client_id = $1",
      [CLIENT],
    );
    expect(off.engine_running).toBe(false);

    await give.globalSwitch();
    const on = await one<{ engine_running: boolean }>(
      "select engine_running from engine_readiness where client_id = $1",
      [CLIENT],
    );
    expect(on.engine_running).toBe(true);
  });

  it("says whether the pipeline can advance without a person", async () => {
    await give.settings();
    const parked = await one<{ advances_without_a_person: boolean }>(
      "select advances_without_a_person from engine_readiness where client_id = $1",
      [CLIENT],
    );
    // approve_idea_by_policy raises while this is false, so the slot stops at
    // ideating however green everything else looks.
    expect(parked.advances_without_a_person).toBe(false);

    await give.ideaPolicy();
    await give.briefPolicy();
    const unattended = await one<{ advances_without_a_person: boolean }>(
      "select advances_without_a_person from engine_readiness where client_id = $1",
      [CLIENT],
    );
    expect(unattended.advances_without_a_person).toBe(true);
  });

  it("carries the cap and the timezone the writers set", async () => {
    await give.settings();
    await db.query("select set_client_timezone_v6($1,'Africa/Johannesburg')", [CLIENT]);
    await give.cap();
    const row = await one<{ timezone: string; month_cap_usd: string }>(
      "select timezone, month_cap_usd from engine_readiness where client_id = $1",
      [CLIENT],
    );
    expect(row.timezone).toBe("Africa/Johannesburg");
    expect(Number(row.month_cap_usd)).toBe(250);
  });
});
