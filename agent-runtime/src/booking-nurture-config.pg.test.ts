import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 281 against a real Postgres.
 *
 * 281 exists because booking and nurture were built with no way to put the
 * configuration in: nothing wrote the four tables below, so production held
 * zero rows in all of them and the machinery ran correctly over an empty
 * week. The things worth asserting are the ones that would quietly promise a
 * prospect something:
 *
 *   - a timezone the server does not know, so every slot lands an hour out
 *   - two windows on one day that offer the same minute twice
 *   - booking switched on over an empty week
 *   - a sequence that exits on the stage it triggers on
 *   - a campaign belonging to somebody else
 *   - steps with a gap, so step 3 sends second
 *   - another client's template, or one nobody approved
 *   - a shape change that keeps its old approval
 *
 * The harness stubs what earlier migrations provide, in the same shape they
 * provide it. `can_access_client` reads a GUC so a test can be somebody who
 * may not configure this client.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const CAMPAIGN = "66666666-6666-4666-8666-666666666666";
const OTHER_CAMPAIGN = "77777777-7777-4777-8777-777777777777";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(query, params)).rows;
}
async function one<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(query, params))[0]!;
}

/** A week: two windows on Monday, one on Wednesday. Minutes from midnight. */
const WEEK = JSON.stringify([
  { day_of_week: 1, starts_at_minute: 540, ends_at_minute: 720 },
  { day_of_week: 1, starts_at_minute: 780, ends_at_minute: 1020 },
  { day_of_week: 3, starts_at_minute: 540, ends_at_minute: 720 },
]);

/** The settings call every test starts from, with sane figures. */
async function settings(zone = "Africa/Johannesburg"): Promise<void> {
  await db.query("select set_client_booking_settings_v6($1,$2,30,15,24,30,4)", [CLIENT, zone]);
}

/** An approved template version for this client, ready to put in a step. */
async function template(client = CLIENT, approved = true): Promise<string> {
  const version = (
    await one<{ id: string }>(
      `insert into message_template_versions (client_id, subject, body)
       values ($1,'Subject','Body') returning id`,
      [client],
    )
  ).id;
  if (approved) {
    await db.query(
      `insert into message_template_approvals (template_version_id, client_id, status)
       values ($1,$2,'approved')`,
      [version, client],
    );
  }
  return version;
}

async function sequence(): Promise<string> {
  return (
    await one<{ id: string }>(
      `select id from create_nurture_sequence_v6(
         $1,'Magnet follow up','magnet_follow_up','lead'::lead_stage,2,
         array['appointment','lost']::lead_stage[],false,null)`,
      [CLIENT],
    )
  ).id;
}

beforeEach(async () => {
  await db?.close();
  db = new PGlite();

  await db.exec(`
 create schema if not exists auth;
 create role authenticated; create role anon; create role service_role;
 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_campaigns(id uuid primary key, client_id uuid not null references clients(id));

 create type lead_stage as enum (
   'lead','conversation','qualified_conversation','appointment','qualified_appointment',
   'shown','sale','cash','lost','profile_visit','follower','qualified');

 -- 255's two tables, with their own checks: the function leans on these
 -- rather than restating the ranges.
 create table client_booking_settings (
   client_id uuid primary key references clients(id) on delete cascade,
   timezone text not null default 'Europe/London',
   slot_minutes integer not null default 30 check (slot_minutes between 5 and 240),
   buffer_minutes integer not null default 15 check (buffer_minutes between 0 and 240),
   min_notice_hours integer not null default 24 check (min_notice_hours between 0 and 720),
   max_days_ahead integer not null default 30 check (max_days_ahead between 1 and 365),
   max_per_day integer not null default 4 check (max_per_day between 1 and 50),
   enabled boolean not null default false,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now());

 create table client_booking_windows (
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   day_of_week integer not null check (day_of_week between 0 and 6),
   starts_at_minute integer not null check (starts_at_minute between 0 and 1439),
   ends_at_minute integer not null check (ends_at_minute between 1 and 1440),
   created_at timestamptz not null default now(),
   check (ends_at_minute > starts_at_minute),
   unique (client_id, day_of_week, starts_at_minute));

 create table message_template_versions (
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   subject text, body text not null);

 create table message_template_approvals (
   id uuid primary key default gen_random_uuid(),
   template_version_id uuid not null references message_template_versions(id),
   client_id uuid not null references clients(id),
   status text not null, revoked_at timestamptz);

 create table nurture_sequences (
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text not null check (length(btrim(name)) between 1 and 200),
   purpose text not null check (purpose in ('magnet_follow_up','objection','reengagement','booking')),
   campaign_id uuid references client_campaigns(id) on delete set null,
   trigger_stage lead_stage not null,
   trigger_after_hours integer not null check (trigger_after_hours between 0 and 8760),
   exit_stages lead_stage[] not null,
   enrolled_automatically boolean not null default false,
   approved_at timestamptz, approved_by uuid references profiles(id),
   archived_at timestamptz, created_by uuid references profiles(id),
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now(),
   unique (id, client_id));

 create table nurture_sequence_steps (
   id uuid primary key default gen_random_uuid(),
   sequence_id uuid not null references nurture_sequences(id) on delete cascade,
   client_id uuid not null references clients(id) on delete cascade,
   position integer not null check (position >= 1),
   delay_hours integer not null check (delay_hours between 0 and 8760),
   template_version_id uuid not null references message_template_versions(id) on delete restrict,
   created_at timestamptz not null default now(),
   unique (sequence_id, position));

 -- 252's guard, which is what makes a shape change clear the approval.
 create function guard_sequence_shape_change() returns trigger
  language plpgsql set search_path to 'pg_catalog','public' as $g$
 declare v_sequence uuid;
 begin
   v_sequence := coalesce(new.sequence_id, old.sequence_id);
   update nurture_sequences set approved_at = null, approved_by = null
    where id = v_sequence and approved_at is not null;
   return coalesce(new, old);
 end $g$;
 create trigger guard_sequence_shape after insert or update or delete
   on nurture_sequence_steps for each row execute function guard_sequence_shape_change();

 create function auth.uid() returns uuid language sql stable as $a$
   select '${MANAGER}'::uuid $a$;

 -- Whether the caller may configure this client at all. A GUC so a test can
 -- be somebody who may not.
 create function can_access_client(p_client_id uuid) returns boolean
  language sql stable as $c$
   select coalesce(current_setting('test.deny', true), '') <> p_client_id::text $c$;

 create function lock_down_definer_functions() returns void language sql as $l$
   select null::void $l$;

 insert into clients values('${CLIENT}'),('${OTHER}');
 insert into profiles(id) values('${MANAGER}');
 insert into client_campaigns values('${CAMPAIGN}','${CLIENT}'),('${OTHER_CAMPAIGN}','${OTHER}');`);

  await db.exec(await sql("20261030180000_281_the_configuration_nobody_can_enter.sql"));
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("the hours a client will honour", () => {
  it("records them, and leaves the switch alone", async () => {
    const row = await one<{ timezone: string; slot_minutes: number; enabled: boolean }>(
      "select * from set_client_booking_settings_v6($1,'Africa/Johannesburg',45,10,12,21,3)",
      [CLIENT],
    );
    // The figures land, and `enabled` is untouched: stating the hours is not
    // the decision to let somebody take one.
    expect(row).toMatchObject({ timezone: "Africa/Johannesburg", slot_minutes: 45, enabled: false });
  });

  it("refuses a timezone the server does not know", async () => {
    await expect(settings("Mars/Olympus_Mons")).rejects.toThrow(/Unknown timezone/);
  });

  it("refuses a caller who may not configure this client", async () => {
    await db.exec(`set test.deny = '${CLIENT}'`);
    await expect(settings()).rejects.toThrow("Not permitted for this client");
  });

  it("updates in place rather than making a second row", async () => {
    await settings();
    await db.query("select set_client_booking_settings_v6($1,'Europe/London',60,0,48,60,2)", [CLIENT]);
    const all = await rows("select * from client_booking_settings where client_id = $1", [CLIENT]);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ timezone: "Europe/London", slot_minutes: 60 });
  });
});

describe("the bookable week", () => {
  it("swaps the whole week in one call", async () => {
    await settings();
    const written = await rows<{ day_of_week: number }>(
      "select * from replace_client_booking_windows_v6($1,$2::jsonb)",
      [CLIENT, WEEK],
    );
    expect(written.map((w) => w.day_of_week)).toEqual([1, 1, 3]);

    // Replacing with a smaller week leaves no trace of the larger one.
    await db.query("select replace_client_booking_windows_v6($1,$2::jsonb)", [
      CLIENT,
      JSON.stringify([{ day_of_week: 5, starts_at_minute: 600, ends_at_minute: 660 }]),
    ]);
    const after = await rows<{ day_of_week: number }>(
      "select day_of_week from client_booking_windows where client_id = $1",
      [CLIENT],
    );
    expect(after.map((w) => w.day_of_week)).toEqual([5]);
  });

  it("refuses two windows that offer the same minute twice", async () => {
    await settings();
    await expect(
      db.query("select replace_client_booking_windows_v6($1,$2::jsonb)", [
        CLIENT,
        JSON.stringify([
          { day_of_week: 1, starts_at_minute: 540, ends_at_minute: 720 },
          { day_of_week: 1, starts_at_minute: 660, ends_at_minute: 840 },
        ]),
      ]),
    ).rejects.toThrow(/overlap on day 1/);
  });

  it("allows windows that touch without overlapping", async () => {
    await settings();
    const written = await rows(
      "select * from replace_client_booking_windows_v6($1,$2::jsonb)",
      [
        CLIENT,
        JSON.stringify([
          { day_of_week: 2, starts_at_minute: 540, ends_at_minute: 720 },
          { day_of_week: 2, starts_at_minute: 720, ends_at_minute: 900 },
        ]),
      ],
    );
    expect(written).toHaveLength(2);
  });

  it("will not empty the week of a client whose booking is on", async () => {
    await settings();
    await db.query("select replace_client_booking_windows_v6($1,$2::jsonb)", [CLIENT, WEEK]);
    await db.query("select set_client_booking_enabled_v6($1,true)", [CLIENT]);

    await expect(
      db.query("select replace_client_booking_windows_v6($1,'[]'::jsonb)", [CLIENT]),
    ).rejects.toThrow(/cannot be emptied/);

    // And the week it refused to empty is still there.
    const kept = await one<{ n: number }>(
      "select count(*)::integer as n from client_booking_windows where client_id = $1",
      [CLIENT],
    );
    expect(kept.n).toBe(3);
  });
});

describe("the booking switch", () => {
  it("refuses to go on over an empty week", async () => {
    await settings();
    await expect(db.query("select set_client_booking_enabled_v6($1,true)", [CLIENT])).rejects.toThrow(
      /no bookable hours/,
    );
  });

  it("goes on once there are hours, and off again", async () => {
    await settings();
    await db.query("select replace_client_booking_windows_v6($1,$2::jsonb)", [CLIENT, WEEK]);
    const on = await one<{ enabled: boolean }>("select * from set_client_booking_enabled_v6($1,true)", [
      CLIENT,
    ]);
    expect(on.enabled).toBe(true);
    const off = await one<{ enabled: boolean }>("select * from set_client_booking_enabled_v6($1,false)", [
      CLIENT,
    ]);
    expect(off.enabled).toBe(false);
  });

  it("refuses a client whose rules were never set", async () => {
    await expect(db.query("select set_client_booking_enabled_v6($1,true)", [CLIENT])).rejects.toThrow(
      /booking rules before/,
    );
  });
});

describe("a nurture sequence", () => {
  it("is created unapproved", async () => {
    const row = await one<{ approved_at: string | null; created_by: string }>(
      "select * from nurture_sequences where id = $1",
      [await sequence()],
    );
    // Nothing enrols into an unapproved sequence, which is why creating one
    // is safe and approving it is the decision.
    expect(row.approved_at).toBeNull();
    expect(row.created_by).toBe(MANAGER);
  });

  it("refuses a sequence that exits on the stage it triggers on", async () => {
    await expect(
      db.query(
        `select create_nurture_sequence_v6($1,'Loop','booking','lead'::lead_stage,1,
           array['lead']::lead_stage[],false,null)`,
        [CLIENT],
      ),
    ).rejects.toThrow(/cannot also be an exit stage/);
  });

  it("refuses a sequence with no way out", async () => {
    await expect(
      db.query(
        `select create_nurture_sequence_v6($1,'Forever','booking','lead'::lead_stage,1,
           array[]::lead_stage[],false,null)`,
        [CLIENT],
      ),
    ).rejects.toThrow(/at least one exit stage/);
  });

  it("refuses another client's campaign", async () => {
    await expect(
      db.query(
        `select create_nurture_sequence_v6($1,'Borrowed','booking','lead'::lead_stage,1,
           array['sale']::lead_stage[],false,$2)`,
        [CLIENT, OTHER_CAMPAIGN],
      ),
    ).rejects.toThrow(/does not belong to this client/);
  });
});

describe("a sequence's steps", () => {
  it("replaces them in order", async () => {
    const id = await sequence();
    const first = await template();
    const second = await template();
    const written = await rows<{ position: number }>(
      "select * from set_nurture_sequence_steps_v6($1,$2::jsonb)",
      [
        id,
        JSON.stringify([
          { position: 1, delay_hours: 0, template_version_id: first },
          { position: 2, delay_hours: 48, template_version_id: second },
        ]),
      ],
    );
    expect(written.map((s) => s.position)).toEqual([1, 2]);
  });

  it("refuses a gap, because step 3 would send second", async () => {
    const id = await sequence();
    const only = await template();
    await expect(
      db.query("select set_nurture_sequence_steps_v6($1,$2::jsonb)", [
        id,
        JSON.stringify([
          { position: 1, delay_hours: 0, template_version_id: only },
          { position: 3, delay_hours: 24, template_version_id: only },
        ]),
      ]),
    ).rejects.toThrow(/must run 1 to 2/);
  });

  it("refuses a template nobody approved", async () => {
    const id = await sequence();
    const unapproved = await template(CLIENT, false);
    await expect(
      db.query("select set_nurture_sequence_steps_v6($1,$2::jsonb)", [
        id,
        JSON.stringify([{ position: 1, delay_hours: 0, template_version_id: unapproved }]),
      ]),
    ).rejects.toThrow(/no current approval/);
  });

  it("refuses a template whose approval was withdrawn", async () => {
    const id = await sequence();
    const version = await template();
    await db.query("update message_template_approvals set revoked_at = now() where template_version_id = $1", [
      version,
    ]);
    await expect(
      db.query("select set_nurture_sequence_steps_v6($1,$2::jsonb)", [
        id,
        JSON.stringify([{ position: 1, delay_hours: 0, template_version_id: version }]),
      ]),
    ).rejects.toThrow(/no current approval/);
  });

  it("refuses another client's template", async () => {
    const id = await sequence();
    const theirs = await template(OTHER);
    await expect(
      db.query("select set_nurture_sequence_steps_v6($1,$2::jsonb)", [
        id,
        JSON.stringify([{ position: 1, delay_hours: 0, template_version_id: theirs }]),
      ]),
    ).rejects.toThrow(/belongs to another client/);
  });

  it("clears the sequence's approval when the shape changes", async () => {
    const id = await sequence();
    const first = await template();
    await db.query("select set_nurture_sequence_steps_v6($1,$2::jsonb)", [
      id,
      JSON.stringify([{ position: 1, delay_hours: 0, template_version_id: first }]),
    ]);
    await db.query("update nurture_sequences set approved_at = now(), approved_by = $2 where id = $1", [
      id,
      MANAGER,
    ]);

    const second = await template();
    await db.query("select set_nurture_sequence_steps_v6($1,$2::jsonb)", [
      id,
      JSON.stringify([
        { position: 1, delay_hours: 0, template_version_id: first },
        { position: 2, delay_hours: 72, template_version_id: second },
      ]),
    ]);

    // 252's guard, not anything 281 added: a different shape is a different
    // thing to agree to.
    const after = await one<{ approved_at: string | null }>(
      "select approved_at from nurture_sequences where id = $1",
      [id],
    );
    expect(after.approved_at).toBeNull();
  });

  it("refuses a caller who may not configure the sequence's client", async () => {
    const id = await sequence();
    const version = await template();
    await db.exec(`set test.deny = '${CLIENT}'`);
    await expect(
      db.query("select set_nurture_sequence_steps_v6($1,$2::jsonb)", [
        id,
        JSON.stringify([{ position: 1, delay_hours: 0, template_version_id: version }]),
      ]),
    ).rejects.toThrow("Not permitted for this client");
  });
});
