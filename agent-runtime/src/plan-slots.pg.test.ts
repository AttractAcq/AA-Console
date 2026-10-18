import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 149 against a real Postgres.
 *
 * The planner is arithmetic, so it can be pinned exactly rather than
 * approximately: given a cadence, a set of windows and a timezone, there is
 * one right answer and these tests state it. p_now is injected throughout so
 * the assertions are about a known week rather than whatever week CI runs in,
 * which is the difference between a test and a coin toss.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const LONDON = "11111111-1111-4111-8111-111111111111";
const AUCKLAND = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** A Monday, so "this week" in the tests is unambiguous. */
const MONDAY = "2026-11-02 06:00+00";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}
async function all<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}

const plan = (client = LONDON, now = MONDAY) =>
  one<{ created: number; skipped: number; capped: boolean }>(
    `select * from plan_slots('${client}', timestamptz '${now}')`,
  );

/** Configure a client: cadence, windows, pillars, then switch the engine on. */
async function configure(
  client: string,
  opts: {
    perWeek?: number;
    windows?: Array<[number, string]>;
    pillars?: Array<[string, number]>;
    formatMix?: string;
    horizon?: number;
  } = {},
) {
  const { perWeek = 2, windows = [[1, "09:00"], [3, "09:00"]], pillars = [["Proof", 100]] } = opts;
  await db.exec(`delete from client_engine_windows where client_id = '${client}';
                 delete from client_content_pillars where client_id = '${client}';`);
  await db.exec(`select set_engine_platform('${client}', 'instagram', ${perWeek})`);
  for (const [weekday, at] of windows) {
    await db.exec(
      `select add_engine_window('${client}', ${weekday}::smallint, time '${at}', time '${at}'::time + interval '2 hours')`,
    );
  }
  for (const [name, share] of pillars) {
    await db.exec(
      `insert into client_content_pillars (client_id, name, target_share, active)
       values ('${client}', '${name}', ${share}, true)`,
    );
  }
  await db.exec(
    `select set_engine_settings('${client}', ${opts.horizon ?? 14}, null, null, null, null, ${
      opts.formatMix ? `'${opts.formatMix}'::jsonb` : "null"
    })`,
  );
  await db.exec(`select set_engine_enabled('${client}', true)`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

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

    insert into auth.users (id) values ('${ADMIN}');
    insert into profiles (id, role) values ('${ADMIN}', 'admin');
    insert into clients (id, name, timezone) values
      ('${LONDON}', 'Harbour', 'Europe/London'),
      ('${AUCKLAND}', 'Southern', 'Pacific/Auckland');
  `);

  // 146 brings the settings, 147 the slots, 149 the planner.
  await db.exec(await migration("20261005210000_146_engine_settings.sql"));
  await db.exec(await migration("20261005230000_147_content_slots.sql"));
  await db.exec(await migration("20261006020000_149_plan_slots.sql"));
  await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
});

beforeEach(async () => {
  await db.exec(`reset role;`);
  await db.exec(`delete from content_slots; delete from scheduled_posts;
                 delete from client_engine_settings; delete from client_engine_platforms;
                 delete from client_engine_windows; delete from client_content_pillars;`);
  await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
});

describe("the engine has to be on", () => {
  it("refuses a client that was never configured", async () => {
    await expect(plan()).rejects.toThrow(/engine is not on/);
  });

  it("refuses a client that is configured but switched off", async () => {
    await configure(LONDON);
    await db.exec(`select set_engine_enabled('${LONDON}', false)`);
    await expect(plan()).rejects.toThrow(/engine is not on/);
  });

  it("plans nothing it was refused", async () => {
    await configure(LONDON);
    await db.exec(`select set_engine_enabled('${LONDON}', false)`);
    await expect(plan()).rejects.toThrow();
    expect((await one<{ n: number }>(`select count(*)::int as n from content_slots`)).n).toBe(0);
  });
});

describe("cadence", () => {
  it("plans one slot per window per week, up to the cadence", async () => {
    // Two windows a week, two posts a week, two weeks of horizon.
    await configure(LONDON, { perWeek: 2, horizon: 14 });
    const { created } = await plan();
    expect(created).toBe(4);
  });

  it("takes the earliest windows when the cadence asks for fewer than there are", async () => {
    await configure(LONDON, {
      perWeek: 1,
      windows: [[1, "09:00"], [3, "09:00"], [5, "09:00"]],
      horizon: 7,
    });
    const { created } = await plan();
    expect(created).toBe(1);
    const [row] = await all<{ local: string }>(
      `select to_char(scheduled_at at time zone 'Europe/London', 'Dy HH24:MI') as local from content_slots`,
    );
    // Monday, the first window of that week, not Wednesday or Friday.
    expect(row!.local).toBe("Mon 09:00");
  });

  it("is capped by the windows, and says so rather than inventing an hour", async () => {
    // Five a week asked for, three windows available.
    await configure(LONDON, {
      perWeek: 5,
      windows: [[1, "09:00"], [3, "09:00"], [5, "09:00"]],
      horizon: 7,
    });
    const result = await plan();
    expect(result.created).toBe(3);
    expect(result.capped).toBe(true);
  });

  it("does not report a cap when the windows are enough", async () => {
    await configure(LONDON, { perWeek: 2, horizon: 7 });
    expect((await plan()).capped).toBe(false);
  });

  it("counts the cadence per week, not per horizon", async () => {
    await configure(LONDON, { perWeek: 1, horizon: 21 });
    const { created } = await plan();
    // Three weeks of horizon, one a week.
    expect(created).toBe(3);
  });

  it("plans nothing for a client with no windows at all", async () => {
    await configure(LONDON, { perWeek: 2 });
    await db.exec(`delete from client_engine_windows where client_id = '${LONDON}'`);
    expect((await plan()).created).toBe(0);
  });
});

describe("running it twice", () => {
  it("creates nothing the second time", async () => {
    await configure(LONDON, { perWeek: 2, horizon: 14 });
    expect((await plan()).created).toBe(4);
    const second = await plan();
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(4);
    expect((await one<{ n: number }>(`select count(*)::int as n from content_slots`)).n).toBe(4);
  });

  it("leaves the slots exactly as they were, pillar and format included", async () => {
    await configure(LONDON, { perWeek: 2, horizon: 14, pillars: [["A", 50], ["B", 50]] });
    await plan();
    const before = await all(`select id, pillar_id, format, scheduled_at from content_slots order by scheduled_at`);
    await plan();
    const after = await all(`select id, pillar_id, format, scheduled_at from content_slots order by scheduled_at`);
    expect(after).toEqual(before);
  });

  it("adds only the new days when the horizon moves on", async () => {
    await configure(LONDON, { perWeek: 2, horizon: 7 });
    expect((await plan()).created).toBe(2);
    // A week later, the same call plans the following week and nothing else.
    expect((await plan(LONDON, "2026-11-09 06:00+00")).created).toBe(2);
    expect((await one<{ n: number }>(`select count(*)::int as n from content_slots`)).n).toBe(4);
  });
});

describe("a window a person already took", () => {
  it("is left alone", async () => {
    await configure(LONDON, { perWeek: 2, horizon: 7 });
    // A person scheduled something in the Monday window already.
    await db.exec(`
      insert into scheduled_posts (client_id, platform, scheduled_at)
      values ('${LONDON}', 'instagram', (date '2026-11-02' + time '09:00') at time zone 'Europe/London')`);
    const result = await plan();
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    const rows = await all<{ local: string }>(
      `select to_char(scheduled_at at time zone 'Europe/London', 'Dy') as local from content_slots`,
    );
    expect(rows.map((r) => r.local)).toEqual(["Wed"]);
  });
});

describe("the timezone", () => {
  it("puts a London window at London's nine o'clock", async () => {
    await configure(LONDON, { perWeek: 1, windows: [[1, "09:00"]], horizon: 7 });
    await plan();
    const { utc } = await one<{ utc: string }>(
      `select to_char(scheduled_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc from content_slots`,
    );
    // 2 November is GMT, so nine local is nine UTC.
    expect(utc).toBe("2026-11-02 09:00");
  });

  it("puts an Auckland window at Auckland's nine o'clock, which is another day in UTC", async () => {
    await configure(AUCKLAND, { perWeek: 1, windows: [[1, "09:00"]], horizon: 7 });
    await plan(AUCKLAND);
    const row = await one<{ utc: string; local: string }>(`
      select to_char(scheduled_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc,
             to_char(scheduled_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD HH24:MI') as local
      from content_slots`);
    expect(row.local).toBe("2026-11-02 09:00");
    // NZDT is UTC+13 in November, so it is the previous evening in UTC.
    expect(row.utc).toBe("2026-11-01 20:00");
  });

  it("keeps nine o'clock across a clock change rather than drifting an hour", async () => {
    // 25 October 2026: the UK goes back to GMT. A horizon spanning it must
    // still land on 09:00 local on both sides.
    await configure(LONDON, { perWeek: 2, windows: [[4, "09:00"], [6, "09:00"]], horizon: 14 });
    await plan(LONDON, "2026-10-19 06:00+00");
    const rows = await all<{ local: string; utc: string }>(`
      select to_char(scheduled_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI') as local,
             to_char(scheduled_at at time zone 'UTC', 'HH24:MI') as utc
      from content_slots order by scheduled_at`);
    expect(rows.every((r) => r.local.endsWith("09:00"))).toBe(true);
    // Before the change 09:00 BST is 08:00 UTC; after it, 09:00 GMT is 09:00 UTC.
    expect(rows[0]!.utc).toBe("08:00");
    expect(rows[rows.length - 1]!.utc).toBe("09:00");
  });
});

describe("the mix", () => {
  it("spreads pillars towards their shares over a horizon", async () => {
    await configure(LONDON, {
      perWeek: 5,
      windows: [[1, "09:00"], [2, "09:00"], [3, "09:00"], [4, "09:00"], [5, "09:00"]],
      horizon: 56, // eight weeks, forty slots
      pillars: [["Big", 60], ["Small", 40]],
    });
    await plan();
    const rows = await all<{ name: string; n: number }>(`
      select p.name, count(*)::int as n from content_slots s
      join client_content_pillars p on p.id = s.pillar_id
      group by p.name order by p.name`);
    const counts = Object.fromEntries(rows.map((r) => [r.name, r.n]));
    const total = counts.Big! + counts.Small!;
    expect(total).toBe(40);
    // 60/40, within the rounding a hundred-entry sequence allows.
    expect(counts.Big! / total).toBeGreaterThan(0.5);
    expect(counts.Big! / total).toBeLessThan(0.7);
    expect(counts.Small).toBeGreaterThan(0);
  });

  it("interleaves rather than running one pillar out before starting the next", async () => {
    await configure(LONDON, {
      perWeek: 5,
      windows: [[1, "09:00"], [2, "09:00"], [3, "09:00"], [4, "09:00"], [5, "09:00"]],
      horizon: 14,
      pillars: [["A", 50], ["B", 50]],
    });
    await plan();
    const rows = await all<{ name: string }>(`
      select p.name from content_slots s join client_content_pillars p on p.id = s.pillar_id
      order by s.scheduled_at`);
    const names = rows.map((r) => r.name);
    // Ten slots, two pillars: a block layout would give five As then five Bs.
    expect(new Set(names.slice(0, 4)).size).toBe(2);
  });

  it("follows the format mix it was given", async () => {
    await configure(LONDON, {
      perWeek: 5,
      windows: [[1, "09:00"], [2, "09:00"], [3, "09:00"], [4, "09:00"], [5, "09:00"]],
      horizon: 14,
      formatMix: '{"reel": 100}',
    });
    await plan();
    const rows = await all<{ format: string }>(`select distinct format from content_slots`);
    expect(rows).toEqual([{ format: "reel" }]);
  });

  it("refuses to plan for a client whose pillars all have no share", async () => {
    await configure(LONDON, { pillars: [["Nothing", 0]] });
    await expect(plan()).rejects.toThrow(/no active pillar with a share/);
  });

  it("carries on through the sequence when the horizon is extended", async () => {
    // A second run must not restart the mix at the first pillar, or the
    // first pillar gets over-represented every time the horizon moves.
    await configure(LONDON, { perWeek: 2, horizon: 7, pillars: [["A", 50], ["B", 50]] });
    await plan();
    await plan(LONDON, "2026-11-09 06:00+00");
    const rows = await all<{ name: string }>(`
      select p.name from content_slots s join client_content_pillars p on p.id = s.pillar_id
      order by s.scheduled_at`);
    const names = rows.map((r) => r.name);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(2);
  });
});

describe("weighted_sequence", () => {
  it("is about a hundred entries, proportioned by weight", async () => {
    const { seq } = await one<{ seq: string[] }>(
      `select weighted_sequence('{"a": 75, "b": 25}'::jsonb) as seq`,
    );
    expect(seq.length).toBeGreaterThan(90);
    const a = seq.filter((s) => s === "a").length;
    expect(a / seq.length).toBeGreaterThan(0.7);
    expect(a / seq.length).toBeLessThan(0.8);
  });

  it("holds the proportion in a short prefix, not only over the whole cycle", async () => {
    // The part that matters. A horizon consumes tens of slots, not a hundred,
    // so a sequence that is only correct when read to the end is wrong where
    // it is actually used. Ordering by repeat count alternated perfectly and
    // then emitted the surplus in a block: the first forty of a 60/40 mix
    // came out 50/50.
    const { seq } = await one<{ seq: string[] }>(
      `select weighted_sequence('{"big": 60, "small": 40}'::jsonb) as seq`,
    );
    for (const prefix of [10, 20, 40]) {
      const big = seq.slice(0, prefix).filter((s) => s === "big").length;
      expect(big / prefix, `first ${prefix} entries`).toBeGreaterThan(0.5);
      expect(big / prefix, `first ${prefix} entries`).toBeLessThan(0.7);
    }
  });

  it("gives the same answer every time, which is the whole point", async () => {
    const first = await one<{ seq: string[] }>(`select weighted_sequence('{"a": 60, "b": 40}'::jsonb) as seq`);
    const second = await one<{ seq: string[] }>(`select weighted_sequence('{"a": 60, "b": 40}'::jsonb) as seq`);
    expect(second.seq).toEqual(first.seq);
  });

  it("ignores a weight of zero and a value that is not a number", async () => {
    const { seq } = await one<{ seq: string[] }>(
      `select weighted_sequence('{"a": 100, "b": 0, "c": "lots"}'::jsonb) as seq`,
    );
    expect(new Set(seq)).toEqual(new Set(["a"]));
  });

  it("returns nothing for an empty mix rather than failing", async () => {
    expect((await one<{ seq: string[] }>(`select weighted_sequence('{}'::jsonb) as seq`)).seq).toEqual([]);
  });
});

describe("preview_slots", () => {
  it("shows the week without planning anything", async () => {
    await configure(LONDON, { perWeek: 2, horizon: 14 });
    const rows = await all(`select * from preview_slots('${LONDON}', 7, timestamptz '${MONDAY}')`);
    expect(rows).toHaveLength(2);
    expect((await one<{ n: number }>(`select count(*)::int as n from content_slots`)).n).toBe(0);
  });

  it("works for a client whose engine is off, unlike the planner", async () => {
    await configure(LONDON, { perWeek: 2 });
    await db.exec(`select set_engine_enabled('${LONDON}', false)`);
    const rows = await all(`select * from preview_slots('${LONDON}', 7, timestamptz '${MONDAY}')`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("marks a window that is already taken", async () => {
    await configure(LONDON, { perWeek: 2, horizon: 7 });
    await plan();
    const rows = await all<{ taken: boolean }>(
      `select taken from preview_slots('${LONDON}', 7, timestamptz '${MONDAY}')`,
    );
    expect(rows.every((r) => r.taken)).toBe(true);
  });

  it("says the local time, since that is the one a person chose", async () => {
    await configure(AUCKLAND, { perWeek: 1, windows: [[1, "09:00"]], horizon: 7 });
    const rows = await all<{ local_time: string }>(
      `select local_time from preview_slots('${AUCKLAND}', 7, timestamptz '${MONDAY}')`,
    );
    expect(rows[0]!.local_time).toMatch(/Mon 02 Nov 09:00/);
  });
});
