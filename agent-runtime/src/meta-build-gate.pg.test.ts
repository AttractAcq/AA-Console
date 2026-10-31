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

async function claimedMeta(): Promise<{ execution_id: string; approval_id: string }> {
  await asService();
  const claimed = await rows<{ execution_id: string; approval_id: string }>(
    "select * from claim_campaign_actions(1)",
  );
  await asHuman();
  const row = claimed[0];
  if (!row) throw new Error("Expected the approved Meta build to be claimable");
  return row;
}

async function queueExactMeta(executionId: string): Promise<string> {
  await asService();
  try {
    return (await one<{ job_id: string }>(
      "select enqueue_approved_meta_build_v6($1) as job_id", [executionId],
    )).job_id;
  } finally {
    await asHuman();
  }
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
   input_table text, input_id uuid, created_by uuid,
   status text not null default 'queued', params jsonb);
 create table agent_job_events(job_id uuid references agent_jobs(id), description text, payload jsonb);
 create function enqueue_agent_job_internal(
   p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
   p_actor uuid, p_params jsonb default '{}'::jsonb, p_description text default 'Queued'
 ) returns uuid language plpgsql security definer as $$
 declare v_job uuid;
 begin
   if exists (select 1 from agents where agent_key = p_agent_key and paused) then
     raise exception 'Agent % is paused', p_agent_key;
   end if;
   insert into agent_jobs(agent_key, client_id, input_table, input_id, created_by, params)
   values (p_agent_key, p_client_id, p_input_table, p_input_id, p_actor, p_params)
   returning id into v_job;
   insert into agent_job_events values (v_job, p_description, p_params);
   return v_job;
 end $$;
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
 insert into client_engine_settings(client_id) values('${CLIENT}');
 insert into agents(agent_key, name, initials) values('meta_build', 'Meta Builder', 'MB');`);

  await db.exec(await sql("20261015230000_206_v6_action_approvals.sql"));
  await db.exec(await sql("20261022090000_230_campaign_action_executor.sql"));
  await db.exec(await sql("20261024130000_239_a_meta_build_runs_on_an_approval.sql"));
  await db.exec(await sql("20261101060000_292_meta_v6_atomic_job_binding.sql"));
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

describe("migration 289 exact Meta job binding", () => {
  it("refuses a hash semantic change when any Meta build decision already exists", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(`
        create table public.campaign_action_approvals (action_key text);
        insert into public.campaign_action_approvals values ('meta_ad_build');`);
      await expect(isolated.exec(await sql("20261101060000_292_meta_v6_atomic_job_binding.sql")))
        .rejects.toThrow(/Review existing Meta build approvals/);
    } finally {
      await isolated.close();
    }
  });

  it("atomically binds one job to the claimed execution and returns it on repeat", async () => {
    const approvalId = await ask();
    await approve(approvalId);
    const claim = await claimedMeta();
    expect(claim.approval_id).toBe(approvalId);

    const hashState = await one<{ live_hash: string; approved_hash: string }>(
      `select meta_build_payload_hash_v6($1) as live_hash,
              artifact_version_hash as approved_hash
         from campaign_action_approvals where id = $2`, [CAMPAIGN, approvalId],
    );
    expect(hashState.live_hash).toBe(hashState.approved_hash);
    await db.exec("set timezone = 'UTC'");
    expect((await one<{ live_hash: string }>(
      "select meta_build_payload_hash_v6($1) as live_hash", [CAMPAIGN],
    )).live_hash).toBe(hashState.approved_hash);

    const jobId = await queueExactMeta(claim.execution_id);
    expect(await queueExactMeta(claim.execution_id)).toBe(jobId);
    const execution = await one<{ meta_build_job_id: string; result: Record<string, unknown> }>(
      "select meta_build_job_id, result from campaign_action_executions where id = $1",
      [claim.execution_id],
    );
    expect(execution.meta_build_job_id).toBe(jobId);
    expect(execution.result.meta_build_job_id).toBe(jobId);
    const jobs = await rows<{ id: string; client_id: string; input_table: string; input_id: string;
      status: string; params: Record<string, unknown> }>("select * from agent_jobs where agent_key = 'meta_build'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: jobId, client_id: CLIENT, input_table: "client_campaigns", input_id: CAMPAIGN,
      status: "queued",
      params: {
        campaign_action_execution_id: claim.execution_id,
        campaign_action_approval_id: approvalId,
      },
    });
  });

  it("requires service role and a claimed execution before enqueue", async () => {
    const approvalId = await ask();
    await approve(approvalId);
    await expect(db.query("select enqueue_approved_meta_build_v6($1)", [approvalId]))
      .rejects.toThrow(/Only the internal service/);
    await asService();
    await expect(db.query("select enqueue_approved_meta_build_v6($1)", [approvalId]))
      .rejects.toThrow(/execution not found/);
    await asHuman();
    expect(await rows("select id from agent_jobs where agent_key = 'meta_build'")).toHaveLength(0);
  });

  it("refuses a missing caller role even if an exact execution was claimed", async () => {
    await approve(await ask());
    const claim = await claimedMeta();
    await db.exec("create or replace function auth.role() returns text language sql as $$select null::text$$");
    await expect(db.query("select enqueue_approved_meta_build_v6($1)", [claim.execution_id]))
      .rejects.toThrow(/Only the internal service/);
    expect(await rows("select id from agent_jobs where agent_key = 'meta_build'"))
      .toHaveLength(0);
  });

  it.each([
    ["changed budget", "update client_campaigns set daily_budget = 400"],
    ["campaign no longer uses Meta", "update client_campaigns set paid_platform = null"],
    ["disabled client switch", "update client_engine_settings set campaign_actions_enabled = false"],
    ["changed account", "update client_integrations set ad_account_id = 'act_9999999'"],
    ["expired execution lease", "update campaign_action_executions set lease_until = now() - interval '1 minute'"],
    ["superseded manifest", `insert into campaign_manifest_versions values
      (gen_random_uuid(),'${CAMPAIGN}','${CLIENT}',2,'paid','meta',repeat('e',32))`],
  ])("refuses %s without leaving an orphan job", async (_name, mutation) => {
    await approve(await ask());
    const claim = await claimedMeta();
    await db.exec(mutation);
    await expect(queueExactMeta(claim.execution_id)).rejects.toThrow();
    expect(await rows("select id from agent_jobs where agent_key = 'meta_build'")).toHaveLength(0);
    const row = await one<{ meta_build_job_id: string | null }>(
      "select meta_build_job_id from campaign_action_executions where id = $1",
      [claim.execution_id],
    );
    expect(row.meta_build_job_id).toBeNull();
  });

  it("rolls back both sides when queue insertion fails", async () => {
    await approve(await ask());
    const claim = await claimedMeta();
    await db.exec("update agents set paused = true where agent_key = 'meta_build'");
    await expect(queueExactMeta(claim.execution_id)).rejects.toThrow(/paused/);
    expect(await rows("select id from agent_jobs where agent_key = 'meta_build'")).toHaveLength(0);
    expect((await one<{ meta_build_job_id: string | null }>(
      "select meta_build_job_id from campaign_action_executions where id = $1", [claim.execution_id],
    )).meta_build_job_id).toBeNull();
  });

  it("freezes the job and execution binding while permitting job status updates", async () => {
    await approve(await ask());
    const claim = await claimedMeta();
    const jobId = await queueExactMeta(claim.execution_id);
    await db.query("update agent_jobs set status = 'running' where id = $1", [jobId]);
    await expect(db.query("update agent_jobs set params = '{}'::jsonb where id = $1", [jobId]))
      .rejects.toThrow(/cannot change its action identity/);
    await expect(db.query("update campaign_action_executions set meta_build_job_id = null where id = $1",
      [claim.execution_id])).rejects.toThrow(/cannot change or release/);
    await expect(db.query("update campaign_action_executions set result = '{}'::jsonb where id = $1",
      [claim.execution_id])).rejects.toThrow(/must retain its exact job binding/);
    expect((await one<{ status: string }>("select status from agent_jobs where id = $1", [jobId])).status)
      .toBe("running");
  });

  it("rejects a direct binding to a job with the wrong action parameters", async () => {
    await approve(await ask());
    const claim = await claimedMeta();
    const unrelated = (await one<{ id: string }>(
      "insert into agent_jobs(agent_key, client_id, input_table, input_id, params) " +
      "values ('meta_build', $1, 'client_campaigns', $2, '{}'::jsonb) returning id",
      [CLIENT, CAMPAIGN],
    )).id;
    await expect(db.query(
      "update campaign_action_executions set meta_build_job_id = $1::uuid, " +
      "result = jsonb_build_object('meta_build_job_id', ($1::uuid)::text) where id = $2",
      [unrelated, claim.execution_id],
    )).rejects.toThrow(/does not match this exact execution/);
    expect((await one<{ meta_build_job_id: string | null }>(
      "select meta_build_job_id from campaign_action_executions where id = $1", [claim.execution_id],
    )).meta_build_job_id).toBeNull();
  });

  it("rejects a forged binding on execution insert as well as update", async () => {
    const approvalId = await ask();
    const unrelated = (await one<{ id: string }>(
      "insert into agent_jobs(agent_key, client_id, input_table, input_id, params) " +
      "values ('meta_build', $1, 'client_campaigns', $2, '{}'::jsonb) returning id",
      [CLIENT, CAMPAIGN],
    )).id;
    await expect(db.query(
      `insert into campaign_action_executions
         (approval_id, client_id, campaign_id, action_key, artifact_version_hash,
          manifest_id, meta_build_job_id, result)
       select id, client_id, campaign_id, action_key, artifact_version_hash,
              manifest_id, $1::uuid,
              jsonb_build_object('meta_build_job_id', ($1::uuid)::text)
         from campaign_action_approvals where id = $2`,
      [unrelated, approvalId],
    )).rejects.toThrow(/does not match this exact execution/);
    expect(await rows("select id from campaign_action_executions where approval_id = $1", [approvalId]))
      .toHaveLength(0);
  });

  it("blocks a distinct approved action from making a second job for this campaign", async () => {
    const firstApproval = await ask();
    await approve(firstApproval);
    const first = await claimedMeta();
    const firstJob = await queueExactMeta(first.execution_id);

    await asService();
    const secondApproval = (await one<{ id: string }>(
      `select (request_campaign_action_approval_v6($1, 'second-meta-build',
         'meta_ad_build', 'meta:act_1184772', meta_build_payload_hash_v6($2),
         '{"ad_account":"act_1184772"}'::jsonb)).id as id`,
      [MANIFEST, CAMPAIGN],
    )).id;
    await asHuman();
    expect(secondApproval).not.toBe(firstApproval);
    await approve(secondApproval);
    const second = await claimedMeta();
    expect(second.approval_id).toBe(secondApproval);
    await expect(queueExactMeta(second.execution_id)).rejects.toThrow(/already has a bound Meta build job/);
    const jobs = await rows<{ id: string }>("select id from agent_jobs where agent_key = 'meta_build'");
    expect(jobs.map((row) => row.id)).toEqual([firstJob]);
  });
});
