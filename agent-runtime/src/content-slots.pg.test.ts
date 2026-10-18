import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 147 against a real Postgres.
 *
 * content_slots.stage is where the whole engine's progress is written, so
 * two things have to be true rather than intended: an illegal move is
 * refused, and nothing except advance_slot can move a slot at all. The
 * second is the one worth testing hardest — "advance_slot is the only
 * writer" is a sentence until something tries to write around it.
 *
 * The real migration file is applied, not a copy of it.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PILLAR = "33333333-3333-4333-8333-333333333333";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const AT = "2026-11-03 09:00+00";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}

async function asUser<T = Record<string, unknown>>(userId: string, sql: string): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false);`);
  await db.exec(`set role authenticated;`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`reset role;`);
  }
}

/** A fresh slot, at planned. */
async function newSlot(at = AT): Promise<string> {
  const { id } = await one<{ id: string }>(
    `select id from create_content_slot('${CLIENT}', 'instagram', timestamptz '${at}', '${PILLAR}')`,
  );
  return id;
}

/** Walk a slot forward through a list of stages. */
async function walk(slot: string, stages: string[], actor = "engine") {
  for (const stage of stages) {
    await db.exec(`select advance_slot('${slot}', '${stage}'::slot_stage, '${actor}')`);
  }
}

const stageOf = async (slot: string) =>
  (await one<{ stage: string }>(`select stage from content_slots where id = '${slot}'`)).stage;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create type post_platform as enum ('facebook', 'instagram', 'tiktok', 'linkedin', 'youtube');
    create type content_format as enum ('single', 'carousel', 'story', 'reel');

    create table clients (id uuid primary key, name text not null);
    create table profiles (id uuid primary key, role text);
    create table client_members (client_id uuid, user_id uuid);
    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable security definer as
      $$ select is_admin() or exists (
           select 1 from client_members m where m.client_id = p and m.user_id = auth.uid()) $$;

    create table client_content_pillars (
      id uuid primary key, client_id uuid references clients(id) on delete cascade,
      name text not null, active boolean not null default true);
    create table client_ideas (id uuid primary key default gen_random_uuid());
    create table client_briefs (id uuid primary key default gen_random_uuid());
    create table client_media_assets (id uuid primary key default gen_random_uuid(), title text);
    create table scheduled_posts (id uuid primary key default gen_random_uuid());

    insert into auth.users (id) values ('${ADMIN}'), ('${MEMBER}');
    insert into profiles (id, role) values ('${ADMIN}', 'admin'), ('${MEMBER}', 'staff');
    insert into clients (id, name) values ('${CLIENT}', 'Harbour'), ('${OTHER}', 'Other');
    insert into client_members (client_id, user_id) values ('${CLIENT}', '${MEMBER}');
    insert into client_content_pillars (id, client_id, name) values ('${PILLAR}', '${CLIENT}', 'Proof');
  `);

  await db.exec(await migration("20261005230000_147_content_slots.sql"));
  // Production grants authenticated select on all of these, with RLS doing
  // the filtering. security_invoker views need the caller to hold those
  // grants, so the fixture has to match or the view fails for the wrong reason.
  await db.exec(`grant usage on schema public, auth to authenticated;
                 grant select on clients, client_content_pillars, client_media_assets,
                   client_ideas, client_briefs, scheduled_posts to authenticated;`);
});

beforeEach(async () => {
  // Back to the owner first. A test that left the authenticated role set
  // would make this delete a silent no-op under RLS rather than an error,
  // and the leftovers would surface as a failure in whatever ran next.
  await db.exec(`reset role;`);
  // Deleting the slot takes its history with it; deleting the history alone is refused.
  await db.exec(`delete from content_slots;`);
  await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
});

describe("planning a slot", () => {
  it("is born at planned, with its first event", async () => {
    const slot = await newSlot();
    expect(await stageOf(slot)).toBe("planned");
    const { from_stage, to_stage } = await one<{ from_stage: string | null; to_stage: string }>(
      `select from_stage, to_stage from slot_events where slot_id = '${slot}'`,
    );
    // Nothing moved it to planned; it started there.
    expect(from_stage).toBeNull();
    expect(to_stage).toBe("planned");
  });

  it("is idempotent on the same window, so a planner that runs twice makes one post", async () => {
    const first = await newSlot();
    const second = await newSlot();
    expect(second).toBe(first);
    const { n } = await one<{ n: number }>(`select count(*)::int as n from content_slots`);
    expect(n).toBe(1);
  });

  it("does not log a second planned event for the slot it found", async () => {
    await newSlot();
    await newSlot();
    const { n } = await one<{ n: number }>(`select count(*)::int as n from slot_events`);
    expect(n).toBe(1);
  });

  it("treats a different instant as a different slot", async () => {
    await newSlot();
    await newSlot("2026-11-04 09:00+00");
    const { n } = await one<{ n: number }>(`select count(*)::int as n from content_slots`);
    expect(n).toBe(2);
  });
});

describe("the path", () => {
  it("walks all the way to published", async () => {
    const slot = await newSlot();
    await walk(slot, [
      "ideating",
      "idea_selected",
      "briefing",
      "building",
      "copywriting",
      "qa",
      "awaiting_approval",
      "scheduled",
      "published",
    ]);
    expect(await stageOf(slot)).toBe("published");
    const { n } = await one<{ n: number }>(`select count(*)::int as n from slot_events where slot_id = '${slot}'`);
    // Nine moves plus the planned row it was born with.
    expect(n).toBe(10);
  });

  it("records every move with where it came from", async () => {
    const slot = await newSlot();
    await walk(slot, ["ideating", "idea_selected"]);
    const rows = await db.query<{ from_stage: string | null; to_stage: string }>(
      `select from_stage, to_stage from slot_events where slot_id = '${slot}' order by created_at`,
    );
    expect(rows.rows).toEqual([
      { from_stage: null, to_stage: "planned" },
      { from_stage: "planned", to_stage: "ideating" },
      { from_stage: "ideating", to_stage: "idea_selected" },
    ]);
  });
});

describe("illegal moves", () => {
  it("refuses a jump that skips the work in between", async () => {
    const slot = await newSlot();
    await expect(db.exec(`select advance_slot('${slot}', 'published'::slot_stage)`)).rejects.toThrow(
      /cannot go from planned to published/,
    );
    expect(await stageOf(slot)).toBe("planned");
  });

  it("refuses going backwards up the path", async () => {
    const slot = await newSlot();
    await walk(slot, ["ideating", "idea_selected", "briefing"]);
    await expect(db.exec(`select advance_slot('${slot}', 'ideating'::slot_stage)`)).rejects.toThrow(
      /cannot go from briefing to ideating/,
    );
  });

  it("refuses to move a slot to where it already is", async () => {
    const slot = await newSlot();
    await expect(db.exec(`select advance_slot('${slot}', 'planned'::slot_stage)`)).rejects.toThrow(
      /already planned/,
    );
  });

  it("refuses anything at all out of published", async () => {
    const slot = await newSlot();
    await walk(slot, [
      "ideating", "idea_selected", "briefing", "building", "copywriting", "qa",
      "awaiting_approval", "scheduled", "published",
    ]);
    for (const stage of ["planned", "failed", "scheduled", "rejected"]) {
      await expect(db.exec(`select advance_slot('${slot}', '${stage}'::slot_stage)`)).rejects.toThrow(
        /cannot go from published/,
      );
    }
  });

  it("refuses an unknown actor", async () => {
    const slot = await newSlot();
    await expect(
      db.exec(`select advance_slot('${slot}', 'ideating'::slot_stage, 'robot')`),
    ).rejects.toThrow(/Unknown actor/);
  });

  it("refuses a slot that does not exist", async () => {
    await expect(
      db.exec(`select advance_slot(gen_random_uuid(), 'ideating'::slot_stage)`),
    ).rejects.toThrow(/No such slot/);
  });

  it("writes no event for a move it refused", async () => {
    const slot = await newSlot();
    await expect(db.exec(`select advance_slot('${slot}', 'published'::slot_stage)`)).rejects.toThrow();
    const { n } = await one<{ n: number }>(`select count(*)::int as n from slot_events where slot_id = '${slot}'`);
    expect(n).toBe(1);
  });
});

describe("advance_slot is the only writer", () => {
  it("refuses a direct update to stage, even as the owner", async () => {
    // The owner bypasses RLS. It does not bypass the trigger, which is the
    // point: being allowed to write the row is not being allowed to invent
    // a transition.
    const slot = await newSlot();
    await expect(
      db.exec(`update content_slots set stage = 'published' where id = '${slot}'`),
    ).rejects.toThrow(/changes through advance_slot/);
    expect(await stageOf(slot)).toBe("planned");
  });

  it("refuses a direct update that would have been a legal move anyway", async () => {
    // Legality is not the question. The event log is.
    const slot = await newSlot();
    await expect(
      db.exec(`update content_slots set stage = 'ideating' where id = '${slot}'`),
    ).rejects.toThrow(/changes through advance_slot/);
  });

  it("allows writing the other columns directly", async () => {
    const slot = await newSlot();
    await db.exec(`update content_slots set cost_usd = 1.25 where id = '${slot}'`);
    const { cost_usd } = await one<{ cost_usd: string }>(
      `select cost_usd from content_slots where id = '${slot}'`,
    );
    expect(Number(cost_usd)).toBe(1.25);
  });

  it("does not leave the permission lying around for the next statement", async () => {
    // advance_slot clears its own key. If it did not, anything later in the
    // same transaction could move that slot by hand.
    const slot = await newSlot();
    await db.exec(`select advance_slot('${slot}', 'ideating'::slot_stage)`);
    await expect(
      db.exec(`update content_slots set stage = 'idea_selected' where id = '${slot}'`),
    ).rejects.toThrow(/changes through advance_slot/);
  });

  it("does not let the key for one slot move another", async () => {
    const a = await newSlot();
    const b = await newSlot("2026-11-05 09:00+00");
    await db.exec(`
      begin;
      select set_config('aa.advancing_slot', '${a}', true);
    `);
    await expect(db.exec(`update content_slots set stage = 'ideating' where id = '${b}'`)).rejects.toThrow(
      /changes through advance_slot/,
    );
    await db.exec(`rollback;`);
  });

  it("keeps the event log append-only", async () => {
    const slot = await newSlot();
    await expect(db.exec(`update slot_events set note = 'rewritten' where slot_id = '${slot}'`)).rejects.toThrow(
      /cannot be edited/,
    );
    await expect(db.exec(`delete from slot_events where slot_id = '${slot}'`)).rejects.toThrow(
      /delete the slot, not its history/,
    );
  });

  it("still lets a slot, and so a client, be deleted", async () => {
    // An append-only log that refuses the cascade makes a client undeletable
    // forever, which is a worse problem than the one it is guarding against.
    const slot = await newSlot();
    await walk(slot, ["ideating"]);
    await db.exec(`delete from content_slots where id = '${slot}'`);
    const { n } = await one<{ n: number }>(`select count(*)::int as n from slot_events where slot_id = '${slot}'`);
    expect(n).toBe(0);
  });
});

describe("going round again", () => {
  it("counts a QA rebuild as an attempt, and a forward move as none", async () => {
    const slot = await newSlot();
    await walk(slot, ["ideating", "idea_selected", "briefing", "building", "copywriting", "qa"]);
    expect(
      (await one<{ attempts: number }>(`select attempts from content_slots where id = '${slot}'`)).attempts,
    ).toBe(0);

    await walk(slot, ["building", "copywriting", "qa"]);
    expect(
      (await one<{ attempts: number }>(`select attempts from content_slots where id = '${slot}'`)).attempts,
    ).toBe(1);
  });

  it("lets QA send back the words without rebuilding the asset", async () => {
    const slot = await newSlot();
    await walk(slot, ["ideating", "idea_selected", "briefing", "building", "copywriting", "qa"]);
    await walk(slot, ["copywriting"]);
    expect(await stageOf(slot)).toBe("copywriting");
  });

  it("counts a retry after failure", async () => {
    const slot = await newSlot();
    await walk(slot, ["ideating", "failed"]);
    await walk(slot, ["planned"]);
    expect(
      (await one<{ attempts: number }>(`select attempts from content_slots where id = '${slot}'`)).attempts,
    ).toBe(1);
  });

  it("counts a rejected post being made again", async () => {
    const slot = await newSlot();
    await walk(slot, [
      "ideating", "idea_selected", "briefing", "building", "copywriting", "qa", "awaiting_approval",
    ]);
    await db.exec(`select advance_slot('${slot}', 'rejected'::slot_stage, 'human', 'Off brand')`);
    await walk(slot, ["briefing"]);
    expect(
      (await one<{ attempts: number }>(`select attempts from content_slots where id = '${slot}'`)).attempts,
    ).toBe(1);
  });
});

describe("blocked_reason", () => {
  it("records why a slot failed", async () => {
    const slot = await newSlot();
    await db.exec(`
      select advance_slot('${slot}', 'failed'::slot_stage, 'agent', 'Higgsfield returned nothing',
        'video_build', null, null, null, null, null, null, 'Higgsfield returned nothing')`);
    const { blocked_reason } = await one<{ blocked_reason: string }>(
      `select blocked_reason from content_slots where id = '${slot}'`,
    );
    expect(blocked_reason).toBe("Higgsfield returned nothing");
  });

  it("falls back to the note when no reason was given separately", async () => {
    const slot = await newSlot();
    await db.exec(`select advance_slot('${slot}', 'failed'::slot_stage, 'agent', 'It broke')`);
    expect(
      (await one<{ blocked_reason: string }>(`select blocked_reason from content_slots where id = '${slot}'`))
        .blocked_reason,
    ).toBe("It broke");
  });

  it("clears it when the slot starts moving again", async () => {
    // A slot that is moving must not carry yesterday's explanation.
    const slot = await newSlot();
    await db.exec(`select advance_slot('${slot}', 'failed'::slot_stage, 'agent', 'It broke')`);
    await walk(slot, ["planned", "ideating"]);
    expect(
      (await one<{ blocked_reason: string | null }>(
        `select blocked_reason from content_slots where id = '${slot}'`,
      )).blocked_reason,
    ).toBeNull();
  });
});

describe("carrying the work with the move", () => {
  it("sets the brief as part of becoming briefed, so the two cannot disagree", async () => {
    const slot = await newSlot();
    const { id: brief } = await one<{ id: string }>(`insert into client_briefs default values returning id`);
    await walk(slot, ["ideating", "idea_selected"]);
    await db.exec(`
      select advance_slot('${slot}', 'briefing'::slot_stage, 'agent', null, 'brief_build', null, 0.42,
        null, '${brief}')`);
    const row = await one<{ brief_id: string; cost_usd: string; stage: string }>(
      `select brief_id, cost_usd, stage from content_slots where id = '${slot}'`,
    );
    expect(row.brief_id).toBe(brief);
    expect(row.stage).toBe("briefing");
    expect(Number(row.cost_usd)).toBe(0.42);
  });

  it("adds cost up across moves rather than replacing it", async () => {
    const slot = await newSlot();
    await db.exec(`select advance_slot('${slot}', 'ideating'::slot_stage, 'agent', null, 'ideation', null, 0.10)`);
    await db.exec(`select advance_slot('${slot}', 'idea_selected'::slot_stage, 'agent', null, 'idea_select', null, 0.05)`);
    const { cost_usd } = await one<{ cost_usd: string }>(
      `select cost_usd from content_slots where id = '${slot}'`,
    );
    expect(Number(cost_usd)).toBeCloseTo(0.15, 4);
  });

  it("does not wipe something it was not given", async () => {
    const slot = await newSlot();
    const { id: idea } = await one<{ id: string }>(`insert into client_ideas default values returning id`);
    await db.exec(`select advance_slot('${slot}', 'ideating'::slot_stage)`);
    await db.exec(`select advance_slot('${slot}', 'idea_selected'::slot_stage, 'policy', null, null, null, null, '${idea}')`);
    await walk(slot, ["briefing"]);
    expect(
      (await one<{ idea_id: string }>(`select idea_id from content_slots where id = '${slot}'`)).idea_id,
    ).toBe(idea);
  });
});

describe("who can see a slot", () => {
  it("drops privilege for real", async () => {
    const rows = await asUser<{ role: string }>(MEMBER, `select current_user as role`);
    expect(rows[0]?.role).toBe("authenticated");
  });

  it("shows a slot to someone with access to its client", async () => {
    await newSlot();
    expect(await asUser(MEMBER, `select id from content_slots`)).toHaveLength(1);
  });

  it("hides another client's slots and their events", async () => {
    const slot = await newSlot();
    await db.exec(`update content_slots set client_id = '${OTHER}' where id = '${slot}'`);
    expect(await asUser(MEMBER, `select id from content_slots`)).toHaveLength(0);
    // The view too. A view without security_invoker runs as its owner and
    // reads past the RLS on the table underneath, which is how this leaked
    // the first time it was written.
    expect(await asUser(MEMBER, `select event_id from slot_timeline`)).toHaveLength(0);
    expect(await asUser(MEMBER, `select slot_id from slot_board`)).toHaveLength(0);
    expect(await asUser(MEMBER, `select event_id from slot_timeline`)).toHaveLength(0);
  });

  it("refuses a member writing a stage directly", async () => {
    const slot = await newSlot();
    await expect(
      asUser(MEMBER, `update content_slots set stage = 'published' where id = '${slot}'`),
    ).rejects.toThrow();
  });
});

describe("the timeline and the board", () => {
  it("says how long the slot sat in the stage it left", async () => {
    const slot = await newSlot();
    await walk(slot, ["ideating", "idea_selected"]);
    const rows = await db.query<{ spent_in_previous: unknown }>(
      `select spent_in_previous from slot_timeline where slot_id = '${slot}' order by created_at`,
    );
    // The first row has nothing before it.
    expect(rows.rows[0]!.spent_in_previous).toBeNull();
    expect(rows.rows[2]!.spent_in_previous).not.toBeNull();
  });

  it("gives the board one line per slot, with where it is", async () => {
    const slot = await newSlot();
    await walk(slot, ["ideating"]);
    const row = await one<{ stage: string; pillar_name: string; settled: boolean }>(
      `select stage, pillar_name, settled from slot_board where slot_id = '${slot}'`,
    );
    expect(row).toMatchObject({ stage: "ideating", pillar_name: "Proof", settled: false });
  });

  it("marks published and rejected as settled, and nothing else", async () => {
    const done = await newSlot();
    await walk(done, [
      "ideating", "idea_selected", "briefing", "building", "copywriting", "qa",
      "awaiting_approval", "scheduled", "published",
    ]);
    const stuck = await newSlot("2026-11-06 09:00+00");
    await walk(stuck, ["ideating", "failed"]);

    // order by stage would sort by enum position, where published precedes
    // failed. Sorting by the text is what reads as alphabetical.
    const rows = await db.query<{ stage: string; settled: boolean }>(
      `select stage, settled from slot_board order by stage::text`,
    );
    expect(rows.rows).toEqual([
      { stage: "failed", settled: false },
      { stage: "published", settled: true },
    ]);
  });
});
