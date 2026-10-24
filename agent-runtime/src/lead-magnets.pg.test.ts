import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 235 and 236 together, against a real Postgres.
 *
 * The promise this module makes to a stranger is narrow and absolute: you
 * will receive exactly the file somebody approved, exactly once. So the
 * tests are about the ways that promise breaks.
 *
 *   - the file is re-exported after approval
 *   - the message is rewritten after approval
 *   - the approval is revoked while sends are queued
 *   - the client switch is off
 *   - the same opt-in is processed twice
 *   - a send dies without recording an outcome
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const CAMPAIGN = "66666666-6666-4666-8666-666666666666";
const TOKEN = "a".repeat(64);
const WORDING = "I agree to Harbour Home emailing me the guide and contacting me about it.";

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

/** A magnet with one version, and a form that promises it. */
async function magnet(over: { channel?: string } = {}) {
  const m = await one<{ id: string }>(
    `insert into lead_magnets (client_id, name, objective, format, campaign_id)
     values ($1,'Garage conversion cost guide','Turn survey curiosity into a booking','pdf_guide',$2)
     returning id`,
    [CLIENT, CAMPAIGN],
  );
  const v = await one<{ id: string }>(
    `insert into lead_magnet_versions (magnet_id, client_id, version, storage_path,
       content_sha256, file_bytes, media_type, delivery_channel, delivery_subject, delivery_body)
     values ($1,$2,1,'magnets/cost-guide-v1.pdf',$3,284113,'application/pdf',$4,
       'Your garage conversion cost guide','Here it is, as promised.') returning id`,
    [m.id, CLIENT, "b".repeat(64), over.channel ?? "email"],
  );
  const e = await one<{ id: string }>(
    `select id from create_lead_capture_endpoint_v6($1,'magnet_optin',$2,$3,$4)`,
    [CLIENT, TOKEN, WORDING, CAMPAIGN],
  );
  await db.query("select set_lead_capture_enabled_v6($1,true)", [e.id]);
  await db.query("update lead_capture_endpoints set magnet_version_id = $1 where id = $2", [
    v.id,
    e.id,
  ]);
  return { magnetId: m.id, versionId: v.id, endpointId: e.id };
}

/** Ask, and have a person say yes. */
async function approve(versionId: string) {
  const approval = await one<{ request_lead_magnet_approval_v6: string }>(
    "select request_lead_magnet_approval_v6($1)",
    [versionId],
  );
  const id = approval.request_lead_magnet_approval_v6;
  await db.query("select decide_lead_magnet_approval_v6($1,true)", [id]);
  return id;
}

/** Somebody opts in. */
async function optIn(key = "sub-1", email = "jay@example.test") {
  await asService();
  await db.query(`select capture_lead_v6($1,$2,'Jay Okafor',$3,null,null,true,'{}'::jsonb)`, [
    TOKEN,
    key,
    email,
  ]);
  await asHuman();
}

async function blocker(): Promise<string | null> {
  const row = await one<{ blocker: string | null }>("select blocker from lead_magnet_due limit 1");
  return row?.blocker ?? null;
}

async function claim(limit = 5) {
  await asService();
  const claimed = await rows<{ delivery_id: string; recipient: string; content_sha256: string }>(
    "select * from claim_lead_magnet_deliveries($1)",
    [limit],
  );
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
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end$$;

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
 create table campaigns(id uuid primary key);
 create table client_campaigns(id uuid primary key, client_id uuid, unique (id, client_id));
 create table client_pages(id uuid primary key, client_id uuid);
 create table client_media_assets(id uuid primary key);
 create table scheduled_posts(id uuid primary key);
 create table team_members(id uuid primary key);
 create table client_sales_agents(id uuid primary key);
 create table service_offers(id uuid primary key, client_id uuid, unique (id, client_id));
 create table service_offer_versions(id uuid primary key, client_id uuid, unique (id, client_id));
 create table agents(agent_key text primary key, name text not null, initials text not null,
   domain text, description text, requires_upstream text[] not null default '{}',
   config jsonb not null default '{}'::jsonb, paused boolean not null default false,
   updated_at timestamptz not null default now());
 create table agent_jobs(id uuid primary key default gen_random_uuid(),
   agent_key text not null references agents(agent_key), client_id uuid,
   status text not null default 'queued', params jsonb);
 create table client_engine_settings(client_id uuid primary key references clients(id) on delete cascade,
   enabled boolean not null default false);

 create table client_leads(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text, contact text, source text, notes text,
   pipeline_stage pipeline_stage not null default 'first_touch',
   email text, phone text,
   stage lead_stage not null default 'lead',
   stage_at timestamptz not null default now(), lost_reason text,
   owner_member_id uuid references team_members(id) on delete set null,
   next_action text, next_action_due date,
   opportunity_value numeric(12,2), sale_value numeric(12,2), cash_collected numeric(12,2),
   appointment_at timestamptz, appointment_outcome text,
   source_channel text,
   source_page_id uuid references client_pages(id) on delete set null,
   source_asset_id uuid references client_media_assets(id) on delete set null,
   source_post_id uuid references scheduled_posts(id) on delete set null,
   source_campaign_id uuid references campaigns(id) on delete set null,
   source_sales_agent_id uuid references client_sales_agents(id) on delete set null,
   created_by uuid references profiles(id) on delete set null,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now());

 create table lead_events(
   id uuid primary key default gen_random_uuid(),
   lead_id uuid not null references client_leads(id) on delete cascade,
   client_id uuid not null references clients(id) on delete cascade,
   kind text not null check (kind in ('note','conversation','stage_change','appointment','outcome')),
   body text, from_stage lead_stage, to_stage lead_stage,
   occurred_at timestamptz not null default now(),
   created_by uuid references profiles(id) on delete set null,
   created_at timestamptz not null default now());

 insert into clients values('${CLIENT}');
 insert into profiles values('${MANAGER}');
 insert into client_campaigns values('${CAMPAIGN}','${CLIENT}');
 insert into client_engine_settings(client_id) values('${CLIENT}');`);

  await db.exec(await sql("20261024090000_235_a_lead_can_arrive_from_outside.sql"));
  await db.exec(await sql("20261024100000_236_lead_magnets.sql"));
  await db.exec(`update client_engine_settings set lead_magnet_delivery_enabled = true;`);
  await asHuman();
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("owing somebody a file", () => {
  it("queues exactly one delivery when an opt-in is promoted", async () => {
    const { versionId } = await magnet();
    await approve(versionId);
    await optIn();

    const delivery = await one<{ status: string; recipient: string; channel: string }>(
      "select status, recipient, channel from lead_magnet_deliveries",
    );
    expect(delivery).toMatchObject({
      status: "queued",
      recipient: "jay@example.test",
      channel: "email",
    });
    expect(await blocker()).toBeNull();
  });

  it("owes nothing when the form promises nothing", async () => {
    const { endpointId, versionId } = await magnet();
    await approve(versionId);
    await db.query("update lead_capture_endpoints set magnet_version_id = null where id = $1", [
      endpointId,
    ]);
    await optIn();
    // A plain enquiry form still makes a lead, it just owes no file.
    expect(await rows("select 1 from client_leads")).toHaveLength(1);
    expect(await rows("select 1 from lead_magnet_deliveries")).toHaveLength(0);
  });

  it("sends once however many times the opt-in is reprocessed", async () => {
    const { versionId } = await magnet();
    await approve(versionId);
    await optIn("same-key");
    await optIn("same-key");
    // Re-promoting by hand must not owe a second copy either.
    await db.exec("update lead_submissions set status = 'received'");
    await db.exec("update lead_submissions set status = 'promoted'");
    expect(await rows("select 1 from lead_magnet_deliveries")).toHaveLength(1);
  });
});

describe("the gate on the file", () => {
  it("will not send before anybody approves it", async () => {
    await magnet();
    await optIn();
    expect(await blocker()).toBe("Nobody has approved this magnet.");
    expect(await claim()).toHaveLength(0);
  });

  it("stops the queue when the file is re-exported after approval", async () => {
    const { versionId } = await magnet();
    await approve(versionId);
    await optIn();
    expect(await blocker()).toBeNull();

    // A version is immutable, so a re-export is a new row — but the endpoint
    // could be pointed at it, and the old approval must not cover it.
    await expect(
      db.query("update lead_magnet_versions set content_sha256 = $1 where id = $2", [
        "c".repeat(64),
        versionId,
      ]),
    ).rejects.toThrow("immutable");

    const fresh = await one<{ id: string }>(
      `insert into lead_magnet_versions (magnet_id, client_id, version, storage_path,
         content_sha256, file_bytes, media_type, delivery_channel, delivery_subject, delivery_body)
       select magnet_id, client_id, 2, 'magnets/cost-guide-v2.pdf', $1, 300000, media_type,
              delivery_channel, delivery_subject, delivery_body
         from lead_magnet_versions where id = $2 returning id`,
      ["c".repeat(64), versionId],
    );
    await db.query("update lead_capture_endpoints set magnet_version_id = $1", [fresh.id]);
    await optIn("sub-2", "sam@example.test");

    const blockers = await rows<{ blocker: string | null; magnet_version_id: string }>(
      "select blocker, magnet_version_id from lead_magnet_due order by blocker nulls first",
    );
    // The approved version still goes; the new one waits for its own decision.
    expect(blockers.find((b) => b.magnet_version_id === versionId)?.blocker).toBeNull();
    expect(blockers.find((b) => b.magnet_version_id === fresh.id)?.blocker).toBe(
      "Nobody has approved this magnet.",
    );
  });

  it("refuses a decision made about words that have since changed", async () => {
    const { versionId } = await magnet();
    const approval = await one<{ request_lead_magnet_approval_v6: string }>(
      "select request_lead_magnet_approval_v6($1)",
      [versionId],
    );
    // The hash covers the message as well as the file, so editing the subject
    // between asking and deciding invalidates the request.
    await db.exec("alter table lead_magnet_versions disable trigger lead_magnet_versions_immutable");
    await db.query("update lead_magnet_versions set delivery_subject = 'Something else' where id = $1", [
      versionId,
    ]);
    await db.exec("alter table lead_magnet_versions enable trigger lead_magnet_versions_immutable");

    await expect(
      db.query("select decide_lead_magnet_approval_v6($1,true)", [
        approval.request_lead_magnet_approval_v6,
      ]),
    ).rejects.toThrow("changed after approval was requested");
  });

  it("requires a reason to reject, and records who decided", async () => {
    const { versionId } = await magnet();
    const approval = await one<{ request_lead_magnet_approval_v6: string }>(
      "select request_lead_magnet_approval_v6($1)",
      [versionId],
    );
    const id = approval.request_lead_magnet_approval_v6;
    await expect(
      db.query("select decide_lead_magnet_approval_v6($1,false,null)", [id]),
    ).rejects.toThrow("Say why it was rejected");
    await db.query("select decide_lead_magnet_approval_v6($1,false,$2)", [
      id,
      "The price in it is out of date.",
    ]);
    expect(
      await one<{ status: string; decided_by: string }>(
        "select status, decided_by from lead_magnet_approvals where id = $1",
        [id],
      ),
    ).toMatchObject({ status: "rejected", decided_by: MANAGER });
  });

  it("refuses a second request for a version that is already live", async () => {
    const { versionId } = await magnet();
    const approvalId = await approve(versionId);
    // Immutable bytes, already signed: asking again is the same question.
    await expect(
      db.query("select request_lead_magnet_approval_v6($1)", [versionId]),
    ).rejects.toThrow("already approved");

    // Revoking reopens it, because the reason for stopping may have been
    // fixed somewhere other than the file.
    await db.query("select revoke_lead_magnet_approval_v6($1,$2)", [approvalId, "Paused it."]);
    await expect(
      db.query("select request_lead_magnet_approval_v6($1)", [versionId]),
    ).resolves.toBeTruthy();
  });
});

describe("taking it back", () => {
  it("cancels what has not gone and leaves what has", async () => {
    const { versionId } = await magnet();
    const approvalId = await approve(versionId);
    await optIn("gone", "sent@example.test");
    const [claimed] = await claim();
    await asService();
    await db.query("select record_lead_magnet_sent($1,$2)", [claimed!.delivery_id, "resend-1"]);
    await asHuman();

    await optIn("waiting", "queued@example.test");
    await db.query("select revoke_lead_magnet_approval_v6($1,$2)", [
      approvalId,
      "The guide quotes last year's prices.",
    ]);

    const states = await rows<{ status: string; recipient: string; last_error: string | null }>(
      "select status, recipient, last_error from lead_magnet_deliveries order by created_at",
    );
    // What is out cannot be unsent, and is not rewritten to pretend otherwise.
    expect(states[0]).toMatchObject({ status: "sent", recipient: "sent@example.test" });
    expect(states[1]!.status).toBe("cancelled");
    expect(states[1]!.last_error).toContain("revoked");
    expect(await claim()).toHaveLength(0);
  });

  it("needs a reason, and only works on a live approval", async () => {
    const { versionId } = await magnet();
    const approvalId = await approve(versionId);
    await expect(
      db.query("select revoke_lead_magnet_approval_v6($1,null)", [approvalId]),
    ).rejects.toThrow("Say why");
    await db.query("select revoke_lead_magnet_approval_v6($1,$2)", [approvalId, "Wrong file."]);
    await expect(
      db.query("select revoke_lead_magnet_approval_v6($1,$2)", [approvalId, "Again."]),
    ).rejects.toThrow("Only an approved magnet");
  });
});

describe("the client switch", () => {
  it("holds everything while it is off", async () => {
    const { versionId } = await magnet();
    await approve(versionId);
    await optIn();
    await db.exec("update client_engine_settings set lead_magnet_delivery_enabled = false");

    expect(await blocker()).toBe("Magnet delivery is off for this client.");
    expect(await claim()).toHaveLength(0);
    await asService();
    expect(
      await one<{ enqueue_lead_magnet_sweep: string | null }>("select enqueue_lead_magnet_sweep()"),
    ).toMatchObject({ enqueue_lead_magnet_sweep: null });
    await asHuman();
  });

  it("records who turned it on and keeps it on the way off", async () => {
    await db.query("select set_lead_magnet_delivery_enabled($1,true)", [CLIENT]);
    await db.query("select set_lead_magnet_delivery_enabled($1,false)", [CLIENT]);
    expect(
      await one<{ lead_magnet_delivery_enabled: boolean; lead_magnet_delivery_enabled_by: string }>(
        "select lead_magnet_delivery_enabled, lead_magnet_delivery_enabled_by from client_engine_settings",
      ),
    ).toMatchObject({
      lead_magnet_delivery_enabled: false,
      lead_magnet_delivery_enabled_by: MANAGER,
    });
  });
});

describe("sending", () => {
  it("hands the courier the file and the exact words, and records the provider reference", async () => {
    const { versionId } = await magnet();
    await approve(versionId);
    await optIn();

    const [claimed] = await claim();
    expect(claimed).toMatchObject({
      recipient: "jay@example.test",
      content_sha256: "b".repeat(64),
    });
    expect(await blocker()).toBe("Being sent now.");

    await asService();
    await db.query("select record_lead_magnet_sent($1,$2)", [claimed!.delivery_id, "resend-42"]);
    await asHuman();

    expect(
      await one<{ status: string; provider_ref: string }>(
        "select status, provider_ref from lead_magnet_deliveries",
      ),
    ).toMatchObject({ status: "sent", provider_ref: "resend-42" });
    expect(await blocker()).toBe("Already sent.");
    expect(await claim()).toHaveLength(0);

    // And it is on the lead's own history, where somebody would look.
    const events = await rows<{ body: string }>("select body from lead_events order by occurred_at");
    expect(events.some((e) => e.body.includes("Lead magnet sent by email"))).toBe(true);
  });

  it("requeues a transport fault and stops on anything else", async () => {
    const { versionId } = await magnet();
    await approve(versionId);
    await optIn();

    const [first] = await claim();
    await asService();
    await db.query("select record_lead_magnet_failure($1,$2,true)", [
      first!.delivery_id,
      "provider timed out",
    ]);
    await asHuman();
    expect(await blocker()).toBeNull();

    const [second] = await claim();
    await asService();
    await db.query("select record_lead_magnet_failure($1,$2,false)", [
      second!.delivery_id,
      "the address was rejected",
    ]);
    await asHuman();
    expect(
      await one<{ status: string; attempts: number }>(
        "select status, attempts from lead_magnet_deliveries",
      ),
    ).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("stops after five goes rather than hammering a provider", async () => {
    const { versionId } = await magnet();
    await approve(versionId);
    await optIn();
    for (let i = 1; i <= 5; i += 1) {
      const [claimed] = await claim();
      expect(claimed, `attempt ${i} should have been claimable`).toBeTruthy();
      await asService();
      await db.query("select record_lead_magnet_failure($1,$2,true)", [
        claimed!.delivery_id,
        "still failing",
      ]);
      await asHuman();
    }
    expect(await blocker()).toContain("Failed 5 times");
    expect(await claim()).toHaveLength(0);
  });

  it("fails a send that died without saying what happened", async () => {
    const { versionId } = await magnet();
    await approve(versionId);
    await optIn();
    await claim();
    await db.exec("update lead_magnet_deliveries set lease_until = now() - interval '1 minute'");

    await asService();
    const reaped = await one<{ reap_stale_lead_magnet_deliveries: number }>(
      "select reap_stale_lead_magnet_deliveries()",
    );
    await asHuman();
    expect(reaped.reap_stale_lead_magnet_deliveries).toBe(1);
    expect(
      await one<{ status: string; last_error: string }>(
        "select status, last_error from lead_magnet_deliveries",
      ),
    ).toMatchObject({ status: "failed" });
    expect(
      (await one<{ last_error: string }>("select last_error from lead_magnet_deliveries")).last_error,
    ).toContain("Check the provider");
  });

  it("is the internal service's to claim and to record", async () => {
    const { versionId } = await magnet();
    await approve(versionId);
    await optIn();
    await expect(db.query("select * from claim_lead_magnet_deliveries(5)")).rejects.toThrow(
      "Only the internal service",
    );
  });

  it("schedules its own sweep and reaper", async () => {
    const jobs = (await rows<{ jobname: string }>("select jobname from cron.job")).map(
      (r) => r.jobname,
    );
    expect(jobs).toContain("lead-magnet-sweep");
    expect(jobs).toContain("reap-stale-lead-magnet-deliveries");
  });

  it("ends with the grant sweep", async () => {
    expect(await sql("20261024100000_236_lead_magnets.sql")).toContain(
      "select lock_down_definer_functions();",
    );
  });
});
