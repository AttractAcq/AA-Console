import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 302 against a real Postgres.
 *
 * Alex asked for a campaign that can be paid, organic, or both. The reason
 * that is not a loosened CHECK is that every organic guard relies on an
 * implication which a both-campaign breaks: if the campaign is organic then
 * every asset beneath it is organic. So the route moves down to the idea, and
 * the campaign only declares which routes it is allowed to run.
 *
 * These tests are mostly about what stays shut. The route columns are
 * fail-closed by design, and the guard rewrite is a separate migration, so the
 * property worth pinning here is that nothing already in the database changes
 * behaviour and that an idea can never claim a route its campaign does not run.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OPPORTUNITY = "22222222-2222-4222-8222-222222222222";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(query, params)).rows;
}
async function one<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(query, params))[0]!;
}

/** Insert a campaign directly, the way the planner eventually will. */
function campaign(mode: string, organic: boolean, paid: boolean, platform: string | null) {
  return db.query(
    `insert into client_campaigns
       (client_id, name, brief, acquisition_mode, runs_organic, runs_paid, paid_platform)
     values ($1, $2, 'A brief', $3, $4, $5, $6) returning id`,
    [CLIENT, `${mode} campaign`, mode, organic, paid, platform],
  );
}

beforeEach(async () => {
  await db?.close();
  db = new PGlite();

  await db.exec(`
 create schema if not exists auth;
 create role authenticated; create role anon; create role service_role;

 create table clients(id uuid primary key, name text not null default 'A client');

 -- Everything the 232 creator touches, stubbed just enough to apply and run.
 -- The route handling is what 302 changes; the status gate, readiness read,
 -- deduplication, offer lookup and link writes are preserved and exercised.
 create table market_opportunities(
   id uuid primary key,
   client_id uuid not null references clients(id) on delete cascade,
   name text not null default 'A micro-niche',
   status text not null default 'approved');
 create table opportunity_links(
   opportunity_id uuid not null,
   client_id uuid not null,
   role text not null,
   campaign_id uuid,
   offer_id uuid,
   unique (opportunity_id, role, campaign_id));
 create table opportunity_events(
   opportunity_id uuid not null, client_id uuid not null,
   event text not null, actor text not null, detail text);
 create table opportunity_readiness(
   opportunity_id uuid primary key, blocker text);
 create table service_offer_versions(
   id uuid primary key, offer_id uuid, client_id uuid, version integer not null default 1);
 create table service_offer_signoffs(
   offer_version_id uuid, client_id uuid);
 create function can_shape_opportunity(p uuid) returns boolean
   language sql stable as $s$ select true $s$;
 create function opportunity_brief_v6(p uuid) returns text
   language sql stable as $s$ select 'A generated brief' $s$;

 create table client_campaigns(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text not null,
   brief text not null,
   ideate_on_plan boolean not null default true,
   offer_version_id uuid,
   acquisition_mode text not null default 'legacy',
   paid_platform text,
   cloned_from_campaign_id uuid,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now(),
   unique (id, client_id));

 alter table client_campaigns
   add constraint client_campaigns_acquisition_route_check check (
     (acquisition_mode = 'paid' and paid_platform in ('meta','google')) or
     (acquisition_mode in ('legacy','organic') and paid_platform is null));

 create table client_ideas(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   campaign_id uuid references client_campaigns(id) on delete set null,
   title text not null default 'An idea');

 create function auth.uid() returns uuid language sql stable as $a$
   select '11111111-1111-4111-8111-111111111111'::uuid $a$;
 create function auth.role() returns text language sql stable as $a$
   select coalesce(current_setting('test.role', true), 'authenticated') $a$;
 create function is_admin() returns boolean language sql stable as $a$ select true $a$;
 create function can_access_client(p uuid) returns boolean language sql stable as $a$ select true $a$;
 create function lock_down_definer_functions() returns void language sql as $l$
   select null::void $l$;

 create function guard_campaign_acquisition_route()
 returns trigger language plpgsql set search_path = public as $g$
 begin
   if old.acquisition_mode is distinct from new.acquisition_mode then
     raise exception 'Campaign route and lineage are immutable. Clone this campaign into a new route.';
   end if;
   return new;
 end $g$;
 create trigger guard_campaign_acquisition_route_update
   before update on client_campaigns
   for each row execute function guard_campaign_acquisition_route();

 create function clone_campaign_for_route(uuid, text, text, text)
   returns uuid language sql as $c$ select null::uuid $c$;

 insert into clients(id) values('${CLIENT}');
 insert into market_opportunities(id, client_id) values('${OPPORTUNITY}', '${CLIENT}');
 insert into opportunity_readiness(opportunity_id) values('${OPPORTUNITY}');
 -- The twenty production campaigns are all legacy. Mirror one.
 insert into client_campaigns(client_id, name, brief) values('${CLIENT}', 'Legacy', 'A brief');
 insert into client_ideas(client_id) values('${CLIENT}');`);

  await db.exec(await sql("20261102000000_302_a_campaign_may_be_paid_organic_or_both.sql"));
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("what a campaign may now declare", () => {
  it("accepts organic and paid together, which was previously impossible", async () => {
    const row = await one<{ id: string }>(
      `${(await campaign("both", true, true, "meta")).rows ? "" : ""}select id from client_campaigns where acquisition_mode = 'both'`,
    );
    expect(row.id).toBeTruthy();
  });

  it("still accepts each route on its own", async () => {
    await campaign("organic", true, false, null);
    await campaign("paid", false, true, "google");
    const modes = await rows<{ acquisition_mode: string }>(
      "select acquisition_mode from client_campaigns order by acquisition_mode",
    );
    expect(modes.map((m) => m.acquisition_mode)).toEqual(["legacy", "organic", "paid"]);
  });

  it("refuses a mode that disagrees with its own flags", async () => {
    // The flags are the authority. A row claiming to be organic while running
    // nothing would make every guard's reading of it a lie.
    await expect(campaign("organic", false, false, null)).rejects.toThrow(
      /acquisition_route_check/,
    );
    await expect(campaign("both", true, false, "meta")).rejects.toThrow(/acquisition_route_check/);
  });

  it("refuses a paid route with no platform, and a platform with no paid route", async () => {
    // `paid_platform in (...)` is NULL, not false, when the column is null, and
    // a CHECK only rejects on false. The first draft of this constraint passed
    // a paid campaign with no platform for exactly that reason.
    await expect(campaign("both", true, true, null)).rejects.toThrow(/acquisition_route_check/);
    await expect(campaign("organic", true, false, "meta")).rejects.toThrow(
      /acquisition_route_check/,
    );
  });

  it("keeps the route immutable, so produced assets cannot change side", async () => {
    await campaign("organic", true, false, null);
    await expect(
      db.query("update client_campaigns set runs_paid = true where acquisition_mode = 'organic'"),
    ).rejects.toThrow(/immutable/);
  });

});

describe("the route on the idea", () => {
  it("is null for every idea that already existed, so nothing changes behaviour", async () => {
    const row = await one<{ unrouted: number }>(
      "select count(*)::int as unrouted from client_ideas where acquisition_route is null",
    );
    expect(row.unrouted).toBe(1);
  });

  it("lets one both-campaign hold ideas of each route at once", async () => {
    const c = await one<{ id: string }>(
      `insert into client_campaigns
         (client_id, name, brief, acquisition_mode, runs_organic, runs_paid, paid_platform)
       values ($1,'Both','A brief','both',true,true,'meta') returning id`,
      [CLIENT],
    );
    await db.query(
      "insert into client_ideas(client_id, campaign_id, acquisition_route) values($1,$2,'organic')",
      [CLIENT, c.id],
    );
    await db.query(
      "insert into client_ideas(client_id, campaign_id, acquisition_route) values($1,$2,'paid')",
      [CLIENT, c.id],
    );
    const got = await rows<{ acquisition_route: string }>(
      "select acquisition_route from client_ideas where campaign_id = $1 order by acquisition_route",
      [c.id],
    );
    expect(got.map((g) => g.acquisition_route)).toEqual(["organic", "paid"]);
  });

  it("refuses a route its campaign does not run", async () => {
    const c = await one<{ id: string }>(
      `insert into client_campaigns
         (client_id, name, brief, acquisition_mode, runs_organic, runs_paid)
       values ($1,'Organic only','A brief','organic',true,false) returning id`,
      [CLIENT],
    );
    await expect(
      db.query(
        "insert into client_ideas(client_id, campaign_id, acquisition_route) values($1,$2,'paid')",
        [CLIENT, c.id],
      ),
    ).rejects.toThrow(/does not run a paid route/);
  });

  it("refuses a paid idea with no campaign at all", async () => {
    // The client's constant organic stream is not campaign-bound. Nothing may
    // call itself paid without a campaign that runs paid.
    await expect(
      db.query("insert into client_ideas(client_id, acquisition_route) values($1,'paid')", [CLIENT]),
    ).rejects.toThrow(/may only be organic/);
  });

  it("allows an organic idea with no campaign, which is the constant stream", async () => {
    await db.query("insert into client_ideas(client_id, acquisition_route) values($1,'organic')", [
      CLIENT,
    ]);
    const row = await one<{ n: number }>(
      "select count(*)::int as n from client_ideas where acquisition_route = 'organic' and campaign_id is null",
    );
    expect(row.n).toBe(1);
  });

  it("refuses a route value that is neither organic nor paid", async () => {
    // Under a both-campaign, so the trigger's own checks pass and the column
    // CHECK is what has to refuse it. A BEFORE trigger runs first, so testing
    // this without a campaign would only re-test the trigger.
    const c = await one<{ id: string }>(
      `insert into client_campaigns
         (client_id, name, brief, acquisition_mode, runs_organic, runs_paid, paid_platform)
       values ($1,'Both','A brief','both',true,true,'meta') returning id`,
      [CLIENT],
    );
    await expect(
      db.query(
        "insert into client_ideas(client_id, campaign_id, acquisition_route) values($1,$2,'both')",
        [CLIENT, c.id],
      ),
    ).rejects.toThrow(/acquisition_route/);
  });
});

describe("creating a both-route campaign from an opportunity", () => {
  it("was unreachable before: the creator refused any mode but organic or paid", async () => {
    const row = await one<{
      acquisition_mode: string;
      runs_organic: boolean;
      runs_paid: boolean;
      paid_platform: string | null;
    }>("select * from create_campaign_from_opportunity_v6($1, 'both', 'meta')", [OPPORTUNITY]);
    expect(row.acquisition_mode).toBe("both");
    expect(row.runs_organic).toBe(true);
    expect(row.runs_paid).toBe(true);
    expect(row.paid_platform).toBe("meta");
  });

  it("still records the link in both directions", async () => {
    await db.query("select create_campaign_from_opportunity_v6($1, 'both', 'meta')", [OPPORTUNITY]);
    const link = await one<{ n: number }>(
      "select count(*)::int as n from opportunity_links where opportunity_id = $1 and role = 'campaign'",
      [OPPORTUNITY],
    );
    const event = await one<{ detail: string }>(
      "select detail from opportunity_events where opportunity_id = $1",
      [OPPORTUNITY],
    );
    expect(link.n).toBe(1);
    expect(event.detail).toContain("both meta");
  });

  it("treats both as its own combination, so it does not collide with an organic one", async () => {
    const organic = await one<{ id: string }>(
      "select id from create_campaign_from_opportunity_v6($1, 'organic')",
      [OPPORTUNITY],
    );
    const both = await one<{ id: string }>(
      "select id from create_campaign_from_opportunity_v6($1, 'both', 'google')",
      [OPPORTUNITY],
    );
    expect(both.id).not.toBe(organic.id);
  });

  it("returns the existing campaign rather than a duplicate for the same combination", async () => {
    const first = await one<{ id: string }>(
      "select id from create_campaign_from_opportunity_v6($1, 'both', 'meta')",
      [OPPORTUNITY],
    );
    const again = await one<{ id: string }>(
      "select id from create_campaign_from_opportunity_v6($1, 'both', 'meta')",
      [OPPORTUNITY],
    );
    expect(again.id).toBe(first.id);
  });

  it("still refuses a both route with no paid platform", async () => {
    await expect(
      db.query("select create_campaign_from_opportunity_v6($1, 'both')", [OPPORTUNITY]),
    ).rejects.toThrow(/Meta Ads or Google Ads/);
  });

  it("still refuses an opportunity that is not approved", async () => {
    await db.query("update market_opportunities set status = 'draft' where id = $1", [OPPORTUNITY]);
    await expect(
      db.query("select create_campaign_from_opportunity_v6($1, 'both', 'meta')", [OPPORTUNITY]),
    ).rejects.toThrow(/Approve it before building a campaign/);
  });

  it("still refuses when readiness reports a blocker", async () => {
    await db.query("update opportunity_readiness set blocker = 'No proof for this claim.' where opportunity_id = $1", [
      OPPORTUNITY,
    ]);
    await expect(
      db.query("select create_campaign_from_opportunity_v6($1, 'both', 'meta')", [OPPORTUNITY]),
    ).rejects.toThrow(/No proof for this claim/);
  });
});
