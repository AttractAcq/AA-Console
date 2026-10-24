import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 243 against a real Postgres.
 *
 * The sheet is the half of Google Ads that can be proven without an account,
 * so what matters is that it stays a sheet: immutable once written, one
 * version per genuinely different plan, and `google_ad_build` still saying it
 * has no executor. A module that quietly became able to spend money would be
 * the one failure here that costs anything.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "66666666-6666-4666-8666-666666666666";
const ORGANIC = "66666666-6666-4666-8666-666666666667";
const MANIFEST = "77777777-7777-4777-8777-777777777777";
const PAGE = "88888888-8888-4888-8888-888888888888";
const MANAGER = "55555555-5555-4555-8555-555555555555";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}
const asService = () => db.exec("set test.role = 'service_role'");
const asHuman = () => db.exec("set test.role = 'authenticated'");

async function record(derived: Record<string, unknown>, missing: string[] = ["keyword_research"]) {
  await asService();
  const row = await one<{ record_google_ads_sheet_v6: string }>(
    "select record_google_ads_sheet_v6($1,$2,$3)",
    [CAMPAIGN, JSON.stringify(derived), missing],
  );
  await asHuman();
  return row.record_google_ads_sheet_v6;
}

async function blocker(campaign = CAMPAIGN): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from google_ads_sheet_due where campaign_id = $1",
    [campaign],
  );
  return row?.blocker ?? null;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth; create schema cron;
 create function auth.role() returns text language sql as $$select coalesce(current_setting('test.role',true),'authenticated')$$;
 create function auth.uid() returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function is_admin() returns boolean language sql as $$select true$$;
 create function active_video_approval_manager(uuid) returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function can_access_client(uuid) returns boolean language sql as $$select true$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin return new; end$$;

 create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
 create function cron.schedule(a text,b text,c text) returns bigint language sql as
   $$ insert into cron.job (jobname,schedule,command) values (a,b,c) returning jobid $$;
 create function cron.unschedule(a text) returns boolean language sql as
   $$ delete from cron.job where jobname=a returning true $$;

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_integrations(client_id uuid, provider text, credential_label text, ad_account_id text);
 create table client_content_pillars(id uuid primary key, client_id uuid, name text);
 create table client_pages(id uuid primary key, client_id uuid);
 create table client_media_assets(id uuid primary key, client_id uuid, review_status text,
   human_approved_at timestamptz);
 create table campaign_artifacts(campaign_id uuid, client_id uuid, kind text,
   asset_id uuid, page_id uuid);
 create table client_campaigns(id uuid primary key, client_id uuid, name text,
   objective text, audience text, template text, daily_budget numeric,
   target_countries text[] not null default '{}', conversion_event text,
   offer_version_id uuid, acquisition_mode text not null default 'legacy',
   paid_platform text, archived_at timestamptz, unique (id, client_id));
 create table campaign_content_pillars(campaign_id uuid, pillar_id uuid,
   primary key (campaign_id, pillar_id));
 create table agents(agent_key text primary key, name text not null, initials text not null,
   domain text, description text, requires_upstream text[] not null default '{}',
   config jsonb not null default '{}'::jsonb, paused boolean not null default false,
   updated_at timestamptz not null default now());
 create table agent_jobs(id uuid primary key default gen_random_uuid(),
   agent_key text not null references agents(agent_key), client_id uuid,
   status text not null default 'queued', params jsonb);
 create table client_engine_settings(client_id uuid primary key references clients(id) on delete cascade,
   enabled boolean not null default false);
 create table campaign_manifest_versions(
   id uuid primary key, campaign_id uuid not null, client_id uuid not null,
   version integer not null check (version > 0),
   acquisition_mode text not null check (acquisition_mode in ('organic','paid')),
   paid_platform text, plan_hash text not null,
   unique (campaign_id, version), unique (id, client_id));

 insert into clients values('${CLIENT}');
 insert into profiles values('${MANAGER}');
 insert into client_integrations values('${CLIENT}','google','123-456-7890',null);
 insert into client_pages values('${PAGE}','${CLIENT}');
 insert into client_campaigns(id, client_id, name, objective, daily_budget,
   target_countries, conversion_event, acquisition_mode, paid_platform)
   values('${CAMPAIGN}','${CLIENT}','Winter garage push','Book surveys', 40,
     array['Portsmouth'], 'survey_booked', 'paid', 'google');
 insert into client_campaigns(id, client_id, name, acquisition_mode)
   values('${ORGANIC}','${CLIENT}','Organic push','organic');
 insert into campaign_artifacts values('${CAMPAIGN}','${CLIENT}','landing_page',null,'${PAGE}');
 insert into campaign_manifest_versions values
   ('${MANIFEST}','${CAMPAIGN}','${CLIENT}',1,'paid','google',repeat('f',32));`);

  await db.exec(await sql("20261015230000_206_v6_action_approvals.sql"));
  await db.exec(await sql("20261022090000_230_campaign_action_executor.sql"));
  await db.exec(await sql("20261024170000_243_google_ads_build_sheet.sql"));
  await asHuman();
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("Google Ads still cannot spend anything", () => {
  it("leaves google_ad_build unsupported, and says why in the row", async () => {
    const row = await one<{ supported: boolean; note: string }>(
      "select supported, note from campaign_action_executors where action_key = 'google_ad_build'",
    );
    // The whole point of the module as shipped: a sheet, not an executor.
    expect(row.supported).toBe(false);
    expect(row.note).toContain("No Google Ads adapter exists");
    expect(row.note).toContain("build sheet");
  });

  it("registers an agent that holds no credential", async () => {
    const agent = await one<{ description: string }>(
      "select description from agents where agent_key = 'google_ads_sheet'",
    );
    expect(agent.description).toContain("Calls Google never");
  });
});

describe("the sheet itself", () => {
  it("records a version, and is immutable afterwards", async () => {
    const id = await record({ campaign: { name: "Winter garage push" } });
    const sheet = await one<{ version: number; plan_hash: string }>(
      "select version, plan_hash from google_ads_build_sheets where id = $1",
      [id],
    );
    expect(sheet.version).toBe(1);
    expect(sheet.plan_hash).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      db.query("update google_ads_build_sheets set missing = '{}' where id = $1", [id]),
    ).rejects.toThrow("immutable");
  });

  it("does not make a second version of the same plan", async () => {
    const first = await record({ campaign: { name: "Winter garage push" } });
    // Pressing the button again because nothing looked like it happened
    // should not produce a v2 identical to v1.
    const again = await record({ campaign: { name: "Winter garage push" } });
    expect(again).toBe(first);
    expect(await rows("select 1 from google_ads_build_sheets")).toHaveLength(1);
  });

  it("does make one when the plan genuinely changed", async () => {
    await record({ campaign: { name: "Winter garage push", daily_budget: 40 } });
    await record({ campaign: { name: "Winter garage push", daily_budget: 60 } });
    const versions = (
      await rows<{ version: number }>("select version from google_ads_build_sheets order by version")
    ).map((r) => r.version);
    expect(versions).toEqual([1, 2]);
  });

  it("keeps what it does not know, rather than an empty list standing for both", async () => {
    await record({ campaign: {} }, ["keyword_research", "approved_ad_copy"]);
    const sheet = await one<{ missing: string[] }>(
      "select missing from google_ads_build_sheets limit 1",
    );
    expect(sheet.missing).toEqual(["keyword_research", "approved_ad_copy"]);
  });

  it("refuses a campaign that is not paid Google, and anyone but the service", async () => {
    await asService();
    await expect(
      db.query("select record_google_ads_sheet_v6($1,$2,$3)", [ORGANIC, "{}", []]),
    ).rejects.toThrow("not a paid Google campaign");
    await asHuman();
    await expect(
      db.query("select record_google_ads_sheet_v6($1,$2,$3)", [CAMPAIGN, "{}", []]),
    ).rejects.toThrow("Only the internal service");
  });
});

describe("what a sheet needs first", () => {
  it("is ready when the campaign has budget, geography, a conversion action and a page", async () => {
    expect(await blocker()).toBeNull();
  });

  it("names each missing piece in the order somebody would fix it", async () => {
    await db.exec(`update client_campaigns set daily_budget = null where id = '${CAMPAIGN}'`);
    expect(await blocker()).toContain("No daily budget");

    await db.exec(`update client_campaigns set daily_budget = 40, target_countries = '{}' where id = '${CAMPAIGN}'`);
    // A search campaign without geography spends everywhere, which is the
    // expensive version of this mistake.
    expect(await blocker()).toContain("spends everywhere");

    await db.exec(`update client_campaigns set target_countries = array['Portsmouth'], conversion_event = null where id = '${CAMPAIGN}'`);
    expect(await blocker()).toContain("nothing to optimise towards");

    await db.exec(`update client_campaigns set conversion_event = 'survey_booked' where id = '${CAMPAIGN}'`);
    await db.exec(`delete from campaign_artifacts`);
    expect(await blocker()).toContain("point nowhere");
  });

  it("asks for a package before anything else", async () => {
    await db.exec("delete from campaign_manifest_versions");
    expect(await blocker()).toBe("No package yet. Plan the campaign first.");
  });

  it("says a sheet exists, and stops short of calling it live", async () => {
    await record({ campaign: { name: "Winter garage push" } });
    // As far as this module goes without an account, and the sentence says so.
    expect(await blocker()).toBe("Sheet v1 is ready for a hand build.");
  });

  it("leaves an organic campaign out of the board entirely", async () => {
    expect(
      await rows("select 1 from google_ads_sheet_due where campaign_id = $1", [ORGANIC]),
    ).toHaveLength(0);
  });

  it("reports the Google account when one is recorded", async () => {
    expect(
      await one<{ google_account: string }>(
        "select google_account from google_ads_sheet_due where campaign_id = $1",
        [CAMPAIGN],
      ),
    ).toMatchObject({ google_account: "123-456-7890" });
  });

  it("ends with the grant sweep", async () => {
    expect(await sql("20261024170000_243_google_ads_build_sheet.sql")).toContain(
      "select lock_down_definer_functions();",
    );
  });
});
