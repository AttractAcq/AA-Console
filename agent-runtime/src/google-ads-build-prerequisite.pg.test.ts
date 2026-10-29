import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deriveSheet } from "./agents/google_ads_sheet/index.js";

/**
 * Migration 260 against PGlite, with its real approval, executor and sheet
 * predecessors. No Google Ads transport is involved.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "66666666-6666-4666-8666-666666666666";
const ORGANIC = "66666666-6666-4666-8666-666666666667";
const MANIFEST = "77777777-7777-4777-8777-777777777777";
const PAGE = "88888888-8888-4888-8888-888888888888";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const OTHER_CLIENT = "11111111-1111-4111-8111-111111111112";
const OTHER_CAMPAIGN = "66666666-6666-4666-8666-666666666668";
const WRONG_CAMPAIGN = "66666666-6666-4666-8666-666666666669";
const SECOND_CAMPAIGN = "66666666-6666-4666-8666-666666666670";
const SECOND_MANIFEST = "77777777-7777-4777-8777-777777777780";
const OTHER_MANIFEST = "77777777-7777-4777-8777-777777777781";
const ACTOR_TWO = "55555555-5555-4555-8555-555555555556";

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

async function record(
  derived: object,
  missing: string[] = ["keyword_research"],
  manifestId = MANIFEST,
) {
  await asService();
  const row = await one<{ record_google_ads_sheet_for_manifest_v6: string }>(
    "select record_google_ads_sheet_for_manifest_v6($1,$2,$3,$4)",
    [CAMPAIGN, manifestId, JSON.stringify(derived), missing],
  );
  await asHuman();
  return row.record_google_ads_sheet_for_manifest_v6;
}

async function blocker(campaign = CAMPAIGN): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from google_ads_build_due where campaign_id = $1",
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
 create function can_access_client(p_client uuid) returns boolean language sql as $$select p_client = '${CLIENT}'::uuid$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin return new; end$$;

 create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
 create function cron.schedule(a text,b text,c text) returns bigint language sql as
   $$ insert into cron.job (jobname,schedule,command) values (a,b,c) returning jobid $$;
 create function cron.unschedule(a text) returns boolean language sql as
   $$ delete from cron.job where jobname=a returning true $$;

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_integrations(id uuid primary key default gen_random_uuid(),
   client_id uuid, provider text, credential_label text, ad_account_id text,
   status text not null default 'connected');
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
   paid_platform text, archived_at timestamptz, ad_campaign_id uuid,
   unique (id, client_id));
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

 insert into clients values('${CLIENT}'),('${OTHER_CLIENT}');
 insert into profiles values('${MANAGER}');
 insert into client_integrations(client_id, provider, credential_label, ad_account_id)
   values('${CLIENT}','google','123-456-7890',null);
 insert into client_pages values('${PAGE}','${CLIENT}');
 insert into client_campaigns(id, client_id, name, objective, daily_budget,
   target_countries, conversion_event, acquisition_mode, paid_platform)
   values('${CAMPAIGN}','${CLIENT}','Winter garage push','Book surveys', 40,
     array['Portsmouth'], 'survey_booked', 'paid', 'google');
 insert into client_campaigns(id, client_id, name, acquisition_mode)
   values('${ORGANIC}','${CLIENT}','Organic push','organic');
 insert into client_campaigns(id, client_id, name, acquisition_mode, paid_platform)
   values('${OTHER_CAMPAIGN}','${OTHER_CLIENT}','Other client paid','paid','google');
 insert into campaign_artifacts values('${CAMPAIGN}','${CLIENT}','landing_page',null,'${PAGE}');
 insert into campaign_manifest_versions values
   ('${MANIFEST}','${CAMPAIGN}','${CLIENT}',1,'paid','google',repeat('f',32));`);

  await db.exec(await sql("20261015230000_206_v6_action_approvals.sql"));
  await db.exec(await sql("20261022090000_230_campaign_action_executor.sql"));
  await db.exec(await sql("20261024170000_243_google_ads_build_sheet.sql"));
  await asService();
  await db.query("select record_google_ads_sheet_v6($1,$2,$3)",
    [CAMPAIGN, JSON.stringify({ legacy: true }), ["keyword_research"]]);
  await db.exec(await sql("20261025235000_260_building_the_google_campaign.sql"));
  await asHuman();
}, 60000);

afterAll(async () => {
  await db?.close();
});

async function addCopy(headlines = ["A~B", "C", "D"]): Promise<string> {
  const copy = await one<{ id: string }>(
    `insert into google_ads_copy
       (client_id, campaign_id, headlines, descriptions, final_url, path1, path2)
     values ($1,$2,$3,array['Book a survey','Local specialists'],
             'https://example.test/garage','garage','survey') returning id`,
    [CLIENT, CAMPAIGN, headlines],
  );
  return copy.id;
}

async function addAccount(): Promise<string> {
  const integration = await one<{ id: string }>(
    `insert into client_integrations
       (client_id, provider, credential_label, status, google_ads_customer_id)
     values ($1,'google_ads','Test account','connected','1234567890') returning id`,
    [CLIENT],
  );
  return integration.id;
}

async function completeFixture(): Promise<void> {
  await record({ keyword_groups: [{ keywords: ["garage conversions portsmouth"], source: "research fixture" }] }, []);
  await addCopy();
  await addAccount();
  await db.query(
    "insert into client_engine_settings(client_id, campaign_actions_enabled) values ($1,true)",
    [CLIENT],
  );
}

async function request(actorId = MANAGER): Promise<string> {
  await asService();
  const row = await one<{ request_campaign_google_build_v6: string }>(
    "select request_campaign_google_build_v6($1,$2)",
    [CAMPAIGN, actorId],
  );
  return row.request_campaign_google_build_v6;
}

async function approveAndClaim(approvalId: string): Promise<string> {
  await db.query(
    `update campaign_action_approvals
        set status = 'approved', decided_at = now(), decided_by = $2
      where id = $1`,
    [approvalId, MANAGER],
  );
  const approval = await one<{
    client_id: string; campaign_id: string; action_key: string;
    artifact_version_hash: string; manifest_id: string;
  }>("select * from campaign_action_approvals where id = $1", [approvalId]);
  const execution = await one<{ id: string }>(
    `insert into campaign_action_executions
       (approval_id, client_id, campaign_id, action_key, artifact_version_hash,
        manifest_id, status, attempts, claimed_at, lease_until)
     values ($1,$2,$3,$4,$5,$6,'executing',1,now(),now()+interval '15 minutes') returning id`,
    [approvalId, approval.client_id, approval.campaign_id, approval.action_key,
      approval.artifact_version_hash, approval.manifest_id],
  );
  return execution.id;
}

describe("migration 260 remains a prerequisite", () => {
  it("blocks a legacy sheet with unknown package lineage and rejects old recording calls", async () => {
    const legacy = await one<{ manifest_id: string | null }>(
      "select manifest_id from google_ads_build_sheets where campaign_id=$1", [CAMPAIGN],
    );
    expect(legacy.manifest_id).toBeNull();
    expect(await blocker()).toContain("not bound to the current campaign package");
    await asService();
    await expect(db.query(
      "select request_campaign_google_build_v6($1,$2)", [CAMPAIGN, MANAGER],
    )).rejects.toThrow("no lineage to the current campaign package");
    await expect(db.query(
      "select record_google_ads_sheet_v6($1,$2,$3)",
      [CAMPAIGN, JSON.stringify({ stale: true }), ["keyword_research"]],
    )).rejects.toThrow("requires the manifest id captured before derivation");
    await expect(db.query(
      `insert into google_ads_build_sheets
         (campaign_id,client_id,version,derived,missing,plan_hash)
       values ($1,$2,2,'{}'::jsonb,'{}'::text[],repeat('a',64))`,
      [CAMPAIGN, CLIENT],
    )).rejects.toThrow(/check constraint/i);
  });

  it("binds new sheets to the captured latest manifest and rejects a superseded capture", async () => {
    const initial = await record({ keyword_groups: ["research fixture"] }, []);
    const first = await one<{ version: number; manifest_id: string; plan_hash: string }>(
      "select version, manifest_id, plan_hash from google_ads_build_sheets where id=$1", [initial],
    );
    expect(first).toMatchObject({ version: 2, manifest_id: MANIFEST });

    await db.query(
      `insert into client_campaigns(id,client_id,name,acquisition_mode,paid_platform)
       values ($1,$2,'Second campaign','paid','google')`,
      [SECOND_CAMPAIGN, CLIENT],
    );
    await expect(db.query(
      `insert into google_ads_build_sheets
         (campaign_id,client_id,manifest_id,version,derived,missing,plan_hash)
       values ($1,$2,$3,1,'{}'::jsonb,'{}'::text[],repeat('d',64))`,
      [SECOND_CAMPAIGN, CLIENT, MANIFEST],
    )).rejects.toThrow(/foreign key/i);

    await db.query(
      `insert into campaign_manifest_versions
         (id,campaign_id,client_id,version,acquisition_mode,paid_platform,plan_hash)
       values ($1,$2,$3,2,'paid','google',repeat('b',32))`,
      [SECOND_MANIFEST, CAMPAIGN, CLIENT],
    );
    await asService();
    await expect(db.query(
      "select record_google_ads_sheet_for_manifest_v6($1,$2,$3,$4)",
      [CAMPAIGN, MANIFEST, JSON.stringify({ keyword_groups: ["research fixture"] }), []],
    )).rejects.toThrow("package changed during sheet derivation");
    await expect(db.query(
      "select request_campaign_google_build_v6($1,$2)", [CAMPAIGN, MANAGER],
    )).rejects.toThrow("no lineage to the current campaign package");

    const next = await record({ keyword_groups: ["research fixture"] }, [], SECOND_MANIFEST);
    const second = await one<{ version: number; manifest_id: string; plan_hash: string }>(
      "select version, manifest_id, plan_hash from google_ads_build_sheets where id=$1", [next],
    );
    expect(second).toMatchObject({ version: 3, manifest_id: SECOND_MANIFEST });
    expect(second.plan_hash).not.toBe(first.plan_hash);
  });

  it("returns one exact approval when two actors request the same build", async () => {
    await completeFixture();
    await db.query("insert into profiles(id) values ($1)", [ACTOR_TWO]);
    await db.exec("update campaign_action_executors set supported=true where action_key='google_ad_build'");
    const first = await request(MANAGER);
    const second = await request(ACTOR_TWO);
    expect(second).toBe(first);
    const approvals = await rows<{ scope: Record<string, unknown> }>(
      "select scope from campaign_action_approvals where action_key='google_ad_build'",
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.scope).not.toHaveProperty("requested_by");
  });

  it("rejects null or overlong ad-copy elements before any build can use them", async () => {
    await expect(db.query(
      `insert into google_ads_copy
         (client_id,campaign_id,headlines,descriptions,final_url)
       values ($1,$2,array['A',null,'C'],array['One description','Another description'],
               'https://example.test/')`,
      [CLIENT, CAMPAIGN],
    )).rejects.toThrow(/check constraint/i);
    await expect(db.query(
      `insert into google_ads_copy
         (client_id,campaign_id,headlines,descriptions,final_url)
       values ($1,$2,array[repeat('H',31),'B','C'],
               array['One description','Another description'],'https://example.test/')`,
      [CLIENT, CAMPAIGN],
    )).rejects.toThrow(/check constraint/i);
  });

  it("keeps the action unsupported and the normal derived sheet honest about research", async () => {
    const route = await one<{ supported: boolean; note: string }>(
      "select supported, note from campaign_action_executors where action_key='google_ad_build'",
    );
    expect(route.supported).toBe(false);
    expect(route.note).toContain("no runtime action handler");

    const { derived, missing } = deriveSheet(
      {
        id: CAMPAIGN, client_id: CLIENT, name: "Winter garage push", objective: "Book surveys",
        audience: null, daily_budget: 40, target_countries: ["Portsmouth"],
        conversion_event: "survey_booked", offer_version_id: null,
      },
      {
        pillars: ["Garage conversions"], serviceName: "Garage conversion",
        promise: null, pageId: PAGE, pageUrl: "https://example.test/garage",
        approvedCopy: 1,
      },
    );
    expect(missing).toContain("keyword_research");
    await record(derived, missing);
    expect(await blocker()).toContain("keyword_research");
    await asService();
    await expect(db.query("select request_campaign_google_build_v6($1,$2)", [CAMPAIGN, MANAGER]))
      .rejects.toThrow("keyword_research");
  });

  it("blocks a complete fixture while no handler exists, including the generic claim sweep", async () => {
    await completeFixture();
    expect(await blocker()).toContain("No runtime handler performs google_ad_build");
    const due = await one<{ action_supported: boolean }>(
      "select action_supported from google_ads_build_due where campaign_id=$1", [CAMPAIGN],
    );
    expect(due.action_supported).toBe(false);
    await asService();
    await expect(db.query("select request_campaign_google_build_v6($1,$2)", [CAMPAIGN, MANAGER]))
      .rejects.toThrow("No Google Ads build handler is enabled");
    // Simulate an approval that predates the registry gate: even an approved
    // action must not be claimed without a handler.
    await db.query(
      `insert into campaign_action_approvals
         (client_id,campaign_id,manifest_id,idempotency_key,action_key,destination,
          artifact_version_hash,scope,request_hash,status,decided_at,decided_by)
       values ($1,$2,$3,'legacy-google-approval','google_ad_build',
               'google_ads:customers/1234567890',repeat('a',64),'{}'::jsonb,
               repeat('a',32),'approved',now(),$4)`,
      [CLIENT, CAMPAIGN, MANIFEST, MANAGER],
    );
    const genericDue = await one<{ blocker: string }>(
      "select blocker from campaign_action_due where action_key='google_ad_build'",
    );
    expect(genericDue.blocker).toContain("no executor for google ad build");
    expect(await rows("select * from claim_campaign_actions(3)")).toHaveLength(0);
  });

  it("binds arrays, both display paths and the exact destination without delimiter collisions", async () => {
    await completeFixture();
    await db.exec("update campaign_action_executors set supported=true where action_key='google_ad_build'");
    const firstId = await request();
    const first = await one<{ artifact_version_hash: string; destination: string; scope: {
      approved_spec: { path1: string; path2: string; headlines: string[]; google_ads_customer_id: string };
    } }>("select artifact_version_hash, destination, scope from campaign_action_approvals where id=$1", [firstId]);
    expect(first.destination).toBe("google_ads:customers/1234567890");
    expect(first.scope.approved_spec).toMatchObject({
      path1: "garage", path2: "survey", headlines: ["A~B", "C", "D"],
      google_ads_customer_id: "1234567890",
    });

    await db.query("update google_ads_copy set headlines=$1 where campaign_id=$2", [["A", "B~C", "D"], CAMPAIGN]);
    const secondId = await request();
    const second = await one<{ artifact_version_hash: string }>(
      "select artifact_version_hash from campaign_action_approvals where id=$1", [secondId],
    );
    expect(["A~B", "C", "D"].join("~")).toBe(["A", "B~C", "D"].join("~"));
    expect(second.artifact_version_hash).not.toBe(first.artifact_version_hash);

    await db.query("update google_ads_copy set path1='new-path' where campaign_id=$1", [CAMPAIGN]);
    const thirdId = await request();
    const third = await one<{ artifact_version_hash: string }>(
      "select artifact_version_hash from campaign_action_approvals where id=$1", [thirdId],
    );
    expect(third.artifact_version_hash).not.toBe(second.artifact_version_hash);

    await db.query("update google_ads_copy set path2='new-path-2' where campaign_id=$1", [CAMPAIGN]);
    const fourthId = await request();
    const fourth = await one<{ artifact_version_hash: string }>(
      "select artifact_version_hash from campaign_action_approvals where id=$1", [fourthId],
    );
    expect(fourth.artifact_version_hash).not.toBe(third.artifact_version_hash);
  });

  it("rejects a changed approved copy or account before opening a build", async () => {
    await completeFixture();
    await db.exec("update campaign_action_executors set supported=true where action_key='google_ad_build'");
    const approvalId = await request();
    const executionId = await approveAndClaim(approvalId);
    await db.query("update google_ads_copy set path2='different' where campaign_id=$1", [CAMPAIGN]);
    await expect(db.query("select start_google_build_v6($1)", [executionId]))
      .rejects.toThrow("changed after this was approved");
    expect(await rows("select id from google_ads_builds")).toHaveLength(0);

    await db.query("update google_ads_copy set path2='survey' where campaign_id=$1", [CAMPAIGN]);
    await db.query(
      "update client_integrations set google_ads_customer_id='9999999999' where provider='google_ads'",
    );
    await expect(db.query("select start_google_build_v6($1)", [executionId]))
      .rejects.toThrow("changed after this was approved");
    expect(await rows("select id from google_ads_builds")).toHaveLength(0);
  });

  it("rejects a newly derived sheet after an exact earlier approval", async () => {
    await completeFixture();
    await db.exec("update campaign_action_executors set supported=true where action_key='google_ad_build'");
    const executionId = await approveAndClaim(await request());
    await record({ keyword_groups: [{ keywords: ["garage conversion quote"], source: "new research fixture" }] }, []);
    await asService();
    await expect(db.query("select start_google_build_v6($1)", [executionId]))
      .rejects.toThrow("build sheet changed after this was approved");
    expect(await rows("select id from google_ads_builds")).toHaveLength(0);
  });

  it("records the exact snapshot and refuses to claim a completed build twice", async () => {
    await completeFixture();
    await db.exec("update campaign_action_executors set supported=true where action_key='google_ad_build'");
    const executionId = await approveAndClaim(await request());
    await db.query("select start_google_build_v6($1)", [executionId]);
    const build = await one<{ id: string; approved_spec: {
      path1: string; path2: string; google_ads_customer_id: string;
    } }>("select id, approved_spec from google_ads_builds where campaign_id=$1", [CAMPAIGN]);
    const buildId = build.id;
    expect(build.approved_spec).toMatchObject({
      path1: "garage", path2: "survey", google_ads_customer_id: "1234567890",
    });
    await expect(db.query("select record_google_build_finished_v6($1)", [buildId]))
      .rejects.toThrow("must record its Google campaign");
    await db.query(
      `select record_google_build_progress_v6($1,$2)`,
      [buildId, JSON.stringify({
        campaign_resource: "customers/1234567890/campaigns/7",
        ad_group_resource: "customers/1234567890/adGroups/8",
        ad_resources: ["customers/1234567890/adGroupAds/9"],
      })],
    );
    await db.query("select record_google_build_finished_v6($1)", [buildId]);
    const campaign = await one<{ ad_campaign_id: string | null }>(
      "select ad_campaign_id from client_campaigns where id=$1", [CAMPAIGN],
    );
    expect(campaign.ad_campaign_id).toBeNull();
    await expect(db.query(
      "update google_ads_builds set approved_spec='{}'::jsonb where id=$1", [buildId],
    )).rejects.toThrow("cannot change its approved identity");
    await expect(db.query(
      "select record_google_build_progress_v6($1,'{}'::jsonb)", [buildId],
    )).rejects.toThrow("No build is currently building");
    await expect(db.query("select start_google_build_v6($1)", [executionId]))
      .rejects.toThrow("already built");
  });

  it("does not report an old completed build as the build of a new package and sheet", async () => {
    await completeFixture();
    await db.exec("update campaign_action_executors set supported=true where action_key='google_ad_build'");
    const executionId = await approveAndClaim(await request());
    const built = await one<{ id: string }>(
      "select (start_google_build_v6($1)).id as id", [executionId],
    );
    await db.query("select record_google_build_progress_v6($1,$2)", [
      built.id,
      JSON.stringify({
        campaign_resource: "customers/1234567890/campaigns/7",
        ad_group_resource: "customers/1234567890/adGroups/8",
        ad_resources: ["customers/1234567890/adGroupAds/9"],
      }),
    ]);
    await db.query("select record_google_build_finished_v6($1)", [built.id]);
    const before = await one<{ build_id: string; blocker: string | null }>(
      "select build_id, blocker from google_ads_build_due where campaign_id=$1", [CAMPAIGN],
    );
    expect(before).toMatchObject({ build_id: built.id, blocker: null });

    await db.query(
      `insert into campaign_manifest_versions
         (id,campaign_id,client_id,version,acquisition_mode,paid_platform,plan_hash)
       values ($1,$2,$3,2,'paid','google',repeat('b',32))`,
      [SECOND_MANIFEST, CAMPAIGN, CLIENT],
    );
    const currentSheet = await record(
      { keyword_groups: [{ keywords: ["new researched term"] }] }, [], SECOND_MANIFEST,
    );
    await db.exec("update campaign_action_executors set supported=false where action_key='google_ad_build'");
    const after = await one<{
      sheet_id: string; sheet_manifest_id: string; build_id: string | null;
      build_status: string | null; blocker: string;
    }>(
      `select sheet_id, sheet_manifest_id, build_id, build_status, blocker
         from google_ads_build_due where campaign_id=$1`,
      [CAMPAIGN],
    );
    expect(after).toMatchObject({
      sheet_id: currentSheet,
      sheet_manifest_id: SECOND_MANIFEST,
      build_id: null,
      build_status: null,
    });
    expect(after.blocker).toContain("No runtime handler performs google_ad_build");
    expect(await rows("select id from google_ads_builds where id=$1", [built.id])).toHaveLength(1);
  });

  it("preserves a build's sheet until the parent campaign is deleted", async () => {
    await completeFixture();
    await db.exec("update campaign_action_executors set supported=true where action_key='google_ad_build'");
    const executionId = await approveAndClaim(await request());
    await db.query("select start_google_build_v6($1)", [executionId]);
    const build = await one<{ id: string; sheet_id: string }>(
      "select id, sheet_id from google_ads_builds where campaign_id=$1", [CAMPAIGN],
    );

    await expect(db.query(
      "delete from google_ads_build_sheets where id=$1", [build.sheet_id],
    )).rejects.toThrow(/foreign key/i);
    expect(await rows("select id from google_ads_builds where id=$1", [build.id])).toHaveLength(1);
    expect(await rows("select id from google_ads_build_sheets where id=$1", [build.sheet_id]))
      .toHaveLength(1);

    await db.query("delete from client_campaigns where id=$1", [CAMPAIGN]);
    expect(await rows("select id from google_ads_builds where id=$1", [build.id])).toHaveLength(0);
    expect(await rows("select id from google_ads_build_sheets where id=$1", [build.sheet_id]))
      .toHaveLength(0);
  });

  it("rejects build rows whose approval or sheet belongs to another campaign or client", async () => {
    await completeFixture();
    await db.exec("update campaign_action_executors set supported=true where action_key='google_ad_build'");
    const ownApproval = await request();
    const ownSheet = await one<{ id: string }>(
      "select id from google_ads_build_sheets where campaign_id=$1 order by version desc limit 1",
      [CAMPAIGN],
    );

    await db.query(
      `insert into client_campaigns(id,client_id,name,acquisition_mode,paid_platform)
       values ($1,$2,'Second campaign','paid','google')`,
      [SECOND_CAMPAIGN, CLIENT],
    );
    async function foreignPair(campaignId: string, clientId: string, manifestId: string) {
      await db.query(
        `insert into campaign_manifest_versions
           (id,campaign_id,client_id,version,acquisition_mode,paid_platform,plan_hash)
         values ($1,$2,$3,1,'paid','google',repeat('c',32))`,
        [manifestId, campaignId, clientId],
      );
      const sheet = await one<{ id: string }>(
        `insert into google_ads_build_sheets
           (campaign_id,client_id,manifest_id,version,derived,missing,plan_hash)
         values ($1,$2,$3,1,'{}'::jsonb,'{}'::text[],repeat('c',64)) returning id`,
        [campaignId, clientId, manifestId],
      );
      const approval = await one<{ id: string }>(
        `insert into campaign_action_approvals
           (client_id,campaign_id,manifest_id,idempotency_key,action_key,destination,
            artifact_version_hash,scope,request_hash,status,decided_at,decided_by)
         values ($1,$2,$3,'other-google-build','google_ad_build',
                 'google_ads:customers/9999999999',repeat('c',64),'{}'::jsonb,
                 repeat('c',32),'approved',now(),$4) returning id`,
        [clientId, campaignId, manifestId, MANAGER],
      );
      return { sheetId: sheet.id, approvalId: approval.id };
    }

    const sameClient = await foreignPair(SECOND_CAMPAIGN, CLIENT, SECOND_MANIFEST);
    const anotherClient = await foreignPair(OTHER_CAMPAIGN, OTHER_CLIENT, OTHER_MANIFEST);
    for (const foreign of [sameClient, anotherClient]) {
      await expect(db.query(
        `insert into google_ads_builds
           (client_id,campaign_id,approval_id,sheet_id,approved_spec)
         values ($1,$2,$3,$4,'{}'::jsonb)`,
        [CLIENT, CAMPAIGN, foreign.approvalId, ownSheet.id],
      )).rejects.toThrow(/foreign key/i);
      await expect(db.query(
        `insert into google_ads_builds
           (client_id,campaign_id,approval_id,sheet_id,approved_spec)
         values ($1,$2,$3,$4,'{}'::jsonb)`,
        [CLIENT, CAMPAIGN, ownApproval, foreign.sheetId],
      )).rejects.toThrow(/foreign key/i);
    }
    expect(await rows("select id from google_ads_builds")).toHaveLength(0);
  });

  it("keeps copy and build records readable only for an authorized client", async () => {
    await completeFixture();
    await db.exec("update campaign_action_executors set supported=true where action_key='google_ad_build'");
    const executionId = await approveAndClaim(await request());
    await db.query("select start_google_build_v6($1)", [executionId]);
    await db.query(
      `insert into campaign_manifest_versions
         (id,campaign_id,client_id,version,acquisition_mode,paid_platform,plan_hash)
       values ('77777777-7777-4777-8777-777777777778',$1,$2,1,'paid','google',repeat('e',32))`,
      [OTHER_CAMPAIGN, OTHER_CLIENT],
    );
    await db.query(
      `insert into campaign_action_approvals
         (id,client_id,campaign_id,manifest_id,idempotency_key,action_key,destination,
          artifact_version_hash,scope,request_hash,status,decided_at,decided_by)
       values ('99999999-9999-4999-8999-999999999999',$1,$2,
               '77777777-7777-4777-8777-777777777778','other',
               'google_ad_build','google_ads:customers/9999999999',repeat('e',64),
               '{}'::jsonb,repeat('e',32),'approved',now(),$3)`,
      [OTHER_CLIENT, OTHER_CAMPAIGN, MANAGER],
    );
    const otherSheet = await one<{ id: string }>(
      `insert into google_ads_build_sheets
         (campaign_id,client_id,manifest_id,version,derived,missing,plan_hash)
       values ($1,$2,'77777777-7777-4777-8777-777777777778',1,
               '{}'::jsonb,'{}'::text[],repeat('e',64)) returning id`,
      [OTHER_CAMPAIGN, OTHER_CLIENT],
    );
    await db.query(
      `insert into google_ads_builds
         (client_id,campaign_id,approval_id,sheet_id,approved_spec)
       values ($1,$2,'99999999-9999-4999-8999-999999999999',$3,'{}'::jsonb)`,
      [OTHER_CLIENT, OTHER_CAMPAIGN, otherSheet.id],
    );
    await db.query(
      `insert into google_ads_copy
        (client_id,campaign_id,headlines,descriptions,final_url)
       values ($1,$2,array['Other A','Other B','Other C'],
               array['Other description','Another description'], 'https://other.test/')`,
      [OTHER_CLIENT, OTHER_CAMPAIGN],
    );
    await db.query(
      "insert into client_campaigns(id,client_id,name,acquisition_mode) values ($1,$2,'Wrong bind','organic')",
      [WRONG_CAMPAIGN, CLIENT],
    );
    await expect(db.query(
      `insert into google_ads_copy
         (client_id,campaign_id,headlines,descriptions,final_url)
       values ($1,$2,array['Wrong A','Wrong B','Wrong C'],
               array['Wrong description','Another description'],'https://wrong.test/')`,
      [OTHER_CLIENT, WRONG_CAMPAIGN],
    )).rejects.toThrow(/foreign key/i);
    await db.exec("set role authenticated");
    try {
      const visible = await rows<{ client_id: string }>("select client_id from google_ads_copy");
      expect(visible.map((r) => r.client_id)).toEqual([CLIENT]);
      const builds = await rows<{ client_id: string }>("select client_id from google_ads_builds");
      expect(builds.map((r) => r.client_id)).toEqual([CLIENT]);
      await expect(db.query(
        "update google_ads_copy set path1='changed' where campaign_id=$1", [CAMPAIGN],
      )).rejects.toThrow(/permission denied|row-level security/i);
    } finally {
      await db.exec("reset role");
    }
    await db.exec("set role anon");
    try {
      await expect(db.query("select * from google_ads_copy"))
        .rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec("reset role");
    }
  });
});
