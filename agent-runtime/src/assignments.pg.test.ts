import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 166 against a real Postgres.
 *
 * job_assignments carried one nullable timestamp, so a piece of work was
 * either outstanding or finished. Four live faults followed, and the tests
 * below are mostly about those:
 *
 *   delivered and approved were the same thing, so the agency's queue closed
 *   a job while the asset was still unreviewed; a rejection reached nobody,
 *   because the assignment was already closed; nobody could decline; and
 *   due_date had never been compared to anything.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const EDITOR = "22222222-2222-4222-8222-222222222222";
const OTHER_EDITOR = "33333333-3333-4333-8333-333333333333";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EDITOR_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BRIEF = "44444444-4444-4444-8444-444444444444";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}
async function as<T = Record<string, unknown>>(sub: string, sql: string): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.sub','${sub}',false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
  }
}

async function assignment(over: { member?: string; due?: string | null } = {}): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into job_assignments (member_id, client_id, title, brief_id, due_date, compensation)
     values ('${over.member ?? EDITOR}','${CLIENT}','Cut the reel','${BRIEF}',
             ${over.due === undefined ? "current_date + 3" : over.due === null ? "null" : `date '${over.due}'`}, 500)
     returning id`,
  );
  return id;
}

async function asset(over: { member?: string } = {}): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into client_media_assets (client_id, brief_id, member_id, title)
     values ('${CLIENT}','${BRIEF}','${over.member ?? EDITOR}','Delivered cut') returning id`,
  );
  return id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

    create type review_status as enum ('pending','approved','rejected');
    create type media_type as enum ('image','text','video');

    create table clients (id uuid primary key, name text);
    create table profiles (id uuid primary key, role text);
    create table team_members (id uuid primary key, user_id uuid, name text, active boolean default true);
    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role='admin') $$;
    create function is_member(target uuid) returns boolean language sql stable security definer as
      $$ select exists (select 1 from team_members t where t.id = target and t.user_id = auth.uid()) $$;
    create function can_access_client(p uuid) returns boolean language sql stable as $$ select true $$;

    create table client_briefs (id uuid primary key, title text);
    create table client_media_assets (id uuid primary key default gen_random_uuid(),
      client_id uuid, brief_id uuid, member_id uuid, title text,
      review_status review_status not null default 'pending', human_approved_at timestamptz);
    create table client_asset_reviews (id uuid primary key default gen_random_uuid(),
      asset_id uuid, decision review_status, reason text, reviewed_by uuid,
      created_at timestamptz default clock_timestamp());

    create table job_assignments (id uuid primary key default gen_random_uuid(),
      member_id uuid not null references team_members(id) on delete cascade,
      client_id uuid, title text not null, due_date date, compensation numeric,
      completed_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default now(),
      brief_id uuid);

    -- The real one, shortened to what these tests touch.
    create function review_media_asset(p_asset_id uuid, p_decision review_status, p_reason text default null)
      returns void language plpgsql security definer set search_path to 'public' as $$
      begin
        insert into client_asset_reviews (asset_id, decision, reason, reviewed_by)
        values (p_asset_id, p_decision, p_reason, auth.uid());
        update client_media_assets
           set review_status = p_decision,
               human_approved_at = case when p_decision='approved' then now() else null end
         where id = p_asset_id;
      end; $$;

    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;

    insert into auth.users (id) values ('${ADMIN}'), ('${EDITOR_USER}'), ('${OTHER_USER}');
    insert into profiles (id, role) values ('${ADMIN}','admin'),
      ('${EDITOR_USER}','staff'), ('${OTHER_USER}','staff');
    insert into clients (id, name) values ('${CLIENT}','Harbour');
    insert into team_members (id, user_id, name) values
      ('${EDITOR}','${EDITOR_USER}','Sam Editor'),
      ('${OTHER_EDITOR}','${OTHER_USER}','Ada Editor');
    insert into client_briefs (id, title) values ('${BRIEF}','The Chain');
  `);

  await db.exec(await migration("20261007140000_166_an_assignment_has_states.sql"));
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                 select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
});

beforeEach(async () => {
  // Assignments first: assignment_events is append-only and refuses a
  // delete while its parent still exists, so the cascade is the only way
  // out. That refusal is itself under test further down.
  await db.exec(`delete from job_assignments;
                 delete from client_asset_reviews; delete from client_media_assets;`);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                 select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
});

describe("a file arriving is not a file anybody has accepted", () => {
  it("leaves delivered work outstanding until a reviewer looks at it", async () => {
    // The first fault: the upload path set completed_at, so the agency's
    // queue closed the job while the asset sat at review_status 'pending'
    // and nothing was outstanding anywhere.
    const id = await assignment();
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);

    const row = await one<{ stage: string; completed_at: string | null; delivered_at: string | null }>(
      `select stage, completed_at, delivered_at from job_assignments where id = '${id}'`,
    );
    expect(row.stage).toBe("delivered");
    expect(row.delivered_at).not.toBeNull();
    // Not finished. This is the whole point.
    expect(row.completed_at).toBeNull();

    const { finished } = await one<{ finished: boolean }>(
      `select finished from assignment_board where assignment_id = '${id}'`,
    );
    expect(finished).toBe(false);
  });

  it("finishes it when the asset is approved", async () => {
    const id = await assignment();
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(`select review_media_asset('${a}','approved'::review_status,'Good.')`);

    const row = await one<{ stage: string; completed_at: string | null }>(
      `select stage, completed_at from job_assignments where id = '${id}'`,
    );
    expect(row.stage).toBe("approved");
    expect(row.completed_at).not.toBeNull();
  });
});

describe("a rejection has somewhere to go", () => {
  it("puts the work back on somebody's list, with the reviewer's own words", async () => {
    // The second fault: the assignment was already closed, so there was no
    // row saying somebody owed another version and the reason reached
    // nobody.
    const id = await assignment();
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(
      `select review_media_asset('${a}','rejected'::review_status,'The first three seconds are dead.')`,
    );

    const row = await one<{ stage: string; stage_reason: string; completed_at: string | null }>(
      `select stage, stage_reason, completed_at from job_assignments where id = '${id}'`,
    );
    expect(row.stage).toBe("rework");
    expect(row.stage_reason).toBe("The first three seconds are dead.");
    expect(row.completed_at).toBeNull();
  });

  it("takes the newest reason when an asset has been reviewed more than once", async () => {
    const id = await assignment();
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(`select review_media_asset('${a}','rejected'::review_status,'Too long.')`);
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(`select review_media_asset('${a}','rejected'::review_status,'Still too long.')`);
    const { stage_reason } = await one<{ stage_reason: string }>(
      `select stage_reason from job_assignments where id = '${id}'`,
    );
    expect(stage_reason).toBe("Still too long.");
  });

  it("says so rather than inventing a reason when none was recorded", async () => {
    const id = await assignment();
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(`select review_media_asset('${a}','rejected'::review_status, null)`);
    const { stage_reason } = await one<{ stage_reason: string }>(
      `select stage_reason from job_assignments where id = '${id}'`,
    );
    expect(stage_reason).toMatch(/no reason recorded/);
  });

  it("accepts another version after a rework, and finishes on approval", async () => {
    const id = await assignment();
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(`select review_media_asset('${a}','rejected'::review_status,'Shorter.')`);
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(`select review_media_asset('${a}','approved'::review_status,'Better.')`);

    const row = await one<{ stage: string; stage_reason: string | null }>(
      `select stage, stage_reason from job_assignments where id = '${id}'`,
    );
    expect(row.stage).toBe("approved");
    // The rework reason belongs to the rework, not to the finished job.
    expect(row.stage_reason).toBeNull();
  });

  it("leaves an asset with no assignment alone", async () => {
    const a = await asset();
    await db.exec(`select review_media_asset('${a}','approved'::review_status,'Fine.')`);
    expect(await rows(`select 1 from assignment_events`)).toHaveLength(0);
  });

  it("does not touch work that has not been delivered", async () => {
    // An asset uploaded against the brief by somebody else must not close
    // an assignment nobody has delivered.
    const id = await assignment();
    const a = await asset();
    await db.exec(`select review_media_asset('${a}','approved'::review_status,'Fine.')`);
    const { stage } = await one<{ stage: string }>(`select stage from job_assignments where id = '${id}'`);
    expect(stage).toBe("assigned");
  });
});

describe("saying no", () => {
  it("lets the person it was given to decline it", async () => {
    // The third fault: an editor who could not take a job had no way to say
    // so, and the agency found out when the due date passed.
    const id = await assignment();
    await as(EDITOR_USER, `select decline_assignment('${id}','Away until the 14th.')`);
    const row = await one<{ stage: string; stage_reason: string }>(
      `select stage, stage_reason from job_assignments where id = '${id}'`,
    );
    expect(row.stage).toBe("declined");
    expect(row.stage_reason).toBe("Away until the 14th.");
  });

  it("insists on a reason", async () => {
    const id = await assignment();
    await expect(as(EDITOR_USER, `select decline_assignment('${id}','  ')`)).rejects.toThrow(/Say why/);
  });

  it("will not let one editor decline another's work", async () => {
    const id = await assignment();
    await expect(
      as(OTHER_USER, `select decline_assignment('${id}','Not mine.')`),
    ).rejects.toThrow(/Not permitted for this assignment/);
  });

  it("sends declined work to somebody else in one act", async () => {
    const id = await assignment();
    await as(EDITOR_USER, `select decline_assignment('${id}','Away.')`);
    await db.exec(`select reassign_assignment('${id}','${OTHER_EDITOR}','Ada has capacity.')`);
    const row = await one<{ stage: string; member_id: string; stage_reason: string | null }>(
      `select stage, member_id, stage_reason from job_assignments where id = '${id}'`,
    );
    expect(row.stage).toBe("assigned");
    expect(row.member_id).toBe(OTHER_EDITOR);
    expect(row.stage_reason).toBeNull();
  });

  it("will not reassign work nobody declined", async () => {
    const id = await assignment();
    await expect(
      db.exec(`select reassign_assignment('${id}','${OTHER_EDITOR}')`),
    ).rejects.toThrow(/Only declined work is reassigned/);
  });

  it("will not reassign it to the person who declined it", async () => {
    const id = await assignment();
    await as(EDITOR_USER, `select decline_assignment('${id}','Away.')`);
    await expect(
      db.exec(`select reassign_assignment('${id}','${EDITOR}')`),
    ).rejects.toThrow(/the person who declined it/);
  });

  it("is an agency decision to reassign, not a maker's", async () => {
    const id = await assignment();
    await as(EDITOR_USER, `select decline_assignment('${id}','Away.')`);
    await expect(
      as(EDITOR_USER, `select reassign_assignment('${id}','${OTHER_EDITOR}')`),
    ).rejects.toThrow(/an agency decision/);
  });
});

describe("what is late", () => {
  it("compares due_date to today, which nothing had ever done", async () => {
    const late = await assignment({ due: "2026-01-01" });
    const soon = await assignment({ member: OTHER_EDITOR });
    const board = await rows<{ assignment_id: string; overdue: boolean; days_late: number | null }>(
      `select assignment_id, overdue, days_late from assignment_board order by due_date`,
    );
    const lateRow = board.find((r) => r.assignment_id === late)!;
    const soonRow = board.find((r) => r.assignment_id === soon)!;
    expect(lateRow.overdue).toBe(true);
    expect(lateRow.days_late).toBeGreaterThan(0);
    expect(soonRow.overdue).toBe(false);
  });

  it("does not call finished work late, however old it is", async () => {
    const id = await assignment({ due: "2026-01-01" });
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(`select review_media_asset('${a}','approved'::review_status,'Good.')`);
    const row = await one<{ overdue: boolean; days_late: number | null }>(
      `select overdue, days_late from assignment_board where assignment_id = '${id}'`,
    );
    expect(row.overdue).toBe(false);
    expect(row.days_late).toBeNull();
  });

  it("calls work sent back for rework late again, if its date has gone", async () => {
    // Rework on an overdue job is still overdue. Clearing it would hide the
    // worst case on the board.
    const id = await assignment({ due: "2026-01-01" });
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(`select review_media_asset('${a}','rejected'::review_status,'Again.')`);
    const { overdue } = await one<{ overdue: boolean }>(
      `select overdue from assignment_board where assignment_id = '${id}'`,
    );
    expect(overdue).toBe(true);
  });

  it("says nothing about a job with no date", async () => {
    const id = await assignment({ due: null });
    const row = await one<{ overdue: boolean; days_late: number | null }>(
      `select overdue, days_late from assignment_board where assignment_id = '${id}'`,
    );
    expect(row.overdue).toBe(false);
    expect(row.days_late).toBeNull();
  });

  it("does not treat delivered work as the maker's problem", async () => {
    // Waiting on a reviewer is not the maker being late.
    const id = await assignment({ due: "2026-01-01" });
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    const { overdue } = await one<{ overdue: boolean }>(
      `select overdue from assignment_board where assignment_id = '${id}'`,
    );
    expect(overdue).toBe(false);
  });
});

describe("one writer, and a log that cannot be edited", () => {
  it("refuses a direct update to the stage", async () => {
    const id = await assignment();
    await expect(
      db.exec(`update job_assignments set stage = 'approved' where id = '${id}'`),
    ).rejects.toThrow(/through advance_assignment/);
  });

  it("refuses a move that is not in the table of legal moves", async () => {
    const id = await assignment();
    await expect(
      db.exec(`select advance_assignment('${id}','approved'::assignment_stage)`),
    ).rejects.toThrow(/cannot go from assigned to approved/);
  });

  it("records every accepted move", async () => {
    const id = await assignment();
    await as(EDITOR_USER, `select accept_assignment('${id}')`);
    const a = await asset();
    await as(EDITOR_USER, `select deliver_assignment('${id}','${a}')`);
    await db.exec(`select review_media_asset('${a}','approved'::review_status,'Good.')`);

    const log = await rows<{ to_stage: string; actor: string }>(
      `select to_stage, actor from assignment_events where assignment_id = '${id}' order by created_at`,
    );
    expect(log.map((r) => r.to_stage)).toEqual(["accepted", "delivered", "approved"]);
    expect(log.map((r) => r.actor)).toEqual(["maker", "maker", "review"]);
  });

  it("will not let the log be edited", async () => {
    const id = await assignment();
    await as(EDITOR_USER, `select accept_assignment('${id}')`);
    await expect(db.exec(`update assignment_events set note = 'rewritten'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.exec(`delete from assignment_events`)).rejects.toThrow(/append-only/);
  });

  it("lets the history go when the assignment itself is deleted", async () => {
    // The cascade doing its job is not somebody editing the record.
    const id = await assignment();
    await as(EDITOR_USER, `select accept_assignment('${id}')`);
    await db.exec(`delete from job_assignments where id = '${id}'`);
    expect(await rows(`select 1 from assignment_events`)).toHaveLength(0);
  });

  it("refuses the same stage twice", async () => {
    const id = await assignment();
    await as(EDITOR_USER, `select accept_assignment('${id}')`);
    await expect(as(EDITOR_USER, `select accept_assignment('${id}')`)).rejects.toThrow(
      /already accepted/,
    );
  });
});
