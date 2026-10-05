import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 146 against a real Postgres.
 *
 * The engine spends money per tick. The property worth proving before any of
 * it is built is that it does not run: a client nobody has configured is off,
 * a client half configured is off, and switching one on is a separate,
 * admin-only act from changing its settings.
 *
 * The real migration file is applied, not a copy of it.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const READY = "11111111-1111-4111-8111-111111111111";
const BARE = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}

/** Signed in as this person, through RLS. Drops privilege for real. */
async function asUser<T = Record<string, unknown>>(userId: string, sql: string): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false);`);
  await db.exec(`set role authenticated;`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`reset role;`);
  }
}

/** As admin, but still as the owner, for setup. */
const asAdmin = async (sql: string) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
  return db.query(sql);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create type post_platform as enum ('facebook', 'instagram', 'tiktok', 'linkedin', 'youtube');

    create table clients (id uuid primary key, name text not null, timezone text not null default 'Europe/London');
    create table profiles (id uuid primary key, role text);
    create table client_members (client_id uuid, user_id uuid);

    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable security definer as
      $$ select is_admin() or exists (
           select 1 from client_members m where m.client_id = p and m.user_id = auth.uid()) $$;

    create table client_content_pillars (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients(id) on delete cascade,
      name text not null, target_share integer not null default 25, active boolean not null default true
    );
    create table client_engine_budgets (
      client_id uuid not null references clients(id) on delete cascade,
      month date not null, cap_usd numeric not null, primary key (client_id, month)
    );

    insert into auth.users (id) values ('${ADMIN}'), ('${MEMBER}');
    insert into profiles (id, role) values ('${ADMIN}', 'admin'), ('${MEMBER}', 'staff');
    insert into clients (id, name) values ('${READY}', 'Harbour'), ('${BARE}', 'Nobody');
    insert into client_members (client_id, user_id) values ('${READY}', '${MEMBER}');
    insert into client_content_pillars (client_id, name) values ('${READY}', 'Proof');
    insert into client_engine_budgets (client_id, month, cap_usd)
      values ('${READY}', date_trunc('month', now())::date, 200);
  `);

  await db.exec(await migration("20261005210000_146_engine_settings.sql"));
  await db.exec(`grant usage on schema public, auth to authenticated;
                 grant select on clients, client_content_pillars, client_engine_budgets to authenticated;`);
});

describe("off until somebody turns it on", () => {
  beforeEach(async () => {
    await db.exec(`delete from client_engine_settings; delete from client_engine_platforms;
                   delete from client_engine_windows;`);
  });

  it("says no for a client nobody has ever configured", async () => {
    const { on } = await one<{ on: boolean }>(`select engine_is_enabled('${BARE}') as on`);
    expect(on).toBe(false);
  });

  it("says no for a client that does not exist at all", async () => {
    const { on } = await one<{ on: boolean }>(`select engine_is_enabled(gen_random_uuid()) as on`);
    expect(on).toBe(false);
  });

  it("creates the row switched off when it is first configured", async () => {
    await asAdmin(`select set_engine_settings('${READY}', 21)`);
    const { enabled, plan_horizon_days } = await one<{ enabled: boolean; plan_horizon_days: number }>(
      `select enabled, plan_horizon_days from client_engine_settings where client_id = '${READY}'`,
    );
    expect(enabled).toBe(false);
    expect(plan_horizon_days).toBe(21);
  });

  it("will not let settings be the thing that switches it on", async () => {
    // set_engine_settings takes no enabled argument at all. Changing the
    // cadence and starting to spend a client's money are different acts.
    const { n } = await one<{ n: number }>(`
      select count(*)::int as n from information_schema.parameters
      where specific_schema = 'public'
        and specific_name = (select specific_name from information_schema.routines
                             where routine_schema='public' and routine_name='set_engine_settings')
        and parameter_name = 'p_enabled'`);
    expect(n).toBe(0);
  });
});

describe("switching it on", () => {
  beforeEach(async () => {
    await db.exec(`delete from client_engine_settings; delete from client_engine_platforms;
                   delete from client_engine_windows;`);
    await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
  });

  const makeReady = async () => {
    await asAdmin(`select set_engine_platform('${READY}', 'instagram', 3)`);
    await asAdmin(`select add_engine_window('${READY}', 2::smallint, time '09:00', time '11:00')`);
  };

  it("refuses a client with no platform, naming what is missing", async () => {
    await expect(asAdmin(`select set_engine_enabled('${READY}', true)`)).rejects.toThrow(
      /no active platform with a cadence/,
    );
  });

  it("refuses a client with a platform but nowhere to put a post", async () => {
    await asAdmin(`select set_engine_platform('${READY}', 'instagram', 3)`);
    await expect(asAdmin(`select set_engine_enabled('${READY}', true)`)).rejects.toThrow(/no posting windows/);
  });

  it("refuses a client with nothing to write about", async () => {
    await makeReady();
    await db.exec(`update client_content_pillars set active = false where client_id = '${READY}'`);
    await expect(asAdmin(`select set_engine_enabled('${READY}', true)`)).rejects.toThrow(
      /no active content pillars/,
    );
    await db.exec(`update client_content_pillars set active = true where client_id = '${READY}'`);
  });

  it("switches on a client that has all three, and records who did it", async () => {
    await makeReady();
    await asAdmin(`select set_engine_enabled('${READY}', true)`);
    const row = await one<{ enabled: boolean; enabled_by: string; enabled_at: string }>(
      `select enabled, enabled_by, enabled_at from client_engine_settings where client_id = '${READY}'`,
    );
    expect(row.enabled).toBe(true);
    expect(row.enabled_by).toBe(ADMIN);
    expect(row.enabled_at).toBeTruthy();
    expect(await one<{ on: boolean }>(`select engine_is_enabled('${READY}') as on`)).toMatchObject({ on: true });
  });

  it("clears who switched it on when it goes off again", async () => {
    await makeReady();
    await asAdmin(`select set_engine_enabled('${READY}', true)`);
    await asAdmin(`select set_engine_enabled('${READY}', false)`);
    const row = await one<{ enabled: boolean; enabled_by: string | null }>(
      `select enabled, enabled_by from client_engine_settings where client_id = '${READY}'`,
    );
    // A stale "enabled by Alex" on a client that is off reads as though it is on.
    expect(row).toMatchObject({ enabled: false, enabled_by: null });
  });

  it("does not need the preconditions to switch off", async () => {
    await asAdmin(`select set_engine_enabled('${READY}', false)`);
    expect(await one<{ on: boolean }>(`select engine_is_enabled('${READY}') as on`)).toMatchObject({ on: false });
  });
});

describe("who may configure the engine", () => {
  beforeEach(async () => {
    await db.exec(`delete from client_engine_settings; delete from client_engine_platforms;
                   delete from client_engine_windows;`);
  });

  it("drops privilege for real, or none of the rest means anything", async () => {
    const rows = await asUser<{ role: string }>(MEMBER, `select current_user as role`);
    expect(rows[0]?.role).toBe("authenticated");
  });

  it("refuses a member, even one with access to the client", async () => {
    // can_access_client is the bar for writing copy. It is not the bar for
    // switching on a machine that bills.
    await expect(asUser(MEMBER, `select set_engine_settings('${READY}', 21)`)).rejects.toThrow(
      /Only an admin configures the engine/,
    );
    await expect(asUser(MEMBER, `select set_engine_enabled('${READY}', true)`)).rejects.toThrow(
      /Only an admin switches the engine/,
    );
  });

  it("lets a member read the settings for a client they can see", async () => {
    await asAdmin(`select set_engine_settings('${READY}', 21)`);
    const rows = await asUser(MEMBER, `select enabled from client_engine_settings where client_id = '${READY}'`);
    expect(rows).toHaveLength(1);
  });

  it("hides another client's settings from them", async () => {
    await asAdmin(`select set_engine_settings('${BARE}', 21)`);
    const rows = await asUser(MEMBER, `select enabled from client_engine_settings where client_id = '${BARE}'`);
    expect(rows).toHaveLength(0);
  });

  it("refuses a direct write from a member, so the RPC stays the only way in", async () => {
    await expect(
      asUser(MEMBER, `update client_engine_settings set enabled = true where client_id = '${READY}'`),
    ).rejects.toThrow();
  });
});

describe("the settings themselves", () => {
  beforeEach(async () => {
    await db.exec(`delete from client_engine_settings;`);
    await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
  });

  it("refuses a horizon or a score outside its range", async () => {
    await expect(asAdmin(`select set_engine_settings('${READY}', 0)`)).rejects.toThrow(/ces_horizon/);
    await expect(asAdmin(`select set_engine_settings('${READY}', 400)`)).rejects.toThrow(/ces_horizon/);
    await expect(
      asAdmin(`select set_engine_settings('${READY}', null, null, null, 101)`),
    ).rejects.toThrow(/ces_qa_score/);
  });

  it("refuses an approval mode it does not have", async () => {
    await expect(
      asAdmin(`select set_engine_settings('${READY}', null, null, null, null, 'whenever')`),
    ).rejects.toThrow(/ces_approval_mode/);
  });

  it("leaves untouched anything it was not given", async () => {
    await asAdmin(`select set_engine_settings('${READY}', 21, true)`);
    await asAdmin(`select set_engine_settings('${READY}', null, null, null, 85)`);
    const row = await one<{ plan_horizon_days: number; auto_approve_ideas: boolean; min_qa_score: number }>(
      `select plan_horizon_days, auto_approve_ideas, min_qa_score
       from client_engine_settings where client_id = '${READY}'`,
    );
    expect(row).toMatchObject({ plan_horizon_days: 21, auto_approve_ideas: true, min_qa_score: 85 });
  });

  it("refuses a client that does not exist", async () => {
    await expect(asAdmin(`select set_engine_settings(gen_random_uuid(), 21)`)).rejects.toThrow(
      /client does not exist/,
    );
  });

  it("starts with both policy approvals off", async () => {
    await asAdmin(`select set_engine_settings('${READY}')`);
    const row = await one<{ auto_approve_ideas: boolean; auto_approve_briefs: boolean }>(
      `select auto_approve_ideas, auto_approve_briefs from client_engine_settings where client_id = '${READY}'`,
    );
    expect(row).toMatchObject({ auto_approve_ideas: false, auto_approve_briefs: false });
  });
});

describe("windows", () => {
  beforeEach(async () => {
    await db.exec(`delete from client_engine_windows;`);
    await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
  });

  it("refuses a window that ends before it starts", async () => {
    await expect(
      asAdmin(`select add_engine_window('${READY}', 2::smallint, time '11:00', time '09:00')`),
    ).rejects.toThrow(/cew_order/);
  });

  it("refuses a weekday outside Monday to Sunday", async () => {
    await expect(
      asAdmin(`select add_engine_window('${READY}', 0::smallint, time '09:00', time '11:00')`),
    ).rejects.toThrow(/cew_weekday/);
    await expect(
      asAdmin(`select add_engine_window('${READY}', 8::smallint, time '09:00', time '11:00')`),
    ).rejects.toThrow(/cew_weekday/);
  });

  it("takes Monday as 1 and Sunday as 7", async () => {
    await asAdmin(`select add_engine_window('${READY}', 1::smallint, time '09:00', time '11:00')`);
    await asAdmin(`select add_engine_window('${READY}', 7::smallint, time '18:00', time '20:00')`);
    const { n } = await one<{ n: number }>(
      `select count(*)::int as n from client_engine_windows where client_id = '${READY}'`,
    );
    expect(n).toBe(2);
  });
});

describe("engine_readiness", () => {
  beforeEach(async () => {
    await db.exec(`delete from client_engine_settings; delete from client_engine_platforms;
                   delete from client_engine_windows;`);
    await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
  });

  const readinessOf = async (client: string) =>
    (await one<{ readiness: string }>(`select readiness from engine_readiness where client_id = '${client}'`))
      .readiness;

  it("names the next thing to fix, one at a time", async () => {
    expect(await readinessOf(READY)).toBe("Not configured");

    await asAdmin(`select set_engine_settings('${READY}')`);
    expect(await readinessOf(READY)).toBe("No platform with a cadence");

    await asAdmin(`select set_engine_platform('${READY}', 'instagram', 3)`);
    expect(await readinessOf(READY)).toBe("No posting windows");

    await asAdmin(`select add_engine_window('${READY}', 2::smallint, time '09:00', time '11:00')`);
    expect(await readinessOf(READY)).toBe("Ready, switched off");

    await asAdmin(`select set_engine_enabled('${READY}', true)`);
    expect(await readinessOf(READY)).toBe("Running");
  });

  it("notices a missing spend cap before it says ready", async () => {
    // The budget is what stops the engine spending without limit. A client
    // with no cap is not ready however well configured it is.
    await asAdmin(`select set_engine_settings('${BARE}')`);
    await asAdmin(`select set_engine_platform('${BARE}', 'instagram', 3)`);
    await asAdmin(`select add_engine_window('${BARE}', 2::smallint, time '09:00', time '11:00')`);
    await db.exec(`insert into client_content_pillars (client_id, name) values ('${BARE}', 'Proof')`);
    expect(await readinessOf(BARE)).toBe("No spend cap set");
  });

  it("lists a client that has never been near the engine", async () => {
    const { n } = await one<{ n: number }>(`select count(*)::int as n from engine_readiness`);
    expect(n).toBe(2);
  });

  it("counts a platform with no cadence as no platform", async () => {
    await asAdmin(`select set_engine_settings('${READY}')`);
    await asAdmin(`select set_engine_platform('${READY}', 'instagram', 0)`);
    expect(await readinessOf(READY)).toBe("No platform with a cadence");
    await asAdmin(`select set_engine_platform('${READY}', 'instagram', 3, false)`);
    expect(await readinessOf(READY)).toBe("No platform with a cadence");
  });
});
