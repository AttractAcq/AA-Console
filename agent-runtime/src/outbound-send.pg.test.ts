import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 248 and 249 against a real Postgres.
 *
 * This is the path that writes to strangers, so the tests are mostly about
 * refusals. The ones that matter most:
 *
 *   an approval is bound to a version, so changing a word loses it
 *   consent is required and suppression cannot be overridden by anything
 *   suppression is re-checked at the claim, because the window between
 *     queueing and sending is exactly when somebody unsubscribes
 *   a revoked approval cancels what has not gone yet
 *   rendering refuses rather than sending "Hi {{first_name}},"
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}
async function refusal(q: string, p: unknown[] = []): Promise<string> {
  try { await db.query(q, p); } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`Expected a refusal from: ${q}`);
}
const asService = () => db.query(`select set_config('test.role','service_role',false)`);
const asUser = () => db.query(`select set_config('test.role','authenticated',false)`);

/** A template on a channel, with one version. */
async function template(
  channel = "email",
  body = "Hi {{first_name}}, about your quote.",
  purpose = "objection",
): Promise<{ templateId: string; versionId: string }> {
  const t = await one<{ id: string }>(
    `select id from create_message_template_v6($1,'Objection one',$2,$3)`,
    [CLIENT, purpose, channel]);
  const v = await one<{ id: string }>(
    `select id from add_message_template_version_v6($1,'About your quote',$2)`,
    [t.id, body]);
  return { templateId: t.id, versionId: v.id };
}
async function approve(versionId: string): Promise<string> {
  const a = await one<{ id: string }>(
    `select id from approve_message_template_v6($1,'They asked for a quote and consented to follow-up')`,
    [versionId]);
  return a.id;
}
async function enableSending(on = true): Promise<void> {
  await db.query(
    `insert into client_engine_settings (client_id, outbound_messaging_enabled)
     values ($1,$2) on conflict (client_id) do update
       set outbound_messaging_enabled = excluded.outbound_messaging_enabled`, [CLIENT, on]);
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select coalesce(current_setting('test.role',true),'authenticated')$$;
 create function auth.uid() returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
 create function can_access_client(uuid) returns boolean language sql as $$select $1='${CLIENT}'::uuid$$;
 create function active_video_approval_manager(uuid) returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_campaigns(id uuid primary key default gen_random_uuid(), client_id uuid);
 create table client_engine_settings(client_id uuid primary key);
 create table proof_destinations(destination_key text primary key, supported boolean, note text);
 insert into proof_destinations values ('email_sms_nurture', false, 'x');

 create table client_leads(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id),
   name text, email text, phone text,
   consent_given_at timestamptz, consent_wording text, consent_evidence text,
   source_client_campaign_id uuid, dedupe_key text,
   is_probe boolean not null default false,
   created_at timestamptz not null default now());

 insert into clients values('${CLIENT}');
 insert into profiles values('${MANAGER}');
 insert into client_leads (id, client_id, name, email, consent_given_at, consent_wording, dedupe_key)
   values ('${LEAD}','${CLIENT}','Priya Raman','priya@example.com', now(),
           'We may contact you about your quote', 'email:priya@example.com');`);

  await db.exec(await sql("20261025130000_248_a_message_can_be_sent_to_a_person.sql"));
  await db.exec(await sql("20261025140000_249_the_send_path.sql"));
});

afterAll(async () => { await db?.close(); });

describe("the channel registry", () => {
  it("has a transport only for email", async () => {
    const got = await rows<{ channel_key: string; supported: boolean }>(
      `select channel_key, supported from message_channels order by channel_key`);
    const supported = got.filter((c) => c.supported).map((c) => c.channel_key);
    expect(supported).toEqual(["email"]);
  });

  it("records that Meta's channels cannot start a conversation", async () => {
    const got = await rows<{ channel_key: string }>(
      `select channel_key from message_channels where not can_initiate order by channel_key`);
    expect(got.map((c) => c.channel_key)).toEqual(["instagram_dm", "messenger", "whatsapp"]);
  });

  it("refuses to approve a version on a channel with no transport", async () => {
    const { versionId } = await template("sms", "Hi {{first_name}}.");
    expect(await refusal(`select approve_message_template_v6($1,'basis')`, [versionId]))
      .toContain("no transport for sms");
  });
});

describe("the approval is bound to the version", () => {
  it("refuses to queue without a standing approval", async () => {
    const { versionId } = await template();
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]))
      .toContain("No standing approval");
  });

  it("loses the approval when a single word changes", async () => {
    const { templateId, versionId } = await template();
    await approve(versionId);
    await db.query(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]);

    const v2 = await one<{ id: string }>(
      `select id from add_message_template_version_v6($1,'About your quote','Hi {{first_name}}, about your estimate.')`,
      [templateId]);
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [LEAD, v2.id]))
      .toContain("A changed word is a new version");
  });

  it("will not let a version be edited in place", async () => {
    const { versionId } = await template();
    expect(await refusal(`update message_template_versions set body = 'Something else' where id = $1`,
      [versionId])).toContain("cannot be edited");
  });

  it("requires a stated basis for believing consent covers it", async () => {
    const { versionId } = await template();
    expect(await refusal(`select approve_message_template_v6($1,'   ')`, [versionId]))
      .toContain("Say why the consent");
  });

  it("cancels what has not gone when the approval is revoked", async () => {
    const { versionId } = await template();
    const approvalId = await approve(versionId);
    const m = await one<{ id: string }>(
      `select id from queue_lead_message_v6($1,$2)`, [LEAD, versionId]);
    await db.query(`select revoke_message_template_approval_v6($1,'Wrong price in the copy')`,
      [approvalId]);
    const row = await one<{ status: string; last_error: string }>(
      `select status, last_error from outbound_messages where id = $1`, [m.id]);
    expect(row.status).toBe("cancelled");
    expect(row.last_error).toContain("Wrong price in the copy");
  });
});

describe("consent and suppression", () => {
  it("refuses a lead with no recorded consent", async () => {
    const { versionId } = await template();
    await approve(versionId);
    await db.query(`update client_leads set consent_given_at = null where id = $1`, [LEAD]);
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]))
      .toContain("no recorded consent");
  });

  it("refuses a suppressed person, with no way to override it", async () => {
    const { versionId } = await template();
    await approve(versionId);
    await db.query(`select suppress_lead_v6($1,$2,'unsubscribed','Clicked the link')`,
      [CLIENT, "email:priya@example.com"]);
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]))
      .toContain("suppressed for this client");
    // And being an admin with the switch on changes nothing.
    await enableSending(true);
    await db.query(`select set_config('test.admin','true',false)`);
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]))
      .toContain("suppressed for this client");
  });

  it("re-checks suppression at the claim, not just at the queue", async () => {
    const { versionId } = await template();
    await approve(versionId);
    await enableSending(true);
    await db.query(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]);

    // The window that matters: queued, then they unsubscribe.
    await db.query(`select suppress_lead_v6($1,$2,'unsubscribed',null)`,
      [CLIENT, "email:priya@example.com"]);
    await asService();
    expect(await rows(`select * from claim_outbound_messages(10)`)).toHaveLength(0);
  });

  it("copies the consent onto the message rather than joining it", async () => {
    const { versionId } = await template();
    await approve(versionId);
    const m = await one<{ id: string }>(
      `select id from queue_lead_message_v6($1,$2)`, [LEAD, versionId]);
    // The lead's consent wording later changes; the message keeps what was true.
    await db.query(`update client_leads set consent_wording = 'Something else' where id = $1`, [LEAD]);
    const row = await one<{ consent_wording: string }>(
      `select consent_wording from outbound_messages where id = $1`, [m.id]);
    expect(row.consent_wording).toBe("We may contact you about your quote");
  });

  it("refuses to message a probe lead", async () => {
    const { versionId } = await template();
    await approve(versionId);
    const probe = await one<{ id: string }>(
      `insert into client_leads (client_id, name, email, consent_given_at, dedupe_key, is_probe)
       values ($1,'AA Probe','probe@example.com',now(),'email:probe@example.com',true) returning id`,
      [CLIENT]);
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [probe.id, versionId]))
      .toContain("probe lead");
  });
});

describe("rendering refuses rather than sending a hole", () => {
  it("names the placeholder it could not fill", async () => {
    const { versionId } = await template("email", "Hi {{first_name}}, your {{job_type}} quote.");
    await approve(versionId);
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]))
      .toContain("{{job_type}}");
  });

  it("refuses to greet nobody when the name is missing", async () => {
    const { versionId } = await template();
    await approve(versionId);
    await db.query(`update client_leads set name = null where id = $1`, [LEAD]);
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]))
      .toContain("greets nobody");
  });

  it("renders the first name from the lead", async () => {
    const { versionId } = await template();
    await approve(versionId);
    const m = await one<{ id: string }>(
      `select id from queue_lead_message_v6($1,$2)`, [LEAD, versionId]);
    const row = await one<{ rendered_body: string; address: string }>(
      `select rendered_body, address from outbound_messages where id = $1`, [m.id]);
    expect(row.rendered_body).toBe("Hi Priya, about your quote.");
    expect(row.address).toBe("priya@example.com");
  });

  it("requires a subject for an email version", async () => {
    const t = await one<{ id: string }>(
      `select id from create_message_template_v6($1,'No subject','objection','email')`, [CLIENT]);
    expect(await refusal(`select add_message_template_version_v6($1,null,'Body')`, [t.id]))
      .toContain("needs a subject");
  });
});

describe("caps and idempotency", () => {
  it("sends one message per lead per version, however many times it is asked", async () => {
    const { versionId } = await template();
    await approve(versionId);
    const first = await one<{ id: string }>(
      `select id from queue_lead_message_v6($1,$2)`, [LEAD, versionId]);
    const second = await one<{ id: string }>(
      `select id from queue_lead_message_v6($1,$2)`, [LEAD, versionId]);
    expect(second.id).toBe(first.id);
    expect(await rows(`select 1 from outbound_messages`)).toHaveLength(1);
  });

  it("stops at the client's daily cap", async () => {
    const { templateId } = await template();
    await db.query(
      `insert into client_engine_settings (client_id, outbound_daily_cap) values ($1,1)
       on conflict (client_id) do update set outbound_daily_cap = 1`, [CLIENT]);
    const v1 = await one<{ id: string }>(
      `select id from add_message_template_version_v6($1,'s','Hi {{first_name}}, one.')`, [templateId]);
    const v2 = await one<{ id: string }>(
      `select id from add_message_template_version_v6($1,'s','Hi {{first_name}}, two.')`, [templateId]);
    await approve(v1.id);
    await approve(v2.id);
    await db.query(`select queue_lead_message_v6($1,$2)`, [LEAD, v1.id]);
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [LEAD, v2.id]))
      .toContain("daily message cap of 1 is spent");
  });
});

describe("the sweep", () => {
  async function queued(): Promise<string> {
    const { versionId } = await template();
    await approve(versionId);
    const m = await one<{ id: string }>(
      `select id from queue_lead_message_v6($1,$2)`, [LEAD, versionId]);
    return m.id;
  }

  it("claims nothing while the client switch is off", async () => {
    await queued();
    await enableSending(false);
    await asService();
    expect(await rows(`select * from claim_outbound_messages(10)`)).toHaveLength(0);
  });

  it("claims a message once the switch is on, and leases it", async () => {
    const id = await queued();
    await enableSending(true);
    await asService();
    const claimed = await rows<{ message_id: string; rendered_body: string }>(
      `select * from claim_outbound_messages(10)`);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.message_id).toBe(id);
    expect(claimed[0]!.rendered_body).toBe("Hi Priya, about your quote.");
    // A second sweep must not pick it up again while the lease holds.
    expect(await rows(`select * from claim_outbound_messages(10)`)).toHaveLength(0);
  });

  it("records a send", async () => {
    const id = await queued();
    await enableSending(true);
    await asService();
    await db.query(`select * from claim_outbound_messages(10)`);
    await db.query(`select record_outbound_message_sent($1,'resend-abc')`, [id]);
    const row = await one<{ status: string; external_id: string }>(
      `select status, external_id from outbound_messages where id = $1`, [id]);
    expect(row.status).toBe("sent");
    expect(row.external_id).toBe("resend-abc");
  });

  it("returns a retryable failure to the queue and gives up after five", async () => {
    const id = await queued();
    await enableSending(true);
    await asService();
    for (let i = 0; i < 5; i += 1) {
      await db.query(`select * from claim_outbound_messages(10)`);
      await db.query(`select record_outbound_message_failure($1,'Provider timed out',true)`, [id]);
    }
    const row = await one<{ status: string; attempts: number }>(
      `select status, attempts from outbound_messages where id = $1`, [id]);
    expect(Number(row.attempts)).toBe(5);
    expect(row.status).toBe("failed");
  });

  it("fails a non-retryable error immediately", async () => {
    const id = await queued();
    await enableSending(true);
    await asService();
    await db.query(`select * from claim_outbound_messages(10)`);
    await db.query(`select record_outbound_message_failure($1,'That address is invalid',false)`, [id]);
    expect((await one<{ status: string }>(
      `select status from outbound_messages where id = $1`, [id])).status).toBe("failed");
  });

  it("releases a claim whose worker died", async () => {
    const id = await queued();
    await enableSending(true);
    await asService();
    await db.query(`select * from claim_outbound_messages(10)`);
    await db.query(
      `update outbound_messages set lease_until = now() - interval '20 minutes' where id = $1`, [id]);
    const { n } = await one<{ n: number }>(`select reap_stale_outbound_claims() as n`);
    expect(Number(n)).toBe(1);
    expect((await one<{ status: string }>(
      `select status from outbound_messages where id = $1`, [id])).status).toBe("queued");
  });

  it("refuses a browser trying to claim", async () => {
    await queued();
    await asUser();
    expect(await refusal(`select * from claim_outbound_messages(10)`))
      .toContain("Only the internal service");
  });
});

describe("what is stopping a message", () => {
  it("says the switch is off", async () => {
    const { versionId } = await template();
    await approve(versionId);
    await db.query(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]);
    await enableSending(false);
    expect((await one<{ blocker: string }>(`select blocker from outbound_message_due`)).blocker)
      .toContain("Outbound messaging is off");
  });

  it("says nothing is stopping a message that is simply waiting", async () => {
    const { versionId } = await template();
    await approve(versionId);
    await db.query(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]);
    await enableSending(true);
    expect((await one<{ blocker: string | null }>(`select blocker from outbound_message_due`)).blocker)
      .toBeNull();
  });

  it("says a suppressed person will never receive it", async () => {
    const { versionId } = await template();
    await approve(versionId);
    await enableSending(true);
    await db.query(`select queue_lead_message_v6($1,$2)`, [LEAD, versionId]);
    await db.query(`select suppress_lead_v6($1,$2,'complained',null)`,
      [CLIENT, "email:priya@example.com"]);
    expect((await one<{ blocker: string }>(`select blocker from outbound_message_due`)).blocker)
      .toContain("will never send");
  });
});

describe("proof in a nurture template", () => {
  it("unblocks email_sms_nurture as a proof destination", async () => {
    const row = await one<{ supported: boolean; note: string }>(
      `select supported, note from proof_destinations where destination_key = 'email_sms_nurture'`);
    expect(row.supported).toBe(true);
    expect(row.note).toContain("approved template version");
  });
});
