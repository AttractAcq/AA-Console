import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 255 and 256 against a real Postgres.
 *
 * The sales agent could say "I have put you in for Thursday at ten" and mean
 * nothing by it. So the tests are about whether a slot offered is a slot the
 * client would honour: inside their stated hours, past the notice period,
 * not inside the buffer around something booked, under the daily maximum —
 * and above all, never given to two people.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const OTHER_LEAD = "44444444-4444-4444-8444-444444444444";

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

/** Booking on, with the given rules, and one window on every weekday. */
async function bookable(over: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    `insert into client_booking_settings (client_id, timezone, slot_minutes, buffer_minutes,
       min_notice_hours, max_days_ahead, max_per_day, enabled)
     values ($1, 'Europe/London', coalesce($2,60), coalesce($3,0), coalesce($4,0),
             coalesce($5,14), coalesce($6,10), true)
     on conflict (client_id) do update set
       slot_minutes = excluded.slot_minutes, buffer_minutes = excluded.buffer_minutes,
       min_notice_hours = excluded.min_notice_hours, max_days_ahead = excluded.max_days_ahead,
       max_per_day = excluded.max_per_day, enabled = true`,
    [CLIENT, over.slot_minutes ?? null, over.buffer_minutes ?? null,
     over.min_notice_hours ?? null, over.max_days_ahead ?? null, over.max_per_day ?? null]);
  await db.query(`delete from client_booking_windows where client_id = $1`, [CLIENT]);
  // 09:00–17:00 every day, so a test never has to care which day it runs on.
  for (let dow = 0; dow <= 6; dow += 1) {
    await db.query(
      `insert into client_booking_windows (client_id, day_of_week, starts_at_minute, ends_at_minute)
       values ($1,$2,540,1020)`, [CLIENT, dow]);
  }
}

/** PGlite returns timestamptz as a Date, so slots are compared as instants. */
const slots = () =>
  rows<{ starts_at: Date; ends_at: Date }>(
    `select starts_at, ends_at from available_slots_v6($1, 7) order by starts_at`, [CLIENT]);
const at = (d: Date) => new Date(d).getTime();
const dayOf = (d: Date) => new Date(d).toISOString().slice(0, 10);

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select coalesce(current_setting('test.role',true),'authenticated')$$;
 create function auth.uid() returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
 create function can_access_client(uuid) returns boolean language sql as $$select $1='${CLIENT}'::uuid$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end$$;

 create type lead_stage as enum ('lead','conversation','qualified_conversation','appointment',
   'qualified_appointment','shown','sale','cash','lost','profile_visit','follower','qualified');

 create table clients(id uuid primary key, name text);
 create table profiles(id uuid primary key);
 create table client_campaigns(id uuid primary key default gen_random_uuid(), client_id uuid);
 -- 235's key, declared before the table because the table generates from it:
 -- exact email, or the last nine digits of a phone number.
 create function lead_dedupe_key(p_email text, p_phone text) returns text
 language sql immutable as $f$
   select coalesce(
     nullif('email:' || lower(btrim(coalesce(p_email,''))), 'email:'),
     nullif('phone:' || right(regexp_replace(coalesce(p_phone,''), '\\D', '', 'g'), 9), 'phone:'))
 $f$;

 create table client_leads(
   id uuid primary key default gen_random_uuid(), client_id uuid not null references clients(id),
   name text, email text, phone text, source text, source_channel text,
   stage lead_stage not null default 'lead',
   stage_at timestamptz not null default now(), appointment_at timestamptz,
   source_client_campaign_id uuid, is_probe boolean not null default false,
   consent_given_at timestamptz, consent_wording text,
   -- Generated, as production has it. A plain column here would be null on
   -- insert and the dedupe lookup would silently never match.
   dedupe_key text generated always as (lead_dedupe_key(email, phone)) stored,
   created_at timestamptz not null default now());
 create table lead_events(id uuid primary key default gen_random_uuid(),
   lead_id uuid, client_id uuid, kind text, detail text,
   created_at timestamptz not null default now());

 insert into clients values('${CLIENT}','Harbour Dental');
 insert into profiles values('${MANAGER}');
 insert into client_leads (id, client_id, name, email) values
   ('${LEAD}','${CLIENT}','Priya Raman','priya@example.com'),
   ('${OTHER_LEAD}','${CLIENT}','Sam Obi','sam@example.com');`);

  await db.exec(await sql("20261025200000_255_a_call_can_actually_be_booked.sql"));
  await db.exec(await sql("20261025210000_256_taking_a_slot.sql"));
});

afterAll(async () => { await db?.close(); });

describe("what is offered", () => {
  it("offers nothing while booking is off", async () => {
    await bookable();
    await db.query(`update client_booking_settings set enabled = false where client_id = $1`, [CLIENT]);
    expect(await slots()).toHaveLength(0);
  });

  it("offers nothing when no hours are recorded", async () => {
    await bookable();
    await db.query(`delete from client_booking_windows where client_id = $1`, [CLIENT]);
    expect(await slots()).toHaveLength(0);
  });

  it("offers hourly slots inside the stated window", async () => {
    await bookable({ slot_minutes: 60 });
    const got = await slots();
    expect(got.length).toBeGreaterThan(0);
    // 09:00 to 17:00 is eight hourly slots a day.
    const perDay = new Map<string, number>();
    for (const s of got) {
      perDay.set(dayOf(s.starts_at), (perDay.get(dayOf(s.starts_at)) ?? 0) + 1);
    }
    // Every full day in range offers eight; the first and last may be partial.
    expect([...perDay.values()].some((n) => n === 8)).toBe(true);
  });

  it("respects the notice period", async () => {
    await bookable({ min_notice_hours: 48 });
    const got = await slots();
    const earliest = at(got[0]!.starts_at);
    expect(earliest).toBeGreaterThan(Date.now() + 47 * 3600 * 1000);
  });

  it("stops at the horizon", async () => {
    await bookable({ max_days_ahead: 2 });
    const got = await slots();
    const latest = at(got[got.length - 1]!.starts_at);
    expect(latest).toBeLessThan(Date.now() + 3 * 24 * 3600 * 1000);
  });

  it("drops a whole day once the daily maximum is booked", async () => {
    await bookable({ max_per_day: 1, min_notice_hours: 0 });
    const first = (await slots())[0]!;
    await db.query(`select book_appointment_v6($1,$2,'person')`, [LEAD, first.starts_at]);

    const day = dayOf(first.starts_at);
    const left = (await slots()).filter((s) => dayOf(s.starts_at) === day);
    expect(left).toHaveLength(0);
  });
});

describe("the buffer", () => {
  it("keeps a gap on both sides of something booked", async () => {
    await bookable({ slot_minutes: 60, buffer_minutes: 30, max_per_day: 10 });
    const before = await slots();
    // The first day may already be partly elapsed when CI runs. Select a
    // future slot whose neighbours all exist in the same booking window.
    const target = before.find((slot) => {
      const start = at(slot.starts_at);
      return [-1, 1, 2].every((hours) => before.some((candidate) =>
        dayOf(candidate.starts_at) === dayOf(slot.starts_at)
        && at(candidate.starts_at) === start + hours * 3600_000));
    });
    expect(target, "expected a future slot with neighbours before and after it").toBeDefined();
    await db.query(`select book_appointment_v6($1,$2,'person')`, [LEAD, target!.starts_at]);

    const after = await slots();
    const taken = at(target!.starts_at);
    // The slot itself, the one before and the one after are all gone: a
    // thirty-minute buffer overlaps an hour slot on each side.
    for (const offset of [-3600_000, 0, 3600_000]) {
      expect(after.some((s) => at(s.starts_at) === taken + offset)).toBe(false);
    }
    // And a slot two hours later survives.
    expect(after.some((s) => at(s.starts_at) === taken + 2 * 3600_000)).toBe(true);
  });

  it("frees the slot again when the appointment is cancelled", async () => {
    await bookable({ buffer_minutes: 0, max_per_day: 10 });
    const target = (await slots())[0]!;
    const a = await one<{ id: string }>(
      `select id from book_appointment_v6($1,$2,'person')`, [LEAD, target.starts_at]);
    expect((await slots()).some((s) => at(s.starts_at) === at(target.starts_at))).toBe(false);

    await db.query(`select record_appointment_outcome_v6($1,'cancelled','They rescheduled')`, [a.id]);
    expect((await slots()).some((s) => at(s.starts_at) === at(target.starts_at))).toBe(true);
  });
});

describe("taking a slot", () => {
  it("refuses a slot that was never on offer", async () => {
    await bookable();
    // Three in the morning is inside no window.
    const message = await refusal(
      `select book_appointment_v6($1, (now() + interval '2 days')::date + time '03:00', 'person')`,
      [LEAD]);
    expect(message).toContain("not available");
  });

  it("refuses a second person for the same slot", async () => {
    await bookable({ buffer_minutes: 0, max_per_day: 10 });
    const target = (await slots())[0]!;
    await db.query(`select book_appointment_v6($1,$2,'person')`, [LEAD, target.starts_at]);
    const message = await refusal(
      `select book_appointment_v6($1,$2,'person')`, [OTHER_LEAD, target.starts_at]);
    expect(message).toContain("not available");
  });

  it("refuses a probe lead, so no fake call reaches the diary", async () => {
    await bookable();
    await db.query(`update client_leads set is_probe = true where id = $1`, [LEAD]);
    const target = (await slots())[0]!;
    expect(await refusal(`select book_appointment_v6($1,$2,'person')`, [LEAD, target.starts_at]))
      .toContain("probe lead");
  });

  it("refuses when the client is not taking bookings", async () => {
    await bookable();
    const target = (await slots())[0]!;
    await db.query(`update client_booking_settings set enabled = false where client_id = $1`, [CLIENT]);
    expect(await refusal(`select book_appointment_v6($1,$2,'person')`, [LEAD, target.starts_at]))
      .toContain("not taking bookings");
  });

  it("moves the lead to appointment and records the event", async () => {
    await bookable();
    const target = (await slots())[0]!;
    await db.query(`select book_appointment_v6($1,$2,'sales_agent')`, [LEAD, target.starts_at]);

    const lead = await one<{ stage: string; appointment_at: string }>(
      `select stage, appointment_at from client_leads where id = $1`, [LEAD]);
    expect(lead.stage).toBe("appointment");
    expect(lead.appointment_at).toBeTruthy();
    const event = await one<{ kind: string; detail: string }>(
      `select kind, detail from lead_events where lead_id = $1 order by created_at desc limit 1`,
      [LEAD]);
    expect(event.kind).toBe("appointment");
    expect(event.detail).toContain("sales_agent");
  });

  it("does not drag a lead backwards from a later stage", async () => {
    await bookable();
    await db.query(`update client_leads set stage = 'sale' where id = $1`, [LEAD]);
    const target = (await slots())[0]!;
    await db.query(`select book_appointment_v6($1,$2,'person')`, [LEAD, target.starts_at]);
    expect((await one<{ stage: string }>(
      `select stage from client_leads where id = $1`, [LEAD])).stage).toBe("sale");
  });

  it("records who booked it, and how", async () => {
    await bookable({ max_per_day: 10, buffer_minutes: 0 });
    const got = await slots();
    await db.query(`select book_appointment_v6($1,$2,'person')`, [LEAD, got[0]!.starts_at]);
    await db.query(`select book_appointment_v6($1,$2,'public_link')`, [OTHER_LEAD, got[1]!.starts_at]);
    const routes = await rows<{ booked_via: string; booked_by: string | null }>(
      `select booked_via, booked_by from client_appointments order by starts_at`);
    expect(routes.map((r) => r.booked_via)).toEqual(["person", "public_link"]);
    // Only a person's booking records a person.
    expect(routes[0]!.booked_by).toBe(MANAGER);
    expect(routes[1]!.booked_by).toBeNull();
  });
});

describe("what became of it", () => {
  async function booked(): Promise<string> {
    await bookable();
    const target = (await slots())[0]!;
    const a = await one<{ id: string }>(
      `select id from book_appointment_v6($1,$2,'person')`, [LEAD, target.starts_at]);
    return a.id;
  }

  it("moves the lead to shown when they attend", async () => {
    const id = await booked();
    await db.query(`select record_appointment_outcome_v6($1,'attended',null)`, [id]);
    expect((await one<{ stage: string }>(
      `select stage from client_leads where id = $1`, [LEAD])).stage).toBe("shown");
  });

  it("leaves the lead where it is on a no-show, because that is the point of the stage", async () => {
    const id = await booked();
    await db.query(`select record_appointment_outcome_v6($1,'no_show',null)`, [id]);
    expect((await one<{ stage: string }>(
      `select stage from client_leads where id = $1`, [LEAD])).stage).toBe("appointment");
  });

  it("requires a reason to cancel", async () => {
    const id = await booked();
    expect(await refusal(`select record_appointment_outcome_v6($1,'cancelled',null)`, [id]))
      .toContain("Say why");
  });

  it("refuses an outcome that is not one of the three", async () => {
    const id = await booked();
    expect(await refusal(`select record_appointment_outcome_v6($1,'booked',null)`, [id]))
      .toContain("attended, no_show or cancelled");
  });
});

describe("the public link", () => {
  /** The caller generates the token; the database only ever sees its hash. */
  const TOKEN = "a".repeat(64);
  const hashOf = async (token: string) =>
    (await one<{ h: string }>(
      `select encode(sha256(convert_to($1,'UTF8')),'hex') as h`, [token])).h;

  it("stores only the hash of a token it never saw", async () => {
    const hash = await hashOf(TOKEN);
    const made = await one<{ id: string; token_hash: string }>(
      `select id, token_hash from create_booking_link_v6($1,'Book a survey',$2)`, [CLIENT, hash]);
    expect(made.token_hash).toBe(hash);
    expect(made.token_hash).not.toBe(TOKEN);

    await db.query(`select set_config('test.role','service_role',false)`);
    const resolved = await rows<{ client_id: string }>(
      `select * from resolve_booking_link_v6($1)`, [TOKEN]);
    expect(resolved[0]!.client_id).toBe(CLIENT);
  });

  it("refuses anything that is not a 64-character hash", async () => {
    expect(await refusal(`select create_booking_link_v6($1,'Book a survey','not-a-hash')`, [CLIENT]))
      .toContain("64 hex characters");
  });

  it("resolves nothing for a revoked, disabled or expired link", async () => {
    await db.query(`select create_booking_link_v6($1,'Book a survey',$2)`,
      [CLIENT, await hashOf(TOKEN)]);
    await db.query(`select set_config('test.role','service_role',false)`);
    for (const change of [
      `update booking_links set revoked_at = now()`,
      `update booking_links set revoked_at = null, enabled = false`,
      `update booking_links set enabled = true, expires_at = now() - interval '1 day'`,
    ]) {
      await db.query(change);
      expect(await rows(`select * from resolve_booking_link_v6($1)`, [TOKEN])).toHaveLength(0);
    }
  });
});

describe("why nobody can book", () => {
  it("walks the reasons as a client is set up", async () => {
    const read = async () =>
      (await one<{ blocker: string | null }>(
        `select blocker from booking_readiness where client_id = $1`, [CLIENT])).blocker;

    expect(await read()).toMatch(/no booking settings/i);

    await bookable();
    await db.query(`update client_booking_settings set enabled = false where client_id = $1`, [CLIENT]);
    expect(await read()).toMatch(/switched off/i);

    await db.query(`update client_booking_settings set enabled = true where client_id = $1`, [CLIENT]);
    await db.query(`delete from client_booking_windows where client_id = $1`, [CLIENT]);
    expect(await read()).toMatch(/No hours are recorded/i);

    await bookable();
    expect(await read()).toMatch(/no live booking link/i);

    await db.query(
      `select create_booking_link_v6($1,'Book a survey', repeat('b',64))`, [CLIENT]);
    expect(await read()).toBeNull();
  });

  it("tells no-hours apart from no-free-slot", async () => {
    // Hours exist, but the notice period pushes every slot past the horizon.
    await bookable({ min_notice_hours: 72, max_days_ahead: 1 });
    expect((await one<{ blocker: string }>(
      `select blocker from booking_readiness where client_id = $1`, [CLIENT])).blocker)
      .toMatch(/no slot is free inside the notice period/i);
  });
});


describe("booking through the public link", () => {
  const TOKEN = "c".repeat(64);
  const hashOf = async (token: string) =>
    (await one<{ h: string }>(
      `select encode(sha256(convert_to($1,'UTF8')),'hex') as h`, [token])).h;

  async function link(): Promise<void> {
    await db.query(`select create_booking_link_v6($1,'Book a survey',$2)`,
      [CLIENT, await hashOf(TOKEN)]);
    await db.query(`select set_config('test.role','service_role',false)`);
  }

  it("refuses a link that is not accepting bookings, in one sentence", async () => {
    await bookable();
    await db.query(`select set_config('test.role','service_role',false)`);
    const message = await refusal(
      `select book_from_public_link_v6($1,'Someone','a@b.test',null, now() + interval '2 days', 'They agreed')`,
      ["d".repeat(64)]);
    // Never says which of revoked, disabled or expired: that would be a
    // probing tool for anybody on the internet.
    expect(message).toBe("This booking link is not accepting bookings.");
  });

  it("creates the lead and takes the slot in one go", async () => {
    await bookable();
    const target = (await slots())[0]!;
    await link();
    const booked = await one<{ appointment_id: string; lead_id: string }>(
      `select * from book_from_public_link_v6($1,'Priya Raman','new@example.com',null,$2,'They agreed to a call')`,
      [TOKEN, target.starts_at]);
    expect(booked.appointment_id).toBeTruthy();

    const lead = await one<{ stage: string; consent_wording: string; source: string }>(
      `select stage, consent_wording, source from client_leads where id = $1`, [booked.lead_id]);
    expect(lead.stage).toBe("appointment");
    expect(lead.consent_wording).toBe("They agreed to a call");
    expect(lead.source).toBe("booking_link");
  });

  it("does not fork the history of somebody who books twice", async () => {
    await bookable({ max_per_day: 10, buffer_minutes: 0 });
    const got = await slots();
    await link();
    const first = await one<{ lead_id: string }>(
      `select * from book_from_public_link_v6($1,'Priya','twice@example.com',null,$2,'Agreed')`,
      [TOKEN, got[0]!.starts_at]);
    // Cancel so the daily count does not block the second.
    await db.query(`update client_appointments set status = 'cancelled'`);
    const second = await one<{ lead_id: string }>(
      `select * from book_from_public_link_v6($1,'Priya','twice@example.com',null,$2,'Agreed')`,
      [TOKEN, got[1]!.starts_at]);
    expect(second.lead_id).toBe(first.lead_id);
  });

  it("needs a way to reach them, and a record of what they agreed to", async () => {
    await bookable();
    const target = (await slots())[0]!;
    await link();
    expect(await refusal(
      `select book_from_public_link_v6($1,'Nobody',null,null,$2,'Agreed')`, [TOKEN, target.starts_at]))
      .toContain("email address or a phone number");
    expect(await refusal(
      `select book_from_public_link_v6($1,'Someone','a@b.test',null,$2,'  ')`, [TOKEN, target.starts_at]))
      .toContain("Record what they agreed to");
  });

  it("serves the same slots the client would honour", async () => {
    await bookable();
    const direct = await slots();
    await link();
    const viaLink = await rows<{ starts_at: Date }>(
      `select starts_at from public_slots_for_link_v6($1, 7) order by starts_at`, [TOKEN]);
    expect(viaLink.map((s) => at(s.starts_at))).toEqual(direct.map((s) => at(s.starts_at)));
  });

  it("serves nothing for a dead link rather than erroring", async () => {
    await bookable();
    await db.query(`select set_config('test.role','service_role',false)`);
    expect(await rows(`select * from public_slots_for_link_v6($1, 7)`, ["e".repeat(64)]))
      .toHaveLength(0);
  });
});
