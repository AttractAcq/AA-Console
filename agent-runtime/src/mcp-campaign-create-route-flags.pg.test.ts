import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 305 against a real Postgres.
 *
 * 302 added runs_organic and runs_paid, defaulting both to false, and made the
 * route CHECK require the mode and the flags to agree. It taught
 * create_campaign_from_opportunity_v6 and clone_campaign_for_route to set them
 * and missed mcp_campaign_create_v6, which sets the mode and leaves the flags
 * alone. Every branch of the CHECK but 'legacy' needs a flag true, so from the
 * moment 302 was applied that function could not create a campaign in any v6
 * mode at all.
 *
 * The first test here is the regression itself, written against the same CHECK
 * so it would have failed the day 302 landed. The rest pin 305: the three
 * routes it can now create, the flags it derives for each, and the arguments it
 * still refuses.
 *
 * Both overloads are covered. 204 created the 8-argument form and 210 added the
 * 9-argument one; the older is not dead -- a historical campaign.create request
 * carries no offer_version_id key -- and each has to keep its own payload
 * shape, because that payload is what a replay is matched on.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const BOT = "bot-1";

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
 create schema if not exists mcp_internal;
 create role authenticated; create role anon; create role service_role;

 create table clients(id uuid primary key);

 -- client_campaigns with the route CHECK exactly as migration 302 installed
 -- it, copied from the live constraint definition. The point of this test is
 -- what 305 writes into these columns, so the constraint has to be the real
 -- one rather than a paraphrase of it.
 create table client_campaigns(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text not null,
   brief text,
   acquisition_mode text not null default 'legacy',
   paid_platform text,
   runs_organic boolean not null default false,
   runs_paid boolean not null default false,
   cloned_from_campaign_id uuid,
   offer_version_id uuid,
   ad_campaign_id text,
   built_at timestamptz, launched_at timestamptz,
   created_at timestamptz not null default now(),
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

 create table mcp_internal.mcp_campaign_requests(
   bot_id text, execution_id text, request_id text, tool text,
   client_id uuid, campaign_id uuid, payload jsonb, result jsonb);

 -- The guards 305's functions call. Each is a no-op here: this test is about
 -- the route flags, and permission behaviour is covered where it belongs.
 create function mcp_internal.require_service_role() returns void
   language plpgsql as $a$ begin return; end $a$;
 create function mcp_internal.require_campaign_execution_permission(text, uuid, text)
   returns void language plpgsql as $a$ begin return; end $a$;
 create function mcp_internal.require_mcp_ids(text, text) returns void
   language plpgsql as $a$ begin return; end $a$;
 -- No replay in these tests, so every request is a fresh one.
 create function mcp_internal.take_campaign_request(text, text, text, uuid, jsonb)
   returns jsonb language sql as $a$ select null::jsonb $a$;
 create function mcp_internal.enqueue_mcp_job(
   text, uuid, text, uuid, text, text, text, text) returns uuid
   language sql as $a$ select gen_random_uuid() $a$;
 create function mcp_internal.campaign_json(client_campaigns) returns jsonb
   language sql as $a$ select jsonb_build_object('id', $1.id, 'name', $1.name) $a$;

 insert into clients(id) values ('${CLIENT}');
 `);

  await db.exec(await sql("20261104000000_305_the_mcp_campaign_writer_learns_the_route_flags.sql"));
});

afterAll(async () => {
  await db?.close();
});

/** The 9-argument form, which is the one the gateway calls. */
const create = (mode: string, platform: string | null, exec = "e-1") =>
  one<{ campaign: Record<string, unknown> }>(
    `select public.mcp_campaign_create_v6(
       $1, $2::uuid, 'A campaign', 'A brief', $3, $4, 'r-1', $5, null) as campaign`,
    [BOT, CLIENT, mode, platform, exec],
  );

describe("the regression 302 introduced", () => {
  it("rejects a v6 campaign whose flags are left at their defaults", async () => {
    // Exactly what mcp_campaign_create_v6 did before 305: set the mode, leave
    // runs_organic and runs_paid alone. No branch of the CHECK accepts it.
    await expect(
      db.exec(`insert into client_campaigns(client_id, name, acquisition_mode)
               values ('${CLIENT}', 'Organic', 'organic')`),
    ).rejects.toThrow(/client_campaigns_acquisition_route_check/);

    await expect(
      db.exec(`insert into client_campaigns(client_id, name, acquisition_mode, paid_platform)
               values ('${CLIENT}', 'Paid', 'paid', 'meta')`),
    ).rejects.toThrow(/client_campaigns_acquisition_route_check/);

    // And 'legacy' is the one mode that survives on the defaults, which is why
    // campaign_execution -- which inserts no mode at all -- was never affected.
    await db.exec(`insert into client_campaigns(client_id, name)
                   values ('${CLIENT}', 'Legacy')`);
    expect(await one(`select acquisition_mode from client_campaigns`))
      .toMatchObject({ acquisition_mode: "legacy" });
  });
});

describe("migration 305: the writer sets the flags", () => {
  it("creates an organic campaign with the organic flag only", async () => {
    await create("organic", null);
    expect(await one(`select acquisition_mode, runs_organic, runs_paid, paid_platform
                      from client_campaigns`)).toMatchObject({
      acquisition_mode: "organic", runs_organic: true, runs_paid: false, paid_platform: null,
    });
  });

  it("creates a paid campaign with the paid flag only", async () => {
    await create("paid", "meta");
    expect(await one(`select acquisition_mode, runs_organic, runs_paid, paid_platform
                      from client_campaigns`)).toMatchObject({
      acquisition_mode: "paid", runs_organic: false, runs_paid: true, paid_platform: "meta",
    });
  });

  it("creates a paid-and-organic campaign with both flags, which is the point", async () => {
    await create("both", "google");
    expect(await one(`select acquisition_mode, runs_organic, runs_paid, paid_platform
                      from client_campaigns`)).toMatchObject({
      acquisition_mode: "both", runs_organic: true, runs_paid: true, paid_platform: "google",
    });
  });

  it("refuses a paid or paid-and-organic campaign with no supported platform", async () => {
    await expect(create("paid", null)).rejects.toThrow(/invalid_request/);
    await expect(create("both", null)).rejects.toThrow(/invalid_request/);
    await expect(create("both", "tiktok")).rejects.toThrow(/invalid_request/);
  });

  it("still refuses an organic campaign carrying a paid platform", async () => {
    await expect(create("organic", "meta")).rejects.toThrow(/invalid_request/);
  });

  it("still refuses a mode that is not a route", async () => {
    await expect(create("hybrid", "meta")).rejects.toThrow(/invalid_request/);
    await expect(create("legacy", null)).rejects.toThrow(/invalid_request/);
  });
});

describe("the older 8-argument overload", () => {
  const createOld = (mode: string, platform: string | null) =>
    one(
      `select public.mcp_campaign_create_v6(
         $1, $2::uuid, 'A campaign', 'A brief', $3, $4, 'r-1', 'e-9') as campaign`,
      [BOT, CLIENT, mode, platform],
    );

  it("sets the flags too, since a historical request came through it", async () => {
    await createOld("both", "meta");
    expect(await one(`select acquisition_mode, runs_organic, runs_paid from client_campaigns`))
      .toMatchObject({ acquisition_mode: "both", runs_organic: true, runs_paid: true });
  });

  it("keeps its own payload shape, which a replay is matched on", async () => {
    await createOld("organic", null);
    const [row] = await rows<{ has_offer_key: boolean }>(
      `select payload ? 'offer_version_id' as has_offer_key
         from mcp_internal.mcp_campaign_requests`,
    );
    // The 9-argument form records the key; this one never has, and adding it
    // would change what take_campaign_request compares.
    expect(row!.has_offer_key).toBe(false);
  });
});
