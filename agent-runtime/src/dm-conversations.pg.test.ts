import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 257, 258 and 259 against a real Postgres.
 *
 * Two rules carry this whole slice. Meta re-delivers webhooks, so an inbound
 * message has to be idempotent on the platform's message id or somebody's
 * "yes please" becomes three leads. And a business may only reply inside a
 * window the person opened, so a reply queued on Friday and claimed on
 * Monday must not go.
 *
 * The third thing worth pinning is a design decision that looks like a hole
 * until you read it: a DM reply needs no consent row. Somebody who writes to
 * a business has consented to be answered in that thread and nothing else,
 * so the consent check is skipped and the window is the constraint — while
 * suppression still applies, because asking not to be contacted is asking.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";

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

/** One inbound message, as the webhook would record it. */
async function inbound(over: Record<string, unknown> = {}) {
  return one<{ conversation_id: string; lead_id: string; is_new: boolean }>(
    `select * from record_inbound_dm_v6($1,$2,$3,$4,$5,$6,$7)`,
    [CLIENT, over.platform ?? "instagram", over.user ?? "igsid-9",
     over.mid ?? "mid-1", over.body ?? "Do you do garage conversions?",
     over.name ?? "Priya R", over.at ?? null]);
}

/** An approved DM template for this client. */
async function dmTemplate(channel = "instagram_dm"): Promise<string> {
  await asUser();
  const t = await one<{ id: string }>(
    `select id from create_message_template_v6($1,'Reply','objection',$2)`, [CLIENT, channel]);
  const v = await one<{ id: string }>(
    `select id from add_message_template_version_v6($1,null,'Hi {{first_name}}, we do.')`, [t.id]);
  await db.query(
    `select approve_message_template_v6($1,'They wrote to us first')`, [v.id]);
  return v.id;
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
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end$$;

 create type lead_stage as enum ('lead','conversation','qualified_conversation','appointment',
   'qualified_appointment','shown','sale','cash','lost','profile_visit','follower','qualified');

 create function lead_dedupe_key(p_email text, p_phone text) returns text
 language sql immutable as $f$
   select coalesce(
     nullif('email:' || lower(btrim(coalesce(p_email,''))), 'email:'),
     nullif('phone:' || right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 9), 'phone:'))
 $f$;

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_campaigns(id uuid primary key default gen_random_uuid(), client_id uuid);
 create table client_engine_settings(client_id uuid primary key);
 create table client_integrations(id uuid primary key default gen_random_uuid(),
   client_id uuid, provider text, status text, meta_page_id text,
   updated_at timestamptz default now());
 create table proof_destinations(destination_key text primary key, supported boolean, note text);
 insert into proof_destinations values ('email_sms_nurture', false, 'x');
 create table client_leads(
   id uuid primary key default gen_random_uuid(), client_id uuid not null references clients(id),
   name text, email text, phone text, source text, source_channel text,
   stage lead_stage not null default 'lead', stage_at timestamptz not null default now(),
   appointment_at timestamptz, source_client_campaign_id uuid,
   is_probe boolean not null default false,
   consent_given_at timestamptz, consent_wording text,
   dedupe_key text generated always as (lead_dedupe_key(email, phone)) stored,
   created_at timestamptz not null default now());
 create table lead_events(id uuid primary key default gen_random_uuid(),
   lead_id uuid, client_id uuid, kind text, detail text,
   created_at timestamptz not null default now());

 insert into clients values('${CLIENT}');
 insert into profiles values('${MANAGER}');
 insert into client_engine_settings (client_id) values ('${CLIENT}');
 insert into client_integrations (client_id, provider, status, meta_page_id)
   values ('${CLIENT}','meta','connected','page-1');`);

  await db.exec(await sql("20261025130000_248_a_message_can_be_sent_to_a_person.sql"));
  await db.exec(await sql("20261025140000_249_the_send_path.sql"));
  await db.exec(await sql("20261025220000_257_a_dm_can_be_held.sql"));
  await db.exec(await sql("20261025230000_258_replying_in_the_thread.sql"));
  await db.exec(await sql("20261025240000_259_which_client_a_message_belongs_to.sql"));
  await db.query(
    `update client_engine_settings set outbound_messaging_enabled = true where client_id = $1`,
    [CLIENT]);
});

afterAll(async () => { await db?.close(); });

describe("an inbound message", () => {
  it("creates the identity, the lead and the thread", async () => {
    await asService();
    const got = await inbound();
    expect(got.is_new).toBe(true);

    const lead = await one<{ stage: string; source: string; consent_given_at: string | null }>(
      `select stage, source, consent_given_at from client_leads where id = $1`, [got.lead_id]);
    // Further along than a form fill: they have written to the business.
    expect(lead.stage).toBe("conversation");
    expect(lead.source).toBe("direct_message");
    // And no consent, because writing to a business is not consent to email.
    expect(lead.consent_given_at).toBeNull();

    const conv = await one<{ unread_inbound: number; window_expires_at: string }>(
      `select unread_inbound, window_expires_at from dm_conversations where id = $1`,
      [got.conversation_id]);
    expect(Number(conv.unread_inbound)).toBe(1);
    expect(new Date(conv.window_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("is a no-op when Meta re-delivers the same message", async () => {
    await asService();
    const first = await inbound();
    const again = await inbound();
    const third = await inbound();
    expect(again.conversation_id).toBe(first.conversation_id);
    expect(third.lead_id).toBe(first.lead_id);
    expect(again.is_new).toBe(false);

    expect(await rows(`select 1 from client_leads`)).toHaveLength(1);
    expect(await rows(`select 1 from dm_conversations`)).toHaveLength(1);
    expect(await rows(`select 1 from dm_messages`)).toHaveLength(1);
  });

  it("reopens the window and counts the unread when they write again", async () => {
    await asService();
    const first = await inbound({ at: new Date(Date.now() - 20 * 3600_000).toISOString() });
    const before = await one<{ window_expires_at: string }>(
      `select window_expires_at from dm_conversations where id = $1`, [first.conversation_id]);

    await inbound({ mid: "mid-2", body: "Still interested" });
    const after = await one<{ window_expires_at: string; unread_inbound: number }>(
      `select window_expires_at, unread_inbound from dm_conversations where id = $1`,
      [first.conversation_id]);
    expect(new Date(after.window_expires_at).getTime())
      .toBeGreaterThan(new Date(before.window_expires_at).getTime());
    expect(Number(after.unread_inbound)).toBe(2);
  });

  it("keeps one thread per person and one per platform", async () => {
    await asService();
    const ig = await inbound();
    const fb = await inbound({ platform: "facebook", user: "psid-5", mid: "mid-fb" });
    expect(fb.conversation_id).not.toBe(ig.conversation_id);
    expect(await rows(`select 1 from dm_conversations`)).toHaveLength(2);
  });

  it("refuses a browser", async () => {
    await asUser();
    expect(await refusal(
      `select record_inbound_dm_v6($1,'instagram','x','m','hi',null,null)`, [CLIENT]))
      .toContain("Only the internal service");
  });

  it("finds the client from the page the message was sent to", async () => {
    await asService();
    expect((await one<{ c: string }>(
      `select client_for_meta_recipient_v6('page-1') as c`)).c).toBe(CLIENT);
    // A page we do not own answers null, not an error: Meta sends events for
    // pages a client has disconnected.
    expect((await one<{ c: string | null }>(
      `select client_for_meta_recipient_v6('page-unknown') as c`)).c).toBeNull();
    await db.query(`update client_integrations set status = 'error'`);
    expect((await one<{ c: string | null }>(
      `select client_for_meta_recipient_v6('page-1') as c`)).c).toBeNull();
  });
});

describe("the reply window", () => {
  it("is open while it is open and says when it closed", async () => {
    await asService();
    const conv = await inbound();
    expect((await one<{ r: string | null }>(
      `select dm_reply_refusal_v6($1) as r`, [conv.conversation_id])).r).toBeNull();

    await db.query(
      `update dm_conversations set window_expires_at = now() - interval '1 hour' where id = $1`,
      [conv.conversation_id]);
    const refused = (await one<{ r: string }>(
      `select dm_reply_refusal_v6($1) as r`, [conv.conversation_id])).r;
    expect(refused).toContain("reply window closed");
    expect(refused).toContain("Only another message from them reopens it");
  });

  it("refuses a closed thread with its reason", async () => {
    await asService();
    const conv = await inbound();
    await asUser();
    await db.query(`select close_dm_conversation_v6($1,'Handled on the phone')`,
      [conv.conversation_id]);
    expect((await one<{ r: string }>(
      `select dm_reply_refusal_v6($1) as r`, [conv.conversation_id])).r)
      .toContain("Handled on the phone");
  });
});

describe("replying", () => {
  it("needs no consent, because the thread is the consent", async () => {
    await asService();
    const conv = await inbound();
    const version = await dmTemplate();
    await asService();

    // The lead has no consent row at all, and the reply still queues.
    const m = await one<{ id: string; address: string; channel_key: string }>(
      `select id, address, channel_key from queue_lead_message_v6($1,$2)`,
      [conv.lead_id, version]);
    expect(m.channel_key).toBe("instagram_dm");
    expect(m.address).toBe("igsid-9");

    // And the thread records it, pointing at the governed send.
    const recorded = await one<{ direction: string; outbound_message_id: string }>(
      `select direction, outbound_message_id from dm_messages
        where conversation_id = $1 and direction = 'outbound'`, [conv.conversation_id]);
    expect(recorded.outbound_message_id).toBe(m.id);
    expect(Number((await one<{ unread_inbound: number }>(
      `select unread_inbound from dm_conversations where id = $1`, [conv.conversation_id]))
      .unread_inbound)).toBe(0);
  });

  it("still refuses somebody who asked not to be contacted", async () => {
    await asService();
    const conv = await inbound();
    const version = await dmTemplate();
    await asUser();
    const lead = await one<{ dedupe_key: string | null }>(
      `select dedupe_key from client_leads where id = $1`, [conv.lead_id]);
    // A DM lead has no email or phone, so suppression is keyed on a null
    // dedupe key -- which is itself worth knowing, and why this test sets one.
    await db.query(`update client_leads set email = 'priya@example.com' where id = $1`, [conv.lead_id]);
    await db.query(`select suppress_lead_v6($1,'email:priya@example.com','unsubscribed',null)`, [CLIENT]);
    await asService();
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [conv.lead_id, version]))
      .toContain("suppressed");
    expect(lead.dedupe_key).toBeNull();
  });

  it("refuses once the window has closed", async () => {
    await asService();
    const conv = await inbound();
    const version = await dmTemplate();
    await db.query(
      `update dm_conversations set window_expires_at = now() - interval '1 minute' where id = $1`,
      [conv.conversation_id]);
    await asService();
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [conv.lead_id, version]))
      .toContain("reply window closed");
  });

  it("refuses a lead with no thread on that platform", async () => {
    await asService();
    const conv = await inbound({ platform: "facebook", user: "psid-1", mid: "m-fb" });
    const version = await dmTemplate("instagram_dm");
    await asService();
    expect(await refusal(`select queue_lead_message_v6($1,$2)`, [conv.lead_id, version]))
      .toContain("no instagram_dm conversation");
  });

  it("will not claim a reply whose window closed after it was queued", async () => {
    await asService();
    const conv = await inbound();
    const version = await dmTemplate();
    await asService();
    await db.query(`select queue_lead_message_v6($1,$2)`, [conv.lead_id, version]);
    expect(await rows(`select * from claim_outbound_messages(10)`)).toHaveLength(1);

    // Put it back, then close the window, as a weekend would.
    await db.query(`update outbound_messages set status = 'queued', lease_until = null`);
    await db.query(
      `update dm_conversations set window_expires_at = now() - interval '1 minute' where id = $1`,
      [conv.conversation_id]);
    expect(await rows(`select * from claim_outbound_messages(10)`)).toHaveLength(0);

    expect((await one<{ blocker: string }>(`select blocker from outbound_message_due`)).blocker)
      .toContain("will never send");
  });
});

describe("the inbox", () => {
  it("says how long is left to answer", async () => {
    await asService();
    const conv = await inbound();
    const row = await one<{ window_open: boolean; hours_left: string; last_inbound_body: string }>(
      `select window_open, hours_left, last_inbound_body from dm_conversation_due
        where conversation_id = $1`, [conv.conversation_id]);
    expect(row.window_open).toBe(true);
    expect(Number(row.hours_left)).toBeGreaterThan(23);
    expect(row.last_inbound_body).toBe("Do you do garage conversions?");
  });

  it("reads zero hours left once it has closed", async () => {
    await asService();
    const conv = await inbound();
    await db.query(
      `update dm_conversations set window_expires_at = now() - interval '2 hours' where id = $1`,
      [conv.conversation_id]);
    const row = await one<{ window_open: boolean; hours_left: string }>(
      `select window_open, hours_left from dm_conversation_due where conversation_id = $1`,
      [conv.conversation_id]);
    expect(row.window_open).toBe(false);
    expect(Number(row.hours_left)).toBe(0);
  });
});

describe("merging a thread into a lead somebody knew about", () => {
  it("points the thread at the real lead and keeps the history", async () => {
    await asService();
    const conv = await inbound();
    await asUser();
    const existing = await one<{ id: string }>(
      `insert into client_leads (client_id, name, email) values ($1,'Priya Raman','priya@example.com')
       returning id`, [CLIENT]);
    await db.query(`select merge_dm_lead_v6($1,$2)`, [conv.conversation_id, existing.id]);

    expect((await one<{ lead_id: string }>(
      `select lead_id from dm_conversations where id = $1`, [conv.conversation_id])).lead_id)
      .toBe(existing.id);
    expect((await one<{ detail: string }>(
      `select detail from lead_events where lead_id = $1 order by created_at desc limit 1`,
      [existing.id])).detail).toContain("was merged into this lead");
  });

  it("refuses a probe lead and another client's lead", async () => {
    await asService();
    const conv = await inbound();
    await asUser();
    const probe = await one<{ id: string }>(
      `insert into client_leads (client_id, name, is_probe) values ($1,'Probe',true) returning id`,
      [CLIENT]);
    expect(await refusal(`select merge_dm_lead_v6($1,$2)`, [conv.conversation_id, probe.id]))
      .toContain("probe lead");
  });
});
