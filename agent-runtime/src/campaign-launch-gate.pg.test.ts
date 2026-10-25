import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 245 against a real Postgres.
 *
 * G08 was that nothing answered "is this campaign live". The confusion the
 * gate exists to kill is between our part -- every external action approved
 * and executed -- and the world's part, which is a post that went out or
 * money that moved. A campaign can be the first without being the second for
 * a fortnight, because the last step of a paid route is a person in Ads
 * Manager.
 *
 * So what is asserted here is the verdict sentence at each stage, and in
 * particular that the two reasons for "no spend" are told apart: an unbound
 * external id means we cannot know, which is fixed by binding an id; a bound
 * id with no spend means somebody has not switched the ads on.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const CAMP = "22222222-2222-4222-8222-222222222222";
const LEGACY = "33333333-3333-4333-8333-333333333333";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

/** The gate's verdict for our campaign. */
async function verdict(): Promise<string> {
  const row = await one<{ verdict: string }>(
    "select verdict from campaign_launch_due where campaign_id = $1", [CAMP]);
  return row.verdict;
}
async function live(): Promise<boolean> {
  const row = await one<{ live: boolean }>(
    "select live from campaign_launch_due where campaign_id = $1", [CAMP]);
  return row.live;
}

/** A manifest whose route needs a Meta build and a page. */
async function manifest(mode = "paid", platform: string | null = "meta"): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into campaign_manifest_versions (campaign_id, client_id, version, acquisition_mode, paid_platform)
     values ($1,$2,1,$3,$4) returning id`, [CAMP, CLIENT, mode, platform]);
  await db.query(
    `insert into campaign_manifest_items (manifest_id, item_key, module_key, required, external_activation) values
       ($1,'website','website_studio',true,true),
       ($1,'distribution',$2,true,true),
       ($1,'creative','content_production_factory',true,false)`,
    [id, platform === "meta" ? "meta_ads_studio" : "content_distribution"]);
  return id;
}

/** Approve an action, and optionally record that it executed. */
async function approve(manifestId: string, action: string, executed = true): Promise<void> {
  const { id } = await one<{ id: string }>(
    `insert into campaign_action_approvals
       (client_id, campaign_id, manifest_id, action_key, artifact_version_hash, status, decided_at)
     values ($1,$2,$3,$4,'hash-1','approved',now()) returning id`,
    [CLIENT, CAMP, manifestId, action]);
  if (executed) {
    await db.query(
      `insert into campaign_action_executions
         (approval_id, client_id, campaign_id, action_key, artifact_version_hash, manifest_id,
          status, executed_at)
       values ($1,$2,$3,$4,'hash-1',$5,'executed',now())`,
      [id, CLIENT, CAMP, action, manifestId]);
  }
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select 'authenticated'$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;

 create table clients(id uuid primary key);
 create table campaigns(id uuid primary key);
 create table client_campaigns(
   id uuid primary key, client_id uuid not null, name text not null,
   acquisition_mode text not null default 'legacy', paid_platform text,
   template text, status text not null default 'active',
   ad_campaign_id uuid, meta_campaign_id text, archived_at timestamptz);

 create table campaign_manifest_versions(
   id uuid primary key default gen_random_uuid(), campaign_id uuid not null,
   client_id uuid not null, version integer not null,
   acquisition_mode text not null, paid_platform text);
 create table campaign_manifest_items(
   manifest_id uuid not null, item_key text not null, module_key text not null,
   required boolean not null default true, depends_on text[] not null default '{}',
   external_activation boolean not null default false,
   primary key (manifest_id, item_key));

 create table campaign_action_executors(
   action_key text primary key, executor_module text not null,
   supported boolean not null default false, note text not null);
 insert into campaign_action_executors values
   ('meta_ad_build','meta_ads_studio',true,'Creates paused Meta objects.'),
   ('page_deploy','website_studio',true,'Publishes the reviewed bytes.'),
   ('google_ad_build','google_ads_studio',false,'No Google Ads adapter exists.'),
   ('organic_publish','content_distribution',false,'Executes through the publish sweep.'),
   ('proof_publish','proof_distribution',true,'Releases placements.'),
   ('campaign_launch','campaign_factory',false,'A launch is every other action having happened.');

 create table campaign_action_approvals(
   id uuid primary key default gen_random_uuid(), client_id uuid not null,
   campaign_id uuid not null, manifest_id uuid, action_key text not null,
   artifact_version_hash text, status text not null default 'pending',
   rejection_reason text, requested_at timestamptz not null default now(),
   decided_at timestamptz);
 create table campaign_action_executions(
   id uuid primary key default gen_random_uuid(), approval_id uuid not null unique,
   client_id uuid not null, campaign_id uuid not null, action_key text not null,
   artifact_version_hash text not null, manifest_id uuid not null,
   status text not null default 'executing', attempts integer not null default 0,
   executed_at timestamptz, external_id text, last_error text);

 create table client_ideas(id uuid primary key default gen_random_uuid(), campaign_id uuid);
 create table client_briefs(id uuid primary key default gen_random_uuid(), source_idea_id uuid);
 create table client_media_assets(id uuid primary key default gen_random_uuid(), brief_id uuid);
 create table scheduled_posts(id uuid primary key default gen_random_uuid(),
   client_id uuid, asset_id uuid, published_at timestamptz);

 create table metrics_daily(id uuid primary key default gen_random_uuid(),
   client_id uuid not null, campaign_id uuid, entity_type text, external_id text,
   metric_date date not null, spend numeric);

 create table campaign_page_publications(id uuid primary key default gen_random_uuid(),
   approval_id uuid not null, client_id uuid, page_id uuid, probe_status text);
 create table proof_placements(id uuid primary key default gen_random_uuid(),
   campaign_id uuid, status text not null);
 create table client_leads(id uuid primary key default gen_random_uuid(),
   source_client_campaign_id uuid, is_probe boolean not null default false);
 create table client_engine_settings(client_id uuid primary key,
   campaign_actions_enabled boolean not null default false);

 insert into clients values('${CLIENT}');
 insert into campaigns values('${LEGACY}');
 insert into client_campaigns (id, client_id, name, acquisition_mode, paid_platform, template)
   values ('${CAMP}','${CLIENT}','Garage conversions — R1','paid','meta','R1');
 insert into client_engine_settings (client_id, campaign_actions_enabled)
   values ('${CLIENT}', true);`);

  await db.exec(await sql("20261025100000_245_is_this_campaign_actually_live.sql"));
});

afterAll(async () => {
  await db?.close();
});

describe("migration 245 — our part", () => {
  it("refuses to talk about launching a campaign with no manifest", async () => {
    expect(await verdict()).toMatch(/no manifest, so there is nothing to launch/i);
    expect(await live()).toBe(false);
  });

  it("names the action nobody has asked for", async () => {
    await manifest();
    expect(await verdict()).toMatch(/Nobody has asked for (page_deploy|meta_ad_build) yet/);
  });

  it("says an approved action is waiting for the sweep", async () => {
    const m = await manifest();
    await approve(m, "page_deploy", false);
    await approve(m, "meta_ad_build", false);
    expect(await verdict()).toBe("Approved. It runs on the next sweep.");
  });

  it("surfaces a rejection with its reason", async () => {
    const m = await manifest();
    await approve(m, "meta_ad_build");
    await db.query(
      `insert into campaign_action_approvals
        (client_id, campaign_id, manifest_id, action_key, status, rejection_reason)
       values ($1,$2,$3,'page_deploy','rejected','The price on the page is last year''s')`,
      [CLIENT, CAMP, m]);
    expect(await verdict()).toContain("The price on the page is last year's");
  });

  it("surfaces a failed execution with its error", async () => {
    const m = await manifest();
    await approve(m, "page_deploy");
    const { id } = await one<{ id: string }>(
      `insert into campaign_action_approvals
        (client_id, campaign_id, manifest_id, action_key, artifact_version_hash, status, decided_at)
       values ($1,$2,$3,'meta_ad_build','h','approved',now()) returning id`, [CLIENT, CAMP, m]);
    await db.query(
      `insert into campaign_action_executions
        (approval_id, client_id, campaign_id, action_key, artifact_version_hash, manifest_id,
         status, attempts, last_error)
       values ($1,$2,$3,'meta_ad_build','h',$4,'failed',2,'Meta rejected the audience')`,
      [id, CLIENT, CAMP, m]);
    expect(await verdict()).toContain("Meta rejected the audience");
  });

  it("ignores an approval made against a superseded manifest", async () => {
    const first = await manifest();
    await approve(first, "page_deploy");
    await approve(first, "meta_ad_build");
    // A second manifest version supersedes the first, and its requirements
    // have nobody's approval against them.
    const { id: second } = await one<{ id: string }>(
      `insert into campaign_manifest_versions (campaign_id, client_id, version, acquisition_mode, paid_platform)
       values ($1,$2,2,'paid','meta') returning id`, [CAMP, CLIENT]);
    await db.query(
      `insert into campaign_manifest_items (manifest_id, item_key, module_key, required, external_activation)
       values ($1,'distribution','meta_ads_studio',true,true)`, [second]);
    expect(await verdict()).toMatch(/Nobody has asked for meta_ad_build yet/);
  });

  it("says the client switch is off even when everything is approved", async () => {
    const m = await manifest();
    await approve(m, "page_deploy");
    await approve(m, "meta_ad_build");
    await db.query(
      `update client_engine_settings set campaign_actions_enabled = false where client_id = $1`,
      [CLIENT]);
    expect(await verdict()).toMatch(/external campaign actions are off for this client/i);
  });

  it("reports an unsupported adapter rather than pretending it is pending", async () => {
    const m = await manifest("paid", "google");
    await approve(m, "page_deploy");
    expect(await verdict()).toMatch(/No adapter performs google_ad_build/);
  });
});

describe("migration 245 — the world's part", () => {
  /** Everything our side can do, done. The campaign's own mode is the one the
   *  gate reads, so it moves with the manifest's. */
  async function ourPartDone(mode = "paid", platform: string | null = "meta") {
    await db.query(
      `update client_campaigns set acquisition_mode = $2, paid_platform = $3 where id = $1`,
      [CAMP, mode, platform]);
    const m = await manifest(mode, platform);
    await approve(m, "page_deploy");
    if (mode === "paid") await approve(m, platform === "meta" ? "meta_ad_build" : "google_ad_build");
    return m;
  }

  it("tells an unbound id apart from a bound one that is not spending", async () => {
    await ourPartDone();
    // No ad_campaign_id and no meta_campaign_id: there is no path to a spend row.
    expect(await verdict()).toMatch(/no external campaign id is bound, so whether it is spending cannot be known/i);
    expect(await live()).toBe(false);

    await db.query(`update client_campaigns set meta_campaign_id = 'act_123' where id = $1`, [CAMP]);
    expect(await verdict()).toMatch(/a person has not switched them on in Ads Manager/i);
    expect(await live()).toBe(false);
  });

  it("calls a paid campaign live only once spend is observed", async () => {
    await ourPartDone();
    await db.query(`update client_campaigns set meta_campaign_id = 'c-9' where id = $1`, [CAMP]);
    await db.query(
      `insert into metrics_daily (client_id, entity_type, external_id, metric_date, spend) values
         ($1,'campaign','c-9','2026-10-20', 40.5),
         ($1,'campaign','c-9','2026-10-21', 38.0)`, [CLIENT]);
    expect(await verdict()).toBe("Live: spend on 2 day(s).");
    expect(await live()).toBe(true);
  });

  it("finds spend through the legacy tracker binding too", async () => {
    await ourPartDone();
    await db.query(`update client_campaigns set ad_campaign_id = $2 where id = $1`, [CAMP, LEGACY]);
    await db.query(
      `insert into metrics_daily (client_id, campaign_id, metric_date, spend)
       values ($1,$2,'2026-10-22', 12.0)`, [CLIENT, LEGACY]);
    expect(await verdict()).toBe("Live: spend on 1 day(s).");
  });

  it("does not count a bound campaign's zero-spend days as live", async () => {
    await ourPartDone();
    await db.query(`update client_campaigns set meta_campaign_id = 'c-0' where id = $1`, [CAMP]);
    await db.query(
      `insert into metrics_daily (client_id, entity_type, external_id, metric_date, spend)
       values ($1,'campaign','c-0','2026-10-20', 0)`, [CLIENT]);
    expect(await verdict()).toMatch(/has not switched them on/i);
    expect(await live()).toBe(false);
  });

  it("an organic campaign is live when a post went out, not when it was approved", async () => {
    await ourPartDone("organic", null);
    expect(await verdict()).toMatch(/Nothing has published yet, so nothing is live/i);
    expect(await live()).toBe(false);

    // asset -> brief -> idea -> campaign is the only path a post has to a campaign.
    const { id: idea } = await one<{ id: string }>(
      `insert into client_ideas (campaign_id) values ($1) returning id`, [CAMP]);
    const { id: brief } = await one<{ id: string }>(
      `insert into client_briefs (source_idea_id) values ($1) returning id`, [idea]);
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (brief_id) values ($1) returning id`, [brief]);
    await db.query(
      `insert into scheduled_posts (client_id, asset_id, published_at) values ($1,$2,now())`,
      [CLIENT, asset]);

    expect(await verdict()).toBe("Live: 1 post(s) published.");
    expect(await live()).toBe(true);
  });

  it("does not count a scheduled-but-unpublished post as live", async () => {
    await ourPartDone("organic", null);
    const { id: idea } = await one<{ id: string }>(
      `insert into client_ideas (campaign_id) values ($1) returning id`, [CAMP]);
    const { id: brief } = await one<{ id: string }>(
      `insert into client_briefs (source_idea_id) values ($1) returning id`, [idea]);
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (brief_id) values ($1) returning id`, [brief]);
    await db.query(
      `insert into scheduled_posts (client_id, asset_id, published_at) values ($1,$2,null)`,
      [CLIENT, asset]);
    expect(await live()).toBe(false);
  });

  it("mentions attributed leads once there are any", async () => {
    await ourPartDone("organic", null);
    const { id: idea } = await one<{ id: string }>(
      `insert into client_ideas (campaign_id) values ($1) returning id`, [CAMP]);
    const { id: brief } = await one<{ id: string }>(
      `insert into client_briefs (source_idea_id) values ($1) returning id`, [idea]);
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (brief_id) values ($1) returning id`, [brief]);
    await db.query(`insert into scheduled_posts (client_id, asset_id, published_at) values ($1,$2,now())`,
      [CLIENT, asset]);
    await db.query(
      `insert into client_leads (source_client_campaign_id, is_probe) values ($1,false),($1,false),($1,true)`,
      [CAMP]);
    // The probe lead is excluded: it is real, but it is not a prospect.
    expect(await verdict()).toBe("Live: 1 post(s) published and 2 lead(s) attributed.");
  });
});

describe("migration 245 — the quiet failure", () => {
  it("warns when a published page has no passing probe", async () => {
    const m = await manifest();
    await approve(m, "meta_ad_build");
    const { id } = await one<{ id: string }>(
      `insert into campaign_action_approvals
        (client_id, campaign_id, manifest_id, action_key, artifact_version_hash, status, decided_at)
       values ($1,$2,$3,'page_deploy','h','approved',now()) returning id`, [CLIENT, CAMP, m]);
    await db.query(
      `insert into campaign_action_executions
        (approval_id, client_id, campaign_id, action_key, artifact_version_hash, manifest_id, status, executed_at)
       values ($1,$2,$3,'page_deploy','h',$4,'executed',now())`, [id, CLIENT, CAMP, m]);
    await db.query(
      `insert into campaign_page_publications (approval_id, client_id, probe_status)
       values ($1,$2,null)`, [id, CLIENT]);

    const row = await one<{ warning: string | null }>(
      "select warning from campaign_launch_due where campaign_id = $1", [CAMP]);
    expect(row.warning).toBe("1 published page(s) have no passing form probe.");
  });

  it("drops the warning once the probe passes", async () => {
    const m = await manifest();
    await approve(m, "meta_ad_build");
    const { id } = await one<{ id: string }>(
      `insert into campaign_action_approvals
        (client_id, campaign_id, manifest_id, action_key, artifact_version_hash, status, decided_at)
       values ($1,$2,$3,'page_deploy','h','approved',now()) returning id`, [CLIENT, CAMP, m]);
    await db.query(
      `insert into campaign_page_publications (approval_id, client_id, probe_status)
       values ($1,$2,'passed')`, [id, CLIENT]);
    const row = await one<{ warning: string | null }>(
      "select warning from campaign_launch_due where campaign_id = $1", [CAMP]);
    expect(row.warning).toBeNull();
  });
});

describe("migration 245 — the legacy live status", () => {
  it("warns when the row claims live and nothing outside agrees", async () => {
    const m = await manifest();
    await approve(m, "page_deploy");
    await approve(m, "meta_ad_build");
    // What launch_campaign does: status live, from an internal checklist alone.
    await db.query(`update client_campaigns set status = 'live' where id = $1`, [CAMP]);

    const row = await one<{ status_claims_live: boolean; live: boolean; warning: string }>(
      "select status_claims_live, live, warning from campaign_launch_due where campaign_id = $1",
      [CAMP]);
    expect(row.status_claims_live).toBe(true);
    expect(row.live).toBe(false);
    expect(row.warning).toContain("came from an internal checklist, not from evidence");
  });

  it("drops the warning once the evidence agrees with the claim", async () => {
    const m = await manifest();
    await approve(m, "page_deploy");
    await approve(m, "meta_ad_build");
    await db.query(
      `update client_campaigns set status = 'live', meta_campaign_id = 'c-7' where id = $1`, [CAMP]);
    await db.query(
      `insert into metrics_daily (client_id, entity_type, external_id, metric_date, spend)
       values ($1,'campaign','c-7','2026-10-20', 5)`, [CLIENT]);
    const row = await one<{ live: boolean; warning: string | null }>(
      "select live, warning from campaign_launch_due where campaign_id = $1", [CAMP]);
    expect(row.live).toBe(true);
    expect(row.warning).toBeNull();
  });
});

describe("migration 245 — the registry note", () => {
  it("points campaign_launch at the view instead of claiming an executor", async () => {
    const row = await one<{ supported: boolean; note: string }>(
      "select supported, note from campaign_action_executors where action_key = 'campaign_launch'");
    expect(row.supported).toBe(false);
    expect(row.note).toContain("campaign_launch_due");
    expect(row.note).toContain("Nothing executes a launch");
  });
});
