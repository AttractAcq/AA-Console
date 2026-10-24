import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 239 against a real Postgres.
 *
 * The thing being replaced is a blanket refusal that was correct: a v6 Meta
 * build was simply not allowed. So every test here is about what the gate
 * refuses in its place, because a paused ad object is still an external write
 * and Meta object creation is not idempotent.
 *
 *   nobody approved a build
 *   the account, budget, audience or creative set changed after the yes
 *   the package was superseded
 *   the client is not switched on
 *   objects already exist, so a second build would make a second campaign
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const CAMPAIGN = "66666666-6666-4666-8666-666666666666";
const MANIFEST = "77777777-7777-4777-8777-777777777777";
const ASSET = "88888888-8888-4888-8888-888888888888";

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

/** Ask for the build the way the runtime route does. */
async function ask(): Promise<string> {
  await asService();
  const row = await one<{ request_campaign_meta_build_v6: string }>(
    "select request_campaign_meta_build_v6($1,$2)",
    [CAMPAIGN, MANAGER],
  );
  await asHuman();
  return row.request_campaign_meta_build_v6;
}

async function approve(approvalId: string) {
  await db.query("select decide_campaign_action_approval_v6($1,'approved')", [approvalId]);
}

/** The gate the builder consults. Returns its refusal, or null. */
async function gate(): Promise<string | null> {
  await asService();
  try {
    await db.query("select assert_meta_build_allowed_v6($1)", [CAMPAIGN]);
    return null;
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    await asHuman();
  }
}

async function blocker(): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from meta_build_due where campaign_id = $1",
    [CAMPAIGN],
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

 -- The real column is this enum, not text. Stubbing it as text is how a
 -- coalesce against a string passed here and failed on production.
 create type campaign_template as enum ('lead_gen','traffic','awareness','conversions');

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_integrations(client_id uuid, provider text, ad_account_id text);
 create table client_media_assets(id uuid primary key, client_id uuid, review_status text,
   human_approved_at timestamptz);
 create table campaign_artifacts(campaign_id uuid, client_id uuid, kind text,
   asset_id uuid, page_id uuid);
 create table client_campaigns(id uuid primary key, client_id uuid, name text,
   objective text, audience text, template campaign_template, daily_budget numeric,
   target_countries text[] not null default '{}', conversion_event text,
   offer_version_id uuid, acquisition_mode text not null default 'legacy',
   paid_platform text, meta_campaign_id text, meta_ad_set_id text, meta_built_at timestamptz,
   archived_at timestamptz, unique (id, client_id));
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
 insert into client_integrations values('${CLIENT}','meta','act_1184772');
 insert into client_media_assets values('${ASSET}','${CLIENT}','approved', now());
 insert into client_campaigns(id, client_id, name, objective, audience, template,
   daily_budget, target_countries, conversion_event, acquisition_mode, paid_platform)
   values('${CAMPAIGN}','${CLIENT}','Winter garage push','Book surveys','Homeowners PO1',
     'lead_gen', 40, array['GB'], 'survey_booked', 'paid', 'meta');
 insert into campaign_artifacts values('${CAMPAIGN}','${CLIENT}','content','${ASSET}',null);
 insert into campaign_manifest_versions values
   ('${MANIFEST}','${CAMPAIGN}','${CLIENT}',1,'paid','meta',repeat('f',32));
 insert into client_engine_settings(client_id) values('${CLIENT}');`);

  await db.exec(await sql("20261015230000_206_v6_action_approvals.sql"));
  await db.exec(await sql("20261022090000_230_campaign_action_executor.sql"));
  await db.exec(await sql("20261024130000_239_a_meta_build_runs_on_an_approval.sql"));
  await db.exec("update client_engine_settings set campaign_actions_enabled = true;");
  await asHuman();
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("asking for a build", () => {
  it("refuses a campaign with no approved creative, at the ask", async () => {
    await db.exec("update client_media_assets set review_status = 'pending'");
    await asService();
    await expect(
      db.query("select request_campaign_meta_build_v6($1,$2)", [CAMPAIGN, MANAGER]),
    ).rejects.toThrow("No approved creative");
    await asHuman();
    expect(await blocker()).toBe("No approved creative is attached yet.");
  });

  it("refuses a client with no ad account", async () => {
    await db.exec("delete from client_integrations");
    await asService();
    await expect(
      db.query("select request_campaign_meta_build_v6($1,$2)", [CAMPAIGN, MANAGER]),
    ).rejects.toThrow("No Meta ad account");
    await asHuman();
  });

  it("refuses an organic campaign", async () => {
    await db.exec(
      `update client_campaigns set acquisition_mode = 'organic', paid_platform = null`,
    );
    await asService();
    await expect(
      db.query("select request_campaign_meta_build_v6($1,$2)", [CAMPAIGN, MANAGER]),
    ).rejects.toThrow("not a paid Meta campaign");
    await asHuman();
  });

  it("names the account, budget and creative count a person is agreeing to", async () => {
    const approval = await ask();
    const row = await one<{ destination: string; scope: Record<string, unknown> }>(
      "select destination, scope from campaign_action_approvals where id = $1",
      [approval],
    );
    expect(row.destination).toBe("meta:act_1184772");
    expect(row.scope).toMatchObject({
      ad_account: "act_1184772",
      daily_budget: 40,
      approved_creative: 1,
      creates: "paused objects only — activation is a separate approval",
    });
  });
});

describe("what the gate refuses", () => {
  it("a build nobody approved", async () => {
    expect(await gate()).toContain("No approved Meta build");
    expect(await blocker()).toBe("Nobody has approved a build for this campaign.");

    const approval = await ask();
    // Asked but not decided is still a refusal.
    expect(await gate()).toContain("No approved Meta build");
    expect(await blocker()).toBe("The build approval is pending.");
    void approval;
  });

  it("permits the build once a person has approved it", async () => {
    await approve(await ask());
    expect(await gate()).toBeNull();
    expect(await blocker()).toBeNull();
  });

  it("a budget raised after the yes", async () => {
    await approve(await ask());
    await db.exec("update client_campaigns set daily_budget = 400");
    // The money is the whole point of the gate.
    expect(await gate()).toContain("changed after it was approved");
    expect(await blocker()).toContain("changed after approval");
  });

  it("a creative added after the yes", async () => {
    await approve(await ask());
    await db.exec(`
      insert into client_media_assets values('99999999-9999-4999-8999-999999999999','${CLIENT}','approved', now());
      insert into campaign_artifacts values('${CAMPAIGN}','${CLIENT}','content','99999999-9999-4999-8999-999999999999',null);`);
    expect(await gate()).toContain("creative set is not what was signed off");
  });

  it("an audience changed after the yes", async () => {
    await approve(await ask());
    await db.exec("update client_campaigns set audience = 'Everyone in England'");
    expect(await gate()).toContain("changed after it was approved");
  });

  it("a superseded package", async () => {
    await approve(await ask());
    await db.exec(`insert into campaign_manifest_versions values
      (gen_random_uuid(),'${CAMPAIGN}','${CLIENT}',2,'paid','meta',repeat('e',32))`);
    expect(await gate()).toContain("superseded");
  });

  it("a client that is not switched on", async () => {
    await approve(await ask());
    await db.exec("update client_engine_settings set campaign_actions_enabled = false");
    expect(await gate()).toContain("off for this client");
    expect(await blocker()).toContain("off for this client");
  });

  it("a second build, because Meta object creation is not idempotent", async () => {
    await approve(await ask());
    await db.exec("update client_campaigns set meta_campaign_id = '23851000'");
    expect(await gate()).toContain("already has Meta objects");
    // And the board says built rather than live, because activation is its
    // own decision.
    expect(await blocker()).toBe("Built. Activation is a separate decision.");
  });

  it("a legacy campaign, which keeps its old path", async () => {
    await db.exec("update client_campaigns set acquisition_mode = 'legacy', paid_platform = null");
    expect(await gate()).toContain("legacy campaign does not use the approval gate");
  });

  it("anyone but the internal service", async () => {
    await expect(db.query("select assert_meta_build_allowed_v6($1)", [CAMPAIGN])).rejects.toThrow(
      "Only the internal service",
    );
  });
});

describe("activation stays its own decision", () => {
  it("supports the build and nothing further", async () => {
    const executors = await rows<{ action_key: string; supported: boolean }>(
      "select action_key, supported from campaign_action_executors where action_key in ('meta_ad_build','budget_change')",
    );
    expect(executors.find((e) => e.action_key === "meta_ad_build")?.supported).toBe(true);
    // Turning on somebody's ad spend is not a side effect of making the build
    // work.
    expect(executors.find((e) => e.action_key === "budget_change")?.supported).toBe(false);
  });

  it("ends with the grant sweep", async () => {
    expect(await sql("20261024130000_239_a_meta_build_runs_on_an_approval.sql")).toContain(
      "select lock_down_definer_functions();",
    );
  });
});
