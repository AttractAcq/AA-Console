import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 230 and 231 against a real Postgres, on top of the 206 ledger
 * and the 218 proof spine they exist to join.
 *
 * The things worth asserting are the ones that would be expensive to get
 * wrong in public, and they are all variations on one question: can anything
 * perform an external act that a person did not approve, or that they
 * approved for a different version of the thing?
 *
 *   - a package superseded after the yes
 *   - a client who has not been switched on
 *   - an action nothing can perform
 *   - a second claim of an action already done
 *   - a failure that did not obviously fail, retried
 *   - a lease that expired with the outcome unknown
 *   - proof whose permission ended between the yes and the act
 *
 * Each of those has a test below. The harness stubs what Supabase and
 * earlier migrations provide, in the same shape they provide it.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROOF = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const CAMPAIGN = "66666666-6666-4666-8666-666666666666";
const MANIFEST = "77777777-7777-4777-8777-777777777777";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(query, params)).rows;
}
async function one<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(query, params))[0]!;
}

/** As the runtime: the service role, which is the only thing that may claim. */
const asService = () => db.exec("set test.role = 'service_role'");
/** As a signed-in person, which is the only thing that may decide. */
const asHuman = () => db.exec("set test.role = 'authenticated'");

/** The blocker sentence for one approved action, or null if it would be taken. */
async function blocker(approvalId: string): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from campaign_action_due where approval_id = $1",
    [approvalId],
  );
  return row?.blocker ?? null;
}

/** Draft a placement, as the Proof Distribution screen does. */
async function draft(destination = "third_party_directory", campaign: string | null = CAMPAIGN) {
  return (
    await one<{ id: string }>(
      "select create_proof_placement_v6($1,$2,$3,$4,null,null,null,$5) as id",
      [`key-${destination}-${campaign ?? "none"}`, CLIENT, destination, ARTIFACT, campaign],
    )
  ).id;
}

/** The whole campaign-level ask, up to the point a person has to decide. */
async function ask(): Promise<string> {
  await asService();
  const row = await one<{ id: string }>(
    "select request_campaign_proof_publish_v6($1,$2) as id",
    [CAMPAIGN, MANAGER],
  );
  await asHuman();
  return row.id;
}

/** Ask, and have the person say yes. */
async function approved(): Promise<string> {
  const id = await ask();
  await db.query("select decide_campaign_action_approval_v6($1,'approved')", [id]);
  return id;
}

/** Claim as the runtime would, returning what it was handed. */
async function claim(limit = 3) {
  await asService();
  const claimed = await rows<{
    execution_id: string;
    approval_id: string;
    action_key: string;
    attempt: number;
  }>("select * from claim_campaign_actions($1)", [limit]);
  await asHuman();
  return claimed;
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
 create function integration_usable(uuid, text) returns boolean language sql as $$select coalesce(current_setting('test.integration',true),'false')='true'$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin return new; end$$;

 -- pg_cron, as the migrations use it.
 create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
 create function cron.schedule(a text,b text,c text) returns bigint language sql as
   $$ insert into cron.job (jobname,schedule,command) values (a,b,c) returning jobid $$;
 create function cron.unschedule(a text) returns boolean language sql as
   $$ delete from cron.job where jobname=a returning true $$;

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key, role text default 'admin');
 create table client_campaigns(id uuid primary key, client_id uuid, unique (id, client_id));
 create table client_pages(id uuid primary key, client_id uuid);
 create table client_page_revisions(id uuid primary key, page_id uuid);
 create table client_engine_settings(client_id uuid primary key references clients(id) on delete cascade,
   enabled boolean not null default false);
 create table client_proof_assets(id uuid primary key, client_id uuid, title text, body text,
   claim text, evidence text, usage_rights text, expires_on date, permission_basis text);
 create table client_briefs(id uuid primary key, client_id uuid, proof_asset_id uuid);
 create table client_media_assets(id uuid primary key, client_id uuid, brief_id uuid,
   review_status text, human_approved_at timestamptz, render_path text, storage_path text);
 create table proof_production_requests(id uuid primary key);
 create table proof_artifact_versions(id uuid primary key, client_id uuid, source_proof_id uuid,
   content_hash text, supported_claim text);
 create table proof_artifact_signoffs(artifact_version_id uuid primary key, client_id uuid);

 -- The agent registry and queue, as migration 03 defines the parts used here.
 create table agents(agent_key text primary key, name text not null, initials text not null,
   domain text, description text, requires_upstream text[] not null default '{}',
   config jsonb not null default '{}'::jsonb, paused boolean not null default false,
   updated_at timestamptz not null default now());
 create table agent_jobs(id uuid primary key default gen_random_uuid(),
   agent_key text not null references agents(agent_key), client_id uuid,
   status text not null default 'queued', params jsonb);

 -- Migration 205's manifest, in the shape 206 constrains.
 create table campaign_manifest_versions(
   id uuid primary key, campaign_id uuid not null, client_id uuid not null,
   version integer not null check (version > 0),
   acquisition_mode text not null check (acquisition_mode in ('organic','paid')),
   paid_platform text, plan_hash text not null,
   unique (campaign_id, version), unique (id, client_id));

 insert into clients values('${CLIENT}'),('${OTHER}');
 insert into profiles(id) values('${MANAGER}');
 insert into client_engine_settings(client_id, enabled) values('${CLIENT}', true);
 insert into client_campaigns values('${CAMPAIGN}','${CLIENT}');
 insert into campaign_manifest_versions values
   ('${MANIFEST}','${CAMPAIGN}','${CLIENT}',1,'organic',null,repeat('f',32));
 insert into client_proof_assets values('${PROOF}','${CLIENT}','A real result','body',
   'Cut their response time in half','They said it took half as long','approved',null,'Written consent 2026-02-01');
 insert into proof_artifact_versions values('${ARTIFACT}','${CLIENT}','${PROOF}',
   repeat('a',64),'Cut their response time in half');
 insert into proof_artifact_signoffs values('${ARTIFACT}','${CLIENT}');`);

  await db.exec(await sql("20261015230000_206_v6_action_approvals.sql"));
  await db.exec(await sql("20261019090000_218_proof_distribution_spine.sql"));
  await db.exec(await sql("20261022090000_230_campaign_action_executor.sql"));
  await db.exec(await sql("20261022100000_231_proof_placement_execution.sql"));

  // Everything that makes an action possible, so each test can switch off
  // exactly the one thing it is about.
  await db.exec(`
 update client_engine_settings
    set campaign_actions_enabled = true, proof_publishing_enabled = true;
 insert into client_proof_destinations(client_id, destination_key, enabled, account_ref)
   select '${CLIENT}', destination_key, true, 'accounts/1/locations/2' from proof_destinations;`);
  await asHuman();
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("asking for a campaign proof publication", () => {
  it("names every placement and payload hash in the scope a person decides on", async () => {
    const first = await draft("third_party_directory");
    const second = await draft("google_business_profile");
    const approval = await ask();

    const row = await one<{
      action_key: string;
      destination: string;
      scope: { placements: { placement_id: string; payload_hash: string }[]; placement_count: number };
      status: string;
    }>("select action_key, destination, scope, status from campaign_action_approvals where id = $1", [
      approval,
    ]);

    expect(row.action_key).toBe("proof_publish");
    expect(row.status).toBe("pending");
    expect(row.scope.placement_count).toBe(2);
    expect(row.scope.placements.map((p) => p.placement_id).sort()).toEqual([first, second].sort());
    // The hash of each payload, so the yes is about these words and not
    // about the idea of publishing proof.
    const hashes = await rows<{ id: string; payload_hash: string }>(
      "select id, payload_hash from proof_placements",
    );
    for (const placement of row.scope.placements) {
      expect(placement.payload_hash).toBe(
        hashes.find((h) => h.id === placement.placement_id)?.payload_hash,
      );
    }
    expect(row.destination).toContain("Third Party Directories");
  });

  it("hangs one pending placement approval off that single decision", async () => {
    await draft("third_party_directory");
    await draft("google_business_profile");
    const approval = await ask();

    const placementApprovals = await rows<{ status: string; campaign_action_approval_id: string }>(
      "select status, campaign_action_approval_id from proof_placement_approvals",
    );
    expect(placementApprovals).toHaveLength(2);
    for (const row of placementApprovals) {
      expect(row.status).toBe("pending");
      expect(row.campaign_action_approval_id).toBe(approval);
    }
    // And every placement is waiting on it rather than still a draft.
    expect(
      await rows("select 1 from proof_placements where status <> 'awaiting_approval'"),
    ).toHaveLength(0);
  });

  it("refuses when there is nothing drafted, no package, or an unsigned claim", async () => {
    await asService();
    await expect(
      db.query("select request_campaign_proof_publish_v6($1,$2)", [CAMPAIGN, MANAGER]),
    ).rejects.toThrow("no drafted proof placements");

    await db.exec("delete from campaign_manifest_versions");
    await asHuman();
    await draft("third_party_directory");
    await asService();
    await expect(
      db.query("select request_campaign_proof_publish_v6($1,$2)", [CAMPAIGN, MANAGER]),
    ).rejects.toThrow("no package yet");

    await db.exec(`insert into campaign_manifest_versions values
      ('${MANIFEST}','${CAMPAIGN}','${CLIENT}',1,'organic',null,repeat('f',32));`);
    await db.exec("delete from proof_artifact_signoffs");
    await expect(
      db.query("select request_campaign_proof_publish_v6($1,$2)", [CAMPAIGN, MANAGER]),
    ).rejects.toThrow("Approve the source and claim");
  });

  it("is the service role's to make, not a browser's", async () => {
    await draft("third_party_directory");
    await expect(
      db.query("select request_campaign_proof_publish_v6($1,$2)", [CAMPAIGN, MANAGER]),
    ).rejects.toThrow("Only the internal service");
  });
});

describe("what the executor may take", () => {
  it("takes nothing until a person has said yes", async () => {
    await draft("third_party_directory");
    const approval = await ask();
    // Pending requests are not in the view at all: it is a list of approved
    // actions and why each has not happened.
    expect(await rows("select 1 from campaign_action_due where approval_id = $1", [approval]))
      .toHaveLength(0);
    expect(await claim()).toHaveLength(0);
  });

  it("takes nothing when the client has not been switched on", async () => {
    await draft("third_party_directory");
    const approval = await approved();
    await db.exec("update client_engine_settings set campaign_actions_enabled = false");

    expect(await blocker(approval)).toBe("External campaign actions are off for this client.");
    expect(await claim()).toHaveLength(0);
  });

  it("says which actions have no executor rather than queueing them forever", async () => {
    await draft("third_party_directory");
    const approval = await approved();
    // Every action but proof publication ships without one. The approval
    // itself is legitimate; nothing can act on it.
    await db.exec(
      "update campaign_action_executors set supported = false where action_key = 'proof_publish'",
    );
    expect(await blocker(approval)).toBe("There is no executor for proof publish yet.");
    expect(await claim()).toHaveLength(0);
  });

  it("refuses an approval whose package was superseded after the yes", async () => {
    await draft("third_party_directory");
    const approval = await approved();
    await db.exec(`insert into campaign_manifest_versions values
      (gen_random_uuid(),'${CAMPAIGN}','${CLIENT}',2,'organic',null,repeat('e',32));`);

    expect(await blocker(approval)).toContain("superseded");
    expect(await claim()).toHaveLength(0);
  });

  it("is the service role's to claim", async () => {
    await draft("third_party_directory");
    await approved();
    await expect(db.query("select * from claim_campaign_actions(3)")).rejects.toThrow(
      "Only the internal service",
    );
  });

  it("claims an unblocked action once, and records the attempt", async () => {
    await draft("third_party_directory");
    const approval = await approved();
    expect(await blocker(approval)).toBeNull();

    const claimed = await claim();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ approval_id: approval, action_key: "proof_publish", attempt: 1 });

    const execution = await one<{ status: string; attempts: number; lease_until: string }>(
      "select status, attempts, lease_until from campaign_action_executions where approval_id = $1",
      [approval],
    );
    expect(execution).toMatchObject({ status: "executing", attempts: 1 });
    expect(execution.lease_until).toBeTruthy();
    expect(await blocker(approval)).toBe("Being executed now.");
    // A second sweep running while the first holds the lease takes nothing.
    expect(await claim()).toHaveLength(0);
    expect(
      await one<{ event: string }>(
        "select event from campaign_action_events order by occurred_at desc limit 1",
      ),
    ).toMatchObject({ event: "claimed" });
  });
});

describe("recording what happened", () => {
  it("will not claim an action that is already done", async () => {
    await draft("third_party_directory");
    const approval = await approved();
    const [claimed] = await claim();

    await asService();
    await db.query("select record_campaign_action_executed($1,$2,$3,$4)", [
      claimed!.execution_id,
      "ext-1",
      "https://example.test/post",
      JSON.stringify({ released: 1 }),
    ]);
    await asHuman();

    expect(await blocker(approval)).toBe("Already done.");
    expect(await claim()).toHaveLength(0);
    // And it cannot be walked back into being undone.
    await expect(
      db.query("update campaign_action_executions set status = 'executing' where approval_id = $1", [
        approval,
      ]),
    ).rejects.toThrow("already executed");
  });

  it("puts a retryable failure back, and abandons one that is not", async () => {
    await draft("third_party_directory");
    const approval = await approved();
    const [first] = await claim();

    await asService();
    await db.query("select record_campaign_action_failure($1,$2,true)", [
      first!.execution_id,
      "could not serialize access",
    ]);
    await asHuman();
    expect(await blocker(approval)).toBeNull();

    const [second] = await claim();
    expect(second).toMatchObject({ attempt: 2 });

    await asService();
    await db.query("select record_campaign_action_failure($1,$2,false)", [
      second!.execution_id,
      "the destination refused it",
    ]);
    await asHuman();

    // Not retried. A failure that did not obviously fail before the write is
    // a person's problem, not the sweep's.
    expect(await blocker(approval)).toContain("Abandoned after a failure");
    expect(await claim()).toHaveLength(0);
    expect(
      (await rows<{ event: string }>("select event from campaign_action_events order by occurred_at")).map(
        (r) => r.event,
      ),
    ).toEqual(["claimed", "failed", "claimed", "failed", "abandoned"]);
  });

  it("stops retrying after five goes", async () => {
    await draft("third_party_directory");
    const approval = await approved();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const [claimed] = await claim();
      expect(claimed, `attempt ${attempt} should have been claimable`).toBeTruthy();
      await asService();
      await db.query("select record_campaign_action_failure($1,$2,true)", [
        claimed!.execution_id,
        "still failing",
      ]);
      await asHuman();
    }
    expect(await blocker(approval)).toContain("Failed 5 times");
    expect(await claim()).toHaveLength(0);
  });

  it("abandons a lease that expired with the outcome unknown, rather than retrying it", async () => {
    await draft("third_party_directory");
    const approval = await approved();
    await claim();
    await db.exec(
      "update campaign_action_executions set lease_until = now() - interval '1 minute'",
    );

    await asService();
    const reaped = await one<{ reap_stale_campaign_action_claims: number }>(
      "select reap_stale_campaign_action_claims()",
    );
    await asHuman();
    expect(reaped.reap_stale_campaign_action_claims).toBe(1);

    const execution = await one<{ status: string; last_error: string }>(
      "select status, last_error from campaign_action_executions where approval_id = $1",
      [approval],
    );
    // The attempt may have reached the destination and died before recording
    // it, so this says go and look rather than trying again.
    expect(execution.status).toBe("abandoned");
    expect(execution.last_error).toContain("Check the destination");
    expect(await claim()).toHaveLength(0);
  });

  it("keeps an execution bound to the approval and version it was claimed under", async () => {
    await draft("third_party_directory");
    await approved();
    await claim();
    await expect(
      db.query("update campaign_action_executions set artifact_version_hash = $1", ["b".repeat(64)]),
    ).rejects.toThrow("cannot change which approval");
  });
});

describe("releasing the placements the yes was about", () => {
  it("sends each placement where its destination says it waits", async () => {
    const assisted = await draft("third_party_directory");
    const api = await draft("google_business_profile");
    await approved();
    const [claimed] = await claim();

    await asService();
    const result = await one<{ release_campaign_proof_placements: { released: number } }>(
      "select release_campaign_proof_placements($1)",
      [claimed!.execution_id],
    );
    await asHuman();
    expect(result.release_campaign_proof_placements.released).toBe(2);

    const statuses = Object.fromEntries(
      (await rows<{ id: string; status: string }>("select id, status from proof_placements")).map(
        (row) => [row.id, row.status],
      ),
    );
    // No API to call: a person places it. An API: the sweep does.
    expect(statuses[assisted]).toBe("awaiting_manual_placement");
    expect(statuses[api]).toBe("queued");

    // And the placement approvals carry the decision of the person who
    // approved the campaign action, not "the system".
    const decided = await rows<{ status: string; decided_by: string }>(
      "select status, decided_by from proof_placement_approvals",
    );
    expect(decided).toHaveLength(2);
    for (const row of decided) {
      expect(row.status).toBe("approved");
      expect(row.decided_by).toBe(MANAGER);
    }
  });

  it("skips proof whose permission ended between the yes and the act", async () => {
    await draft("third_party_directory");
    const approval = await approved();
    const [claimed] = await claim();

    // 218's trigger: rights coming off a proof is a list of things to take
    // down, and a placement waiting to go out is top of it.
    await db.exec("update client_proof_assets set usage_rights = 'not_cleared'");
    expect(
      await one<{ status: string }>("select status from proof_placements"),
    ).toMatchObject({ status: "retraction_required" });

    await asService();
    const result = await one<{
      release_campaign_proof_placements: { released: number; skipped: { reason: string }[] };
    }>("select release_campaign_proof_placements($1)", [claimed!.execution_id]);
    await asHuman();

    expect(result.release_campaign_proof_placements.released).toBe(0);
    expect(result.release_campaign_proof_placements.skipped[0]!.reason).toContain(
      "retraction_required",
    );
    // The approval stays approved and the placement stays down. Nothing was
    // published under a decision made about proof that is no longer usable.
    expect(await one<{ status: string }>("select status from proof_placements")).toMatchObject({
      status: "retraction_required",
    });
    void approval;
  });

  it("stops a revoked proof at the earliest state it can be in", async () => {
    // The gap 231 closes in 218. A drafted placement and one waiting for a
    // decision were both left standing when permission came off the proof
    // behind them, which left "what do we pull" with two wrong answers.
    await draft("third_party_directory");
    expect(await one<{ status: string }>("select status from proof_placements")).toMatchObject({
      status: "drafted",
    });
    await db.exec("update client_proof_assets set expires_on = current_date - 1");

    expect(await one<{ status: string }>("select status from proof_placements")).toMatchObject({
      status: "retraction_required",
    });
    expect(
      await one<{ detail: string }>(
        "select detail from proof_placement_events order by occurred_at desc limit 1",
      ),
    ).toMatchObject({ detail: "Permission for the source proof ended." });
  });

  it("refuses to release proof whose permission is gone even if its state says otherwise", async () => {
    await draft("third_party_directory");
    await approved();
    const [claimed] = await claim();

    // Forcing the state is how to reach the release path's own rights check:
    // the trigger would normally have moved this row already, and the point
    // of the check is that the release does not depend on it having.
    await db.exec("alter table client_proof_assets disable trigger proof_rights_retraction");
    await db.exec("update client_proof_assets set permission_basis = null");
    await db.exec("alter table client_proof_assets enable trigger proof_rights_retraction");

    await asService();
    const result = await one<{
      release_campaign_proof_placements: { released: number; skipped: { reason: string }[] };
    }>("select release_campaign_proof_placements($1)", [claimed!.execution_id]);
    await asHuman();

    expect(result.release_campaign_proof_placements.released).toBe(0);
    expect(result.release_campaign_proof_placements.skipped[0]!.reason).toContain(
      "no longer in place",
    );
  });

  it("skips a payload that drifted from the one named in the approval", async () => {
    await draft("third_party_directory");
    await approved();
    const [claimed] = await claim();

    // 218's guard makes this unreachable through the application: an
    // approved payload cannot be edited. Disabling it is how to prove the
    // release step would still refuse if it ever were.
    await db.exec("alter table proof_placements disable trigger proof_placement_status_guard");
    await db.exec(`update proof_placements set payload_hash = repeat('9',64)`);
    await db.exec("alter table proof_placements enable trigger proof_placement_status_guard");

    await asService();
    const result = await one<{
      release_campaign_proof_placements: { released: number; skipped: { reason: string }[] };
    }>("select release_campaign_proof_placements($1)", [claimed!.execution_id]);
    await asHuman();

    expect(result.release_campaign_proof_placements.released).toBe(0);
    expect(result.release_campaign_proof_placements.skipped[0]!.reason).toContain(
      "payload changed after approval",
    );
  });

  it("refuses to release under a decision that is not an approval", async () => {
    await draft("third_party_directory");
    const approval = await ask();
    await db.query("select decide_campaign_action_approval_v6($1,'rejected','Not these words.')", [
      approval,
    ]);
    // Nothing can be claimed, so forge the execution row the way only a
    // claim otherwise would, and check the release still refuses.
    await db.exec(`insert into campaign_action_executions
      (approval_id, client_id, campaign_id, action_key, artifact_version_hash, manifest_id)
      select id, client_id, campaign_id, action_key, artifact_version_hash, manifest_id
        from campaign_action_approvals where id = '${approval}'`);
    const execution = await one<{ id: string }>(
      "select id from campaign_action_executions where approval_id = $1",
      [approval],
    );

    await asService();
    await expect(
      db.query("select release_campaign_proof_placements($1)", [execution.id]),
    ).rejects.toThrow("is rejected, not approved");
    await asHuman();
  });

  it("is the service role's to perform", async () => {
    await draft("third_party_directory");
    await approved();
    const [claimed] = await claim();
    await expect(
      db.query("select release_campaign_proof_placements($1)", [claimed!.execution_id]),
    ).rejects.toThrow("Only the internal service");
  });
});

describe("the proof placement sweep", () => {
  it("waits for a credential before claiming a profile placement", async () => {
    await draft("google_business_profile");
    await approved();
    const [claimed] = await claim();
    await asService();
    await db.query("select release_campaign_proof_placements($1)", [claimed!.execution_id]);
    await asHuman();

    const placement = await one<{ placement_id: string; blocker: string }>(
      "select placement_id, blocker from proof_placement_due",
    );
    // The destination is supported and the transport exists; the client has
    // no connected Business Profile, and the view says exactly that.
    expect(placement.blocker).toBe("No usable google_business integration for this client.");

    await asService();
    expect(await rows("select * from claim_proof_placements(5)")).toHaveLength(0);
    expect(
      await one<{ enqueue_proof_placement_sweep: string | null }>(
        "select enqueue_proof_placement_sweep()",
      ),
    ).toMatchObject({ enqueue_proof_placement_sweep: null });
    await asHuman();
  });

  it("claims it once the credential is there, and queues exactly one sweep", async () => {
    await draft("google_business_profile");
    await approved();
    const [claimed] = await claim();
    await asService();
    await db.query("select release_campaign_proof_placements($1)", [claimed!.execution_id]);
    await db.exec("set test.integration = 'true'");

    expect(await one<{ blocker: string | null }>("select blocker from proof_placement_due"))
      .toMatchObject({ blocker: null });

    const job = await one<{ enqueue_proof_placement_sweep: string | null }>(
      "select enqueue_proof_placement_sweep()",
    );
    expect(job.enqueue_proof_placement_sweep).toBeTruthy();
    // One sweep at a time: a second call while the first is in flight queues
    // nothing rather than two leases for one question.
    expect(
      await one<{ enqueue_proof_placement_sweep: string | null }>(
        "select enqueue_proof_placement_sweep()",
      ),
    ).toMatchObject({ enqueue_proof_placement_sweep: null });

    const placements = await rows<{ provider: string; account_ref: string }>(
      "select * from claim_proof_placements(5)",
    );
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({
      provider: "google_business",
      account_ref: "accounts/1/locations/2",
    });
    await asHuman();
  });

  it("never claims a destination a person places by hand", async () => {
    await draft("third_party_directory");
    await approved();
    const [claimed] = await claim();
    await asService();
    await db.query("select release_campaign_proof_placements($1)", [claimed!.execution_id]);
    await db.exec("set test.integration = 'true'");

    expect(
      await one<{ blocker: string }>("select blocker from proof_placement_due"),
    ).toMatchObject({ blocker: "This destination is placed by proof_distribution, not by the sweep." });
    expect(await rows("select * from claim_proof_placements(5)")).toHaveLength(0);
    await asHuman();

    // It is waiting for a person, and 218's hand-placement path takes it.
    await db.query("select mark_proof_placement_placed_v6($1,$2)", [
      await one<{ id: string }>("select id from proof_placements").then((r) => r.id),
      "https://directory.test/listing/9",
    ]);
    expect(
      await one<{ status: string; external_url: string; placed_by: string }>(
        "select status, external_url, placed_by from proof_placements",
      ),
    ).toMatchObject({
      status: "placed",
      external_url: "https://directory.test/listing/9",
      placed_by: MANAGER,
    });
  });

  it("fails a stale claim without putting it back", async () => {
    await draft("google_business_profile");
    await approved();
    const [claimed] = await claim();
    await asService();
    await db.query("select release_campaign_proof_placements($1)", [claimed!.execution_id]);
    await db.exec("set test.integration = 'true'");
    await db.query("select * from claim_proof_placements(5)");
    await db.exec("update proof_placements set lease_until = now() - interval '1 minute'");

    const reaped = await one<{ reap_stale_proof_placement_claims: number }>(
      "select reap_stale_proof_placement_claims()",
    );
    expect(reaped.reap_stale_proof_placement_claims).toBe(1);
    const placement = await one<{ status: string; last_error: string }>(
      "select status, last_error from proof_placements",
    );
    // A retried review reply posts twice on a client's public profile, and
    // there is no unsending it.
    expect(placement.status).toBe("failed");
    expect(placement.last_error).toContain("Check the destination");
    await asHuman();
  });

  it("schedules the sweeps 218 deliberately left unscheduled", async () => {
    const jobs = (await rows<{ jobname: string }>("select jobname from cron.job")).map(
      (row) => row.jobname,
    );
    expect(jobs).toContain("proof-placement-sweep");
    expect(jobs).toContain("reap-stale-proof-placements");
    // 218 wrote the expiry sweep and left it unscheduled on purpose: "a
    // schedule that has never run is not evidence that it works".
    expect(jobs).toContain("sweep-expired-proof-placements");
    expect(jobs).toContain("campaign-action-sweep");
    expect(jobs).toContain("reap-stale-campaign-actions");
  });
});

describe("the guard that pins its own search path", () => {
  it("leaves no trigger function from 230 with a mutable path", async () => {
    // 224 took one of these off Supabase's linter for 218; 230 copied 218's
    // pattern and its omission, and 233 is the same one-line fix. Asserted
    // against the catalog rather than the file, so adding a guard without a
    // path fails here rather than on the linter a week later.
    await db.exec(await sql("20261022120000_233_the_action_event_guard_pins_its_path.sql"));
    const mutable = await rows<{ proname: string }>(`
      select p.proname from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and p.proname in ('guard_campaign_action_event_append_only',
                           'guard_campaign_action_execution')
         and not exists (
           select 1 from unnest(coalesce(p.proconfig, '{}')) as c
            where c like 'search_path=%')`);
    expect(mutable.map((row) => row.proname)).toEqual([]);
  });
});

describe("the grant sweep every definer migration has to end with", () => {
  it("is called by both migrations", async () => {
    // Supabase grants EXECUTE on every new function in `public` to anon,
    // and `revoke all ... from public` does not touch that grant. Migration
    // 161 exists because of it, and a migration that adds SECURITY DEFINER
    // functions without calling the sweep leaves them anon-callable. A
    // source assertion because the harness stubs the sweep itself: what
    // needs checking is that these two files call it.
    for (const file of [
      "20261022090000_230_campaign_action_executor.sql",
      "20261022100000_231_proof_placement_execution.sql",
    ]) {
      expect(await sql(file), `${file} must end with the grant sweep`).toContain(
        "select lock_down_definer_functions();",
      );
    }
  });
});

describe("the client switch", () => {
  it("records who turned campaign actions on, and keeps it on the way off", async () => {
    await db.exec("update client_engine_settings set campaign_actions_enabled = false");
    await db.query("select set_campaign_actions_enabled($1,true)", [CLIENT]);
    const on = await one<{ campaign_actions_enabled: boolean; campaign_actions_enabled_by: string }>(
      "select campaign_actions_enabled, campaign_actions_enabled_by from client_engine_settings",
    );
    expect(on).toMatchObject({ campaign_actions_enabled: true, campaign_actions_enabled_by: MANAGER });

    await db.query("select set_campaign_actions_enabled($1,false)", [CLIENT]);
    const off = await one<{ campaign_actions_enabled: boolean; campaign_actions_enabled_by: string }>(
      "select campaign_actions_enabled, campaign_actions_enabled_by from client_engine_settings",
    );
    // Who turned it on is worth more than when it was last turned off.
    expect(off).toMatchObject({
      campaign_actions_enabled: false,
      campaign_actions_enabled_by: MANAGER,
    });
  });

  it("refuses a client the caller cannot reach", async () => {
    await expect(db.query("select set_campaign_actions_enabled($1,true)", [OTHER])).rejects.toThrow(
      "Not permitted for this client",
    );
  });
});

describe("rule 6: a supported flag no handler backs", () => {
  /**
   * The four handlers the deployed runtime registers in HANDLERS. Kept here
   * as a literal rather than imported, because the point of the assertion is
   * that the database's claim and the runtime's registry agree, and importing
   * one to check the other proves nothing.
   */
  const REGISTERED = ["budget_change", "lead_message", "page_deploy", "proof_publish"];
  const ATTESTED = "92191b3e854abce86f9f5f8cd7810f86ba318b9d";

  /** Production's flag state before 280, which 230's seed does not reproduce. */
  async function asProductionBefore280(): Promise<void> {
    await db.exec(`
 update campaign_action_executors set supported = true
  where action_key in ('proof_publish','page_deploy','lead_message','budget_change',
                       'meta_ad_build','profile_update');
 update proof_destinations set supported = true;`);
  }

  const apply280 = async () =>
    db.exec(await sql("20261030170000_280_rule_six_supported_flags.sql"));

  it("leaves exactly the actions a handler is registered for", async () => {
    await asProductionBefore280();
    await apply280();

    const supported = await rows<{ action_key: string }>(
      "select action_key from campaign_action_executors where supported order by action_key",
    );
    expect(supported.map((row) => row.action_key)).toEqual(REGISTERED);
  });

  it("says what is missing rather than going quiet, for both corrected actions", async () => {
    await asProductionBefore280();
    await apply280();

    // The sentence a person reads is the due view's, and it is built from
    // this flag. What matters here is that the note names the gap.
    for (const key of ["meta_ad_build", "profile_update"]) {
      const row = await one<{ supported: boolean; note: string }>(
        "select supported, note from campaign_action_executors where action_key = $1",
        [key],
      );
      expect(row.supported).toBe(false);
      expect(row.note).toMatch(/registered|handler/i);
    }
  });

  it("stops claiming the two proof destinations the placer has no transport for", async () => {
    await asProductionBefore280();
    await apply280();

    const claimable = await rows<{ destination_key: string }>(
      "select destination_key from proof_destinations where supported and mode = 'api' order by 1",
    );
    // google_business is the one provider placer.ts has a branch for.
    expect(claimable.map((row) => row.destination_key)).toEqual(["google_business_profile"]);
  });

  it("attests every row it leaves supported to the deployed build", async () => {
    await asProductionBefore280();
    await apply280();

    const unattested = await rows<{ action_key: string }>(
      `select action_key from campaign_action_executors
        where supported and (handler_attested_sha is null or handler_attested_at is null)`,
    );
    expect(unattested).toEqual([]);
    const attested = await one<{ handler_attested_sha: string }>(
      "select handler_attested_sha from campaign_action_executors where action_key = 'proof_publish'",
    );
    expect(attested.handler_attested_sha).toBe(ATTESTED);
  });

  it("refuses a later flag flip that names no build", async () => {
    await asProductionBefore280();
    await apply280();

    // The next person to do what 239 and 254 did. The constraint is the
    // whole point: there is no way to advertise support quietly.
    await expect(
      db.exec("update campaign_action_executors set supported = true where action_key = 'meta_ad_build'"),
    ).rejects.toThrow(/campaign_action_executors_supported_needs_attestation/);
  });

  it("refuses a build identity that is not a full commit", async () => {
    await asProductionBefore280();
    await apply280();

    await expect(
      db.exec(`update campaign_action_executors
                  set supported = true, handler_attested_sha = '92191b3', handler_attested_at = now()
                where action_key = 'meta_ad_build'`),
    ).rejects.toThrow(/campaign_action_executors_attested_sha_shape/);
  });
});
