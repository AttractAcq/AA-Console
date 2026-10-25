import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 251 and 252 against a real Postgres.
 *
 * The failure this whole slice exists to prevent is one sentence long: a lead
 * books a call on Tuesday and is asked on Wednesday whether they are still
 * thinking it over. So the exit check runs before every step, not at
 * enrolment, and the tests below spend most of their effort on that.
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

/** An approved message version, ready to be a step. */
async function approvedVersion(body: string): Promise<string> {
  const t = await one<{ id: string }>(
    `select id from create_message_template_v6($1,'A step','objection','email')`, [CLIENT]);
  const v = await one<{ id: string }>(
    `select id from add_message_template_version_v6($1,'Subject',$2)`, [t.id, body]);
  await db.query(
    `select approve_message_template_v6($1,'They asked for a quote and consented')`, [v.id]);
  return v.id;
}

/** A sequence with the given step delays, each step an approved message. */
async function sequence(delays: number[], over: Record<string, unknown> = {}): Promise<string> {
  const s = await one<{ id: string }>(
    `insert into nurture_sequences (client_id, name, purpose, trigger_stage, trigger_after_hours,
       enrolled_automatically)
     values ($1,'Objections','objection', coalesce($2,'lead')::lead_stage, coalesce($3,0), coalesce($4,false))
     returning id`,
    [CLIENT, (over.trigger_stage as string) ?? null, over.trigger_after_hours ?? null,
     over.enrolled_automatically ?? null]);
  let position = 0;
  for (const delay of delays) {
    position += 1;
    const v = await approvedVersion(`Hi {{first_name}}, step ${position}.`);
    await db.query(
      `insert into nurture_sequence_steps (sequence_id, client_id, position, delay_hours, template_version_id)
       values ($1,$2,$3,$4,$5)`, [s.id, CLIENT, position, delay, v]);
  }
  return s.id;
}

async function enrollment(): Promise<{ id: string; status: string; last_step: number | null; next_due_at: string | null; exit_reason: string | null }> {
  return one(`select id, status, last_step, next_due_at, exit_reason
                from lead_sequence_enrollments where lead_id = $1`, [LEAD]);
}
/** Make the next step due now, so a sweep picks it up without waiting. */
const makeDue = () =>
  db.query(`update lead_sequence_enrollments set next_due_at = now() - interval '1 minute'`);

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

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_campaigns(id uuid primary key default gen_random_uuid(), client_id uuid);
 create table client_engine_settings(client_id uuid primary key);
 create table proof_destinations(destination_key text primary key, supported boolean, note text);
 insert into proof_destinations values ('email_sms_nurture', false, 'x');
 create table agents(agent_key text primary key, name text, initials text, domain text,
   description text, requires_upstream text[]);
 create table agent_jobs(id uuid primary key default gen_random_uuid(), agent_key text,
   params jsonb, status text default 'queued');
 create schema cron;
 create table cron.job(jobid serial primary key, jobname text, schedule text);
 create function cron.schedule(text,text,text) returns bigint language sql as
   $f$insert into cron.job(jobname,schedule) values ($1,$2) returning jobid::bigint$f$;
 create function cron.unschedule(text) returns boolean language sql as
   $f$delete from cron.job where jobname = $1 returning true$f$;

 create table client_leads(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id),
   name text, email text, phone text,
   stage lead_stage not null default 'lead',
   stage_at timestamptz not null default now(),
   consent_given_at timestamptz, consent_wording text, consent_evidence text,
   source_client_campaign_id uuid, dedupe_key text,
   is_probe boolean not null default false,
   created_at timestamptz not null default now());

 insert into clients values('${CLIENT}');
 insert into profiles values('${MANAGER}');
 insert into client_engine_settings (client_id) values ('${CLIENT}');
 insert into client_leads (id, client_id, name, email, consent_given_at, consent_wording, dedupe_key)
   values ('${LEAD}','${CLIENT}','Priya Raman','priya@example.com', now(),
           'We may contact you', 'email:priya@example.com');`);

  await db.exec(await sql("20261025130000_248_a_message_can_be_sent_to_a_person.sql"));
  await db.exec(await sql("20261025140000_249_the_send_path.sql"));
  await db.exec(await sql("20261025160000_251_a_lead_can_be_walked_through_a_sequence.sql"));
  await db.exec(await sql("20261025170000_252_walking_the_sequence.sql"));
  await db.query(
    `update client_engine_settings set outbound_messaging_enabled = true where client_id = $1`,
    [CLIENT]);
});

afterAll(async () => { await db?.close(); });

describe("approving the shape", () => {
  it("refuses a sequence with no steps", async () => {
    const s = await one<{ id: string }>(
      `insert into nurture_sequences (client_id, name, purpose, trigger_stage)
       values ($1,'Empty','objection','lead') returning id`, [CLIENT]);
    expect(await refusal(`select approve_nurture_sequence_v6($1)`, [s.id]))
      .toContain("no steps");
  });

  it("names the steps whose words nobody approved", async () => {
    const s = await one<{ id: string }>(
      `insert into nurture_sequences (client_id, name, purpose, trigger_stage)
       values ($1,'Mixed','objection','lead') returning id`, [CLIENT]);
    const approved = await approvedVersion("Hi {{first_name}}, one.");
    const t = await one<{ id: string }>(
      `select id from create_message_template_v6($1,'Unapproved','objection','email')`, [CLIENT]);
    const unapproved = await one<{ id: string }>(
      `select id from add_message_template_version_v6($1,'S','Hi {{first_name}}, two.')`, [t.id]);
    await db.query(
      `insert into nurture_sequence_steps (sequence_id, client_id, position, delay_hours, template_version_id)
       values ($1,$2,1,0,$3), ($1,$2,2,24,$4)`, [s.id, CLIENT, approved, unapproved.id]);

    expect(await refusal(`select approve_nurture_sequence_v6($1)`, [s.id]))
      .toContain("step 2");
  });

  it("drops the approval when the shape changes", async () => {
    const s = await sequence([0]);
    await db.query(`select approve_nurture_sequence_v6($1)`, [s]);
    expect((await one<{ approved_at: string }>(
      `select approved_at from nurture_sequences where id = $1`, [s])).approved_at).toBeTruthy();

    const v = await approvedVersion("Hi {{first_name}}, a late addition.");
    await db.query(
      `insert into nurture_sequence_steps (sequence_id, client_id, position, delay_hours, template_version_id)
       values ($1,$2,2,24,$3)`, [s, CLIENT, v]);
    expect((await one<{ approved_at: string | null }>(
      `select approved_at from nurture_sequences where id = $1`, [s])).approved_at).toBeNull();
  });
});

describe("enrolling", () => {
  it("refuses an unapproved sequence", async () => {
    const s = await sequence([0]);
    expect(await refusal(`select enroll_lead_in_sequence_v6($1,$2)`, [LEAD, s]))
      .toContain("not approved");
  });

  it("refuses a lead who has already reached an exit stage", async () => {
    const s = await sequence([0]);
    await db.query(`select approve_nurture_sequence_v6($1)`, [s]);
    await db.query(`update client_leads set stage = 'sale' where id = $1`, [LEAD]);
    expect(await refusal(`select enroll_lead_in_sequence_v6($1,$2)`, [LEAD, s]))
      .toContain("reached sale");
  });

  it("refuses a suppressed lead", async () => {
    const s = await sequence([0]);
    await db.query(`select approve_nurture_sequence_v6($1)`, [s]);
    await db.query(`select suppress_lead_v6($1,$2,'unsubscribed',null)`,
      [CLIENT, "email:priya@example.com"]);
    expect(await refusal(`select enroll_lead_in_sequence_v6($1,$2)`, [LEAD, s]))
      .toContain("unsubscribed or complained");
  });

  it("enrols once per lead per sequence, for all time", async () => {
    const s = await sequence([0]);
    await db.query(`select approve_nurture_sequence_v6($1)`, [s]);
    const first = await one<{ id: string }>(
      `select id from enroll_lead_in_sequence_v6($1,$2)`, [LEAD, s]);
    const again = await one<{ id: string }>(
      `select id from enroll_lead_in_sequence_v6($1,$2)`, [LEAD, s]);
    expect(again.id).toBe(first.id);
  });

  it("enrols automatically only where a sequence asked for it", async () => {
    const manual = await sequence([0], { enrolled_automatically: false });
    await db.query(`select approve_nurture_sequence_v6($1)`, [manual]);
    await asService();
    expect(Number((await one<{ n: number }>(`select enroll_due_leads_v6() as n`)).n)).toBe(0);

    await asUser();
    const auto = await sequence([0], { enrolled_automatically: true });
    await db.query(`select approve_nurture_sequence_v6($1)`, [auto]);
    await asService();
    expect(Number((await one<{ n: number }>(`select enroll_due_leads_v6() as n`)).n)).toBe(1);
  });

  it("waits the trigger delay before enrolling automatically", async () => {
    const s = await sequence([0], { enrolled_automatically: true, trigger_after_hours: 48 });
    await db.query(`select approve_nurture_sequence_v6($1)`, [s]);
    await asService();
    expect(Number((await one<{ n: number }>(`select enroll_due_leads_v6() as n`)).n)).toBe(0);
    await asUser();
    await db.query(`update client_leads set stage_at = now() - interval '72 hours' where id = $1`, [LEAD]);
    await asService();
    expect(Number((await one<{ n: number }>(`select enroll_due_leads_v6() as n`)).n)).toBe(1);
  });
});

describe("walking it", () => {
  async function enrolled(delays = [0, 24]): Promise<string> {
    const s = await sequence(delays);
    await db.query(`select approve_nurture_sequence_v6($1)`, [s]);
    await db.query(`select enroll_lead_in_sequence_v6($1,$2)`, [LEAD, s]);
    return s;
  }

  it("queues the first step and schedules the second", async () => {
    await enrolled();
    await asService();
    expect(Number((await one<{ n: number }>(`select advance_sequences_v6() as n`)).n)).toBe(1);

    const e = await enrollment();
    expect(Number(e.last_step)).toBe(1);
    expect(e.status).toBe("active");
    expect(e.next_due_at).toBeTruthy();
    expect(await rows(`select 1 from outbound_messages`)).toHaveLength(1);
  });

  it("does not send the next step before it is due", async () => {
    await enrolled();
    await asService();
    await db.query(`select advance_sequences_v6()`);
    expect(Number((await one<{ n: number }>(`select advance_sequences_v6() as n`)).n)).toBe(0);
    expect(await rows(`select 1 from outbound_messages`)).toHaveLength(1);
  });

  it("completes after the last step", async () => {
    await enrolled([0]);
    await asService();
    await db.query(`select advance_sequences_v6()`);
    const e = await enrollment();
    expect(e.status).toBe("completed");
    expect(e.next_due_at).toBeNull();
  });

  it("exits the lead who books a call between steps, rather than skipping", async () => {
    await enrolled();
    await asService();
    await db.query(`select advance_sequences_v6()`);

    // Tuesday: they book.
    await asUser();
    await db.query(`update client_leads set stage = 'appointment' where id = $1`, [LEAD]);
    await makeDue();
    await asService();
    await db.query(`select advance_sequences_v6()`);

    const e = await enrollment();
    // Exited, not skipped: skipping would leave them exposed to step three.
    expect(e.status).toBe("exited");
    expect(e.exit_reason).toContain("reached appointment");
    expect(e.next_due_at).toBeNull();
    // And the second message never went.
    expect(await rows(`select 1 from outbound_messages`)).toHaveLength(1);
  });

  it("exits a lead who unsubscribes mid-sequence", async () => {
    await enrolled();
    await asService();
    await db.query(`select advance_sequences_v6()`);
    await asUser();
    await db.query(`select suppress_lead_v6($1,$2,'unsubscribed',null)`,
      [CLIENT, "email:priya@example.com"]);
    await makeDue();
    await asService();
    await db.query(`select advance_sequences_v6()`);
    expect((await enrollment()).exit_reason).toContain("unsubscribed");
  });

  it("exits when the sequence's own approval is dropped mid-flight", async () => {
    const s = await enrolled();
    await asService();
    await db.query(`select advance_sequences_v6()`);
    // Somebody edits the shape, which drops the approval.
    await asUser();
    const v = await approvedVersion("Hi {{first_name}}, a late addition.");
    await db.query(
      `insert into nurture_sequence_steps (sequence_id, client_id, position, delay_hours, template_version_id)
       values ($1,$2,9,1,$3)`, [s, CLIENT, v]);
    await makeDue();
    await asService();
    await db.query(`select advance_sequences_v6()`);
    expect((await enrollment()).exit_reason).toContain("approval was dropped");
  });

  it("delays rather than exits when the send is temporarily refused", async () => {
    await enrolled();
    // The client's cap is spent, which is temporary and not the lead's fault.
    await asUser();
    await db.query(
      `update client_engine_settings set outbound_daily_cap = 0 where client_id = $1`, [CLIENT]);
    await asService();
    expect(Number((await one<{ n: number }>(`select advance_sequences_v6() as n`)).n)).toBe(0);

    const e = await enrollment();
    expect(e.status).toBe("active");
    expect(e.last_step).toBeNull();
    expect(e.next_due_at).toBeTruthy();

    // Once the cap is lifted the step goes, still as step one.
    await asUser();
    await db.query(
      `update client_engine_settings set outbound_daily_cap = 200 where client_id = $1`, [CLIENT]);
    await makeDue();
    await asService();
    await db.query(`select advance_sequences_v6()`);
    expect(Number((await enrollment()).last_step)).toBe(1);
  });

  it("refuses a browser trying to advance sequences", async () => {
    await enrolled();
    await asUser();
    expect(await refusal(`select advance_sequences_v6()`)).toContain("Only the internal service");
  });

  it("lets a person take somebody out, with a reason", async () => {
    await enrolled();
    const e = await enrollment();
    expect(await refusal(`select exit_lead_from_sequence_v6($1,'  ')`, [e.id]))
      .toContain("Say why");
    await db.query(`select exit_lead_from_sequence_v6($1,'They called in instead')`, [e.id]);
    expect((await enrollment()).exit_reason).toBe("They called in instead");
  });
});

describe("what is stopping a sequence", () => {
  it("tells an unapproved shape apart from unapproved words inside it", async () => {
    const s = await one<{ id: string }>(
      `insert into nurture_sequences (client_id, name, purpose, trigger_stage)
       values ($1,'Mixed','objection','lead') returning id`, [CLIENT]);
    const t = await one<{ id: string }>(
      `select id from create_message_template_v6($1,'Unapproved','objection','email')`, [CLIENT]);
    const v = await one<{ id: string }>(
      `select id from add_message_template_version_v6($1,'S','Hi {{first_name}}.')`, [t.id]);
    await db.query(
      `insert into nurture_sequence_steps (sequence_id, client_id, position, delay_hours, template_version_id)
       values ($1,$2,1,0,$3)`, [s.id, CLIENT, v.id]);
    expect((await one<{ blocker: string }>(
      `select blocker from nurture_sequence_due where sequence_id = $1`, [s.id])).blocker)
      .toContain("carry words nobody has approved either");
  });

  it("says when outbound messaging is off for the client", async () => {
    const s = await sequence([0], { enrolled_automatically: true });
    await db.query(`select approve_nurture_sequence_v6($1)`, [s]);
    await db.query(
      `update client_engine_settings set outbound_messaging_enabled = false where client_id = $1`,
      [CLIENT]);
    expect((await one<{ blocker: string }>(
      `select blocker from nurture_sequence_due where sequence_id = $1`, [s])).blocker)
      .toContain("Outbound messaging is off");
  });

  it("says when nobody is enrolled automatically", async () => {
    const s = await sequence([0], { enrolled_automatically: false });
    await db.query(`select approve_nurture_sequence_v6($1)`, [s]);
    expect((await one<{ blocker: string }>(
      `select blocker from nurture_sequence_due where sequence_id = $1`, [s])).blocker)
      .toContain("added by hand");
  });

  it("counts who is walking it, who finished and who left", async () => {
    const s = await sequence([0]);
    await db.query(`select approve_nurture_sequence_v6($1)`, [s]);
    await db.query(`select enroll_lead_in_sequence_v6($1,$2)`, [LEAD, s]);
    await asService();
    await db.query(`select advance_sequences_v6()`);
    const row = await one<{ active: number; completed: number; exited: number; blocker: string | null }>(
      `select active, completed, exited, blocker from nurture_sequence_due where sequence_id = $1`, [s]);
    expect(Number(row.completed)).toBe(1);
    expect(Number(row.active)).toBe(0);
  });
});
