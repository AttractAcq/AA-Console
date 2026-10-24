import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 237 against a real Postgres, on top of 206, 212, 213 and 230.
 *
 * 212 blocked v6 campaign page publishing "until its exact-version approval
 * executor exists". 237 does not lift that block; it adds one key. So the
 * tests are about what the key does not open:
 *
 *   an approval that is not approved
 *   an approval for a different page
 *   a page whose bytes changed after somebody read them
 *   a package superseded between the yes and the commit
 *   every other route into publication, which stays shut
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const CAMPAIGN = "66666666-6666-4666-8666-666666666666";
const MANIFEST = "77777777-7777-4777-8777-777777777777";
const PAGE = "88888888-8888-4888-8888-888888888888";
const REVISION = "99999999-9999-4999-8999-999999999999";
const REPO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const HTML = "<html><body>Book your garage survey</body></html>";
const HTML_SHA = createHash("sha256").update(HTML, "utf8").digest("hex");

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

/** An approved page deployment with its reviewable snapshot. */
async function approvedDeploy(over: { status?: string; sha?: string } = {}) {
  const approval = await one<{ id: string }>(
    `insert into campaign_action_approvals (client_id, campaign_id, manifest_id, idempotency_key,
       action_key, destination, artifact_version_hash, scope, request_hash, status,
       decided_at, decided_by)
     values ($1,$2,$3,'page-deploy:1','page_deploy','https://harbourhome.co.uk/garage-survey',
       $4,'{}'::jsonb,$5,$6,
       case when $6 = 'pending' then null else now() end,
       case when $6 = 'pending' then null else $7::uuid end)
     returning id`,
    [CLIENT, CAMPAIGN, MANIFEST, "a".repeat(64), "b".repeat(32), over.status ?? "approved", MANAGER],
  );
  await db.query(
    `insert into campaign_page_approval_snapshots (approval_id, client_id, page_id, revision_id,
       site_repository_id, site_path, rendered_html, rendered_sha256)
     values ($1,$2,$3,$4,$5,'p/garage-survey/',$6,$7)`,
    [approval.id, CLIENT, PAGE, REVISION, REPO, HTML, over.sha ?? HTML_SHA],
  );
  return approval.id;
}

/** The gate the executor calls, as the executor calls it. */
async function gate(approvalId: string, html = HTML, pageId = PAGE) {
  await asService();
  try {
    await db.query("select assert_page_publish_by_approval_v6($1,$2,$3)", [approvalId, pageId, html]);
    return null;
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    await asHuman();
  }
}

async function blocker(approvalId: string): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from campaign_page_publish_due where approval_id = $1",
    [approvalId],
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
 create function is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
 create function active_video_approval_manager(uuid) returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function can_access_client(uuid) returns boolean language sql as $$select $1='${CLIENT}'::uuid$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin return new; end$$;

 create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
 create function cron.schedule(a text,b text,c text) returns bigint language sql as
   $$ insert into cron.job (jobname,schedule,command) values (a,b,c) returning jobid $$;
 create function cron.unschedule(a text) returns boolean language sql as
   $$ delete from cron.job where jobname=a returning true $$;

 create type lead_stage as enum ('lead','conversation','qualified_conversation','appointment',
   'qualified_appointment','shown','sale','cash','lost');
 create type pipeline_stage as enum ('first_touch','engaged','booked');

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_campaigns(id uuid primary key, client_id uuid, unique (id, client_id));
 create table client_site_repositories(id uuid primary key, client_id uuid);
 create table client_pages(id uuid primary key, client_id uuid, html text,
   published_url text, publish_status text default 'draft');
 create table client_page_revisions(id uuid primary key, page_id uuid);
 create table campaign_artifacts(campaign_id uuid, client_id uuid, kind text, page_id uuid);
 create table client_leads(id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   email text, created_at timestamptz not null default now());
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
 insert into client_campaigns values('${CAMPAIGN}','${CLIENT}');
 insert into client_site_repositories values('${REPO}','${CLIENT}');
 insert into client_pages(id, client_id, html) values('${PAGE}','${CLIENT}',$html$${HTML}$html$);
 insert into client_page_revisions values('${REVISION}','${PAGE}');
 insert into campaign_manifest_versions values
   ('${MANIFEST}','${CAMPAIGN}','${CLIENT}',1,'paid','meta',repeat('f',32));
 insert into client_engine_settings(client_id) values('${CLIENT}');`);

  await db.exec(await sql("20261015230000_206_v6_action_approvals.sql"));
  await db.exec(await sql("20261016060000_213_v6_page_approval_snapshot.sql"));
  await db.exec(await sql("20261022090000_230_campaign_action_executor.sql"));
  await db.exec(await sql("20261024110000_237_a_page_goes_live_on_an_approval.sql"));
  await db.exec("update client_engine_settings set campaign_actions_enabled = true;");
  await asHuman();
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("the key, and what it does not open", () => {
  it("permits exactly the page and bytes that were approved", async () => {
    const approval = await approvedDeploy();
    expect(await gate(approval)).toBeNull();
    expect(await blocker(approval)).toBeNull();
  });

  it("refuses a deployment nobody has approved", async () => {
    const approval = await approvedDeploy({ status: "pending" });
    expect(await gate(approval)).toContain("is pending, not approved");
    expect(await blocker(approval)).toBe("This page deployment is pending.");
  });

  it("refuses an approval for a different page", async () => {
    const approval = await approvedDeploy();
    await db.exec(`insert into client_pages(id, client_id, html)
      values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${CLIENT}','<html></html>')`);
    expect(await gate(approval, HTML, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toContain(
      "for a different page",
    );
  });

  it("refuses bytes that changed after somebody read them", async () => {
    const approval = await approvedDeploy();
    const edited = HTML.replace("Book your garage survey", "Book your FREE garage survey");
    expect(await gate(approval, edited)).toContain("changed after it was approved");

    // And the board says so without being asked, because the page itself was
    // regenerated rather than the approval altered.
    await db.query("update client_pages set html = $1 where id = $2", [edited, PAGE]);
    expect(await blocker(approval)).toContain("changed after it was approved");
  });

  it("refuses a page with nothing built", async () => {
    const approval = await approvedDeploy();
    expect(await gate(approval, "")).toContain("no built HTML");
  });

  it("refuses a package superseded between the yes and the commit", async () => {
    const approval = await approvedDeploy();
    await db.exec(`insert into campaign_manifest_versions values
      (gen_random_uuid(),'${CAMPAIGN}','${CLIENT}',2,'paid','meta',repeat('e',32))`);
    expect(await gate(approval)).toContain("superseded");
    expect(await blocker(approval)).toContain("superseded");
  });

  it("is the internal service's to call", async () => {
    const approval = await approvedDeploy();
    await expect(
      db.query("select assert_page_publish_by_approval_v6($1,$2,$3)", [approval, PAGE, HTML]),
    ).rejects.toThrow("Only the internal service");
  });

  it("leaves 212's general block exactly where it was", async () => {
    // The key is a second function. The original is untouched, so the admin
    // route, the MCP route and the legacy publisher are all still shut.
    const original = await sql("20261016050000_212_v6_page_publish_boundary.sql");
    const now = await sql("20261024110000_237_a_page_goes_live_on_an_approval.sql");
    expect(original).toContain("create function public.assert_page_publish_allowed_v6");
    expect(now).not.toContain("drop function public.assert_page_publish_allowed_v6");
    expect(now).not.toContain("create or replace function public.assert_page_publish_allowed_v6");
  });
});

describe("recording what went live", () => {
  it("records the commit once, however many times it is recorded", async () => {
    const approval = await approvedDeploy();
    await asService();
    const first = await one<{ record_campaign_page_published_v6: string }>(
      "select record_campaign_page_published_v6($1,$2,$3,$4)",
      [approval, "https://harbourhome.co.uk/garage-survey", "a41f9cd", HTML_SHA],
    );
    const second = await one<{ record_campaign_page_published_v6: string }>(
      "select record_campaign_page_published_v6($1,$2,$3,$4)",
      [approval, "https://harbourhome.co.uk/garage-survey", "a41f9cd", HTML_SHA],
    );
    await asHuman();
    expect(second.record_campaign_page_published_v6).toBe(first.record_campaign_page_published_v6);
    expect(await rows("select 1 from campaign_page_publications")).toHaveLength(1);
  });

  it("does not call a published page live until the form has been tested", async () => {
    const approval = await approvedDeploy();
    await asService();
    const published = await one<{ record_campaign_page_published_v6: string }>(
      "select record_campaign_page_published_v6($1,$2,$3,$4)",
      [approval, "https://harbourhome.co.uk/garage-survey", "a41f9cd", HTML_SHA],
    );
    await asHuman();

    // Published and untested is its own sentence, deliberately not "live".
    expect(await blocker(approval)).toBe("Published. Nobody has tested the form yet.");

    await asService();
    await db.query("select record_campaign_page_probe_v6($1,false,$2,null)", [
      published.record_campaign_page_published_v6,
      "The submission was accepted but no lead appeared.",
    ]);
    await asHuman();
    expect(await blocker(approval)).toContain("the form probe failed");

    await asService();
    const lead = await one<{ id: string }>(
      `insert into client_leads (client_id, email) values ($1,'probe@probe.attractacq.com') returning id`,
      [CLIENT],
    );
    await db.query("select record_campaign_page_probe_v6($1,true,$2,$3)", [
      published.record_campaign_page_published_v6,
      "A test submission reached Sales OS with its campaign, source and consent.",
      lead.id,
    ]);
    await asHuman();
    expect(await blocker(approval)).toBe("Live and tested.");
  });

  it("marks a probe lead so the pipeline can leave it out", async () => {
    expect(
      await rows(
        "select 1 from information_schema.columns where table_name = 'client_leads' and column_name = 'is_probe'",
      ),
    ).toHaveLength(1);
  });

  it("makes page_deploy a supported action", async () => {
    expect(
      await one<{ supported: boolean }>(
        "select supported from campaign_action_executors where action_key = 'page_deploy'",
      ),
    ).toMatchObject({ supported: true });
  });

  it("ends with the grant sweep", async () => {
    expect(await sql("20261024110000_237_a_page_goes_live_on_an_approval.sql")).toContain(
      "select lock_down_definer_functions();",
    );
  });
});
