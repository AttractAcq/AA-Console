import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 308 against a real Postgres.
 *
 * content_count is one number. For a campaign on a single route that is the
 * answer; for the 'both' route migration 302 added, it says nothing about the
 * split, so "twelve pieces" could mean twelve organic and no ads and readiness
 * could not tell the difference.
 *
 * What is worth pinning is mostly the refusals, and that they refuse per ROUTE
 * rather than only checking the total: a campaign that does not run paid cannot
 * plan paid pieces, and a both-route campaign planning nothing for one of its
 * routes is not running both whatever its flags say.
 *
 * And that legacy is exempt. Every one of the 20 live campaigns is legacy with
 * content_count between 9 and 28, so a constraint describing them by a route
 * split would be a migration that cannot be applied.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

/** A campaign on a given route, with a planned volume. */
async function campaign(
  id: string,
  mode: string,
  contentCount: number,
  platform: string | null = null,
) {
  await db.query(
    `insert into client_campaigns
       (id, client_id, name, acquisition_mode, paid_platform, runs_organic, runs_paid, content_count)
     values ($1, $2, 'A campaign', $3, $4, $5, $6, $7)`,
    [id, CLIENT, mode, platform,
     mode === "organic" || mode === "both", mode === "paid" || mode === "both", contentCount],
  );
}

/** A distinct campaign id per case. Padded: the first segment is eight hex
 *  characters, and an unpadded two-digit n makes nine. */
const C = (n: number) => `333333${String(n).padStart(2, "0")}-3333-4333-8333-333333333333`;

beforeEach(async () => {
  await db?.close();
  db = new PGlite();

  await db.exec(`
 create schema if not exists auth;
 create role authenticated; create role anon; create role service_role;

 create table clients(id uuid primary key);
 -- The route CHECK as 302 installed it, so the fixtures this test builds are
 -- the ones the live table would accept.
 create table client_campaigns(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text not null,
   acquisition_mode text not null default 'legacy',
   paid_platform text,
   runs_organic boolean not null default false,
   runs_paid boolean not null default false,
   content_count integer not null default 0,
   updated_at timestamptz not null default now(),
   constraint client_campaigns_acquisition_route_check check (
     (acquisition_mode = 'legacy' and not runs_organic and not runs_paid
        and paid_platform is null) or
     (acquisition_mode = 'organic' and runs_organic and not runs_paid
        and paid_platform is null) or
     (acquisition_mode = 'paid' and runs_paid and not runs_organic
        and paid_platform is not null and paid_platform in ('meta','google')) or
     (acquisition_mode = 'both' and runs_organic and runs_paid
        and paid_platform is not null and paid_platform in ('meta','google'))));

 create function auth.role() returns text language sql stable as $a$
   select coalesce(nullif(current_setting('test.role', true), ''), 'service_role') $a$;
 create function can_access_client(p uuid) returns boolean language sql stable as $a$
   select p = '${CLIENT}'::uuid $a$;
 create function lock_down_definer_functions() returns void language plpgsql as $a$
   begin return; end $a$;

 insert into clients(id) values ('${CLIENT}'), ('${OTHER}');
 -- A legacy campaign with real volume, exactly as production has 20 of.
 insert into client_campaigns(id, client_id, name, content_count)
   values ('44444444-4444-4444-8444-444444444444', '${CLIENT}', 'Legacy', 14);
 `);

  await db.exec(await sql("20261105000000_308_a_both_campaign_plans_each_route_s_volume.sql"));
});

afterAll(async () => {
  await db?.close();
});

const setVolumes = (id: string, organic: number, paid: number) =>
  db.query(`select set_campaign_route_volumes_v6($1, $2, $3)`, [id, organic, paid]);

describe("the constraint does not invalidate what is already there", () => {
  it("applies to a table of legacy campaigns with real volumes", async () => {
    // The migration already ran in beforeEach against a legacy row with
    // content_count 14. If the constraint described legacy campaigns by a
    // route split, that would have thrown.
    expect(await one(`select content_count, organic_content_count, paid_content_count
                        from client_campaigns where name = 'Legacy'`))
      .toMatchObject({ content_count: 14, organic_content_count: 0, paid_content_count: 0 });
  });

  it("refuses to split a legacy campaign, which has no routes to split between", async () => {
    await expect(setVolumes("44444444-4444-4444-8444-444444444444", 7, 7))
      .rejects.toThrow(/no route split to set/);
  });
});

describe("a single-route campaign", () => {
  it("puts the whole volume on the route it runs", async () => {
    await campaign(C(1), "organic", 8);
    await setVolumes(C(1), 8, 0);
    expect(await one(`select organic_content_count, paid_content_count
                        from client_campaigns where id = $1`, [C(1)]))
      .toMatchObject({ organic_content_count: 8, paid_content_count: 0 });
  });

  it("cannot plan pieces on a route it does not run", async () => {
    await campaign(C(2), "organic", 8);
    await expect(setVolumes(C(2), 5, 3))
      .rejects.toThrow(/does not run paid/);
    await campaign(C(3), "paid", 8, "meta");
    await expect(setVolumes(C(3), 3, 5))
      .rejects.toThrow(/does not run organic/);
  });
});

describe("a paid-and-organic campaign", () => {
  it("records a split that adds up", async () => {
    await campaign(C(4), "both", 12, "meta");
    await setVolumes(C(4), 8, 4);
    expect(await one(`select organic_content_count, paid_content_count
                        from client_campaigns where id = $1`, [C(4)]))
      .toMatchObject({ organic_content_count: 8, paid_content_count: 4 });
  });

  it("refuses a split that does not add up, naming the numbers", async () => {
    await campaign(C(5), "both", 12, "meta");
    await expect(setVolumes(C(5), 8, 2))
      .rejects.toThrow(/8 organic plus 2 paid, which is 10, but this campaign plans 12/);
  });

  it("refuses a split with nothing on one route", async () => {
    // Running both routes with nothing on one is not running both.
    await campaign(C(6), "both", 12, "meta");
    await expect(setVolumes(C(6), 12, 0)).rejects.toThrow(/needs pieces on both routes/);
    await expect(setVolumes(C(6), 0, 12)).rejects.toThrow(/needs pieces on both routes/);
  });

  it("is allowed to sit planned-but-unsplit, which is the state between two writes", async () => {
    // The planner sets content_count, then the split. An equality constraint
    // would reject the first of those two statements, and CHECKs cannot be
    // deferred -- so a short split is permitted by the constraint and refused
    // by the function. A test caught this; the first version of 308 could not
    // have saved a plan at all.
    await campaign(C(7), "both", 12, "meta");
    await db.query(
      `update client_campaigns set organic_content_count = 8, paid_content_count = 2 where id = $1`,
      [C(7)],
    );
    expect(await one(`select organic_content_count, paid_content_count
                        from client_campaigns where id = $1`, [C(7)]))
      .toMatchObject({ organic_content_count: 8, paid_content_count: 2 });
  });

  it("is refused by the constraint when the split exceeds the plan", async () => {
    // Defence in depth on what is never acceptable at any instant: the
    // function is not the only thing that can write these columns.
    await campaign(C(10), "both", 12, "meta");
    await expect(db.query(
      `update client_campaigns set organic_content_count = 8, paid_content_count = 6 where id = $1`,
      [C(10)],
    )).rejects.toThrow(/client_campaigns_route_volume_check/);
  });

  it("is refused by the constraint for pieces on a route it does not run", async () => {
    await campaign(C(11), "organic", 8);
    await expect(db.query(
      `update client_campaigns set paid_content_count = 1 where id = $1`, [C(11)],
    )).rejects.toThrow(/client_campaigns_route_volume_check/);
  });
});

describe("what it refuses outright", () => {
  it("refuses a negative or missing count", async () => {
    await campaign(C(8), "both", 12, "meta");
    await expect(setVolumes(C(8), -1, 13)).rejects.toThrow(/whole number of pieces/);
    await expect(db.query(`select set_campaign_route_volumes_v6($1, null, 12)`, [C(8)]))
      .rejects.toThrow(/whole number of pieces/);
  });

  it("refuses a campaign that does not exist", async () => {
    await expect(setVolumes("55555555-5555-4555-8555-555555555555", 1, 1))
      .rejects.toThrow(/No such campaign/);
  });

  it("refuses an authenticated caller with no access to the client", async () => {
    await campaign(C(9), "both", 12, "meta");
    await db.exec(`update client_campaigns set client_id = '${OTHER}' where id = '${C(9)}'`);
    await db.exec(`set test.role = 'authenticated'`);
    await expect(setVolumes(C(9), 8, 4)).rejects.toThrow(/Not permitted for this client/);
  });
});
