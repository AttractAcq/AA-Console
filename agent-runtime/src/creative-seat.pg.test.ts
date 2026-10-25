import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 247 against a real Postgres.
 *
 * G12 was that creative decisions were not routed to a named person. Half the
 * gap as written was wrong -- the SMM seat exists and forty-three functions
 * gate on it -- so what is built here is the creative director seat, the seat
 * a decision was made from, and enforcement that is opt-in per client.
 *
 * The behaviours worth pinning are mostly about not breaking anybody: with
 * the setting off nothing changes, a rejection is never blocked, and the
 * seat is resolved at the moment of the decision rather than read back later
 * from assignments that may since have ended.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const SMM = "22222222-2222-4222-8222-222222222222";
const DIRECTOR = "33333333-3333-4333-8333-333333333333";
const CLIENT_USER = "44444444-4444-4444-8444-444444444444";
const STRANGER = "55555555-5555-4555-8555-555555555555";

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
/** Who is calling, and whether they are an admin. */
async function actingAs(uid: string, admin = false): Promise<void> {
  await db.query(`select set_config('test.uid',$1,false), set_config('test.admin',$2,false)`,
    [uid, admin ? "true" : "false"]);
}
async function asset(format = "single", media = "image"): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into client_media_assets (client_id, title, media_type, content_format, edit_stage)
     values ($1,'A frame',$2,$3,'review_ready') returning id`, [CLIENT, media, format]);
  return id;
}
async function requireDirector(on: boolean): Promise<void> {
  await db.query(
    `insert into client_engine_settings (client_id, creative_director_required) values ($1,$2)
     on conflict (client_id) do update set creative_director_required = excluded.creative_director_required`,
    [CLIENT, on]);
}
/** Assign somebody to the client in a given category. */
async function assign(userId: string, category: string): Promise<void> {
  const { id } = await one<{ id: string }>(
    `insert into team_members (user_id, category, active) values ($1,$2,true) returning id`,
    [userId, category]);
  await db.query(`insert into client_assignments (member_id, client_id) values ($1,$2)`, [id, CLIENT]);
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select coalesce(current_setting('test.role',true),'authenticated')$$;
 create function auth.uid() returns uuid language sql as $$select nullif(coalesce(current_setting('test.uid',true),''),'')::uuid$$;
 create function is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
 create function can_access_client(uuid) returns boolean language sql as $$select $1='${CLIENT}'::uuid$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;

 create type review_status as enum ('pending','approved','rejected');
 create type team_category as enum ('avatars','editors','smm');
 create type media_type as enum ('image','text','video');

 create table clients(id uuid primary key, name text);
 create table team_members(id uuid primary key default gen_random_uuid(),
   user_id uuid, category team_category not null, active boolean not null default true);
 create table client_assignments(id uuid primary key default gen_random_uuid(),
   member_id uuid not null references team_members(id), client_id uuid not null,
   ended_at timestamptz, created_at timestamptz not null default now());
 create table client_users(client_id uuid not null, user_id uuid not null,
   primary key (client_id, user_id));
 create table client_engine_settings(client_id uuid primary key);

 create table client_media_assets(id uuid primary key default gen_random_uuid(),
   client_id uuid not null, title text, media_type media_type not null,
   content_format text, edit_stage text, render_path text,
   review_status review_status not null default 'pending', human_approved_at timestamptz);
 create table client_asset_reviews(id uuid primary key default gen_random_uuid(),
   asset_id uuid not null, decision review_status not null, reason text,
   reviewed_by uuid, created_at timestamptz not null default now());

 -- The SMM resolver production has, including the name that says video and
 -- the body that means "the assigned SMM".
 create function active_video_approval_manager(p_client_id uuid) returns uuid
 language sql stable security definer set search_path = public as $f$
   select tm.user_id from client_assignments ca
   join team_members tm on tm.id = ca.member_id
   where ca.client_id = p_client_id and ca.ended_at is null
     and tm.active and tm.category::text = 'smm' and tm.user_id is not null
   order by ca.created_at desc, ca.id desc limit 1;
 $f$;
 create function video_approval_state(uuid) returns jsonb
 language sql as $f$select '{}'::jsonb$f$;

 insert into clients values('${CLIENT}','Harbour Dental');
 insert into client_users values('${CLIENT}','${CLIENT_USER}');`);

  await db.exec(await sql("20261025120000_247_creative_decisions_have_a_seat.sql"));
  await assign(SMM, "smm");
});

afterAll(async () => { await db?.close(); });

describe("the seats", () => {
  it("adds a creative director category without disturbing the others", async () => {
    const got = await one<{ v: string }>(
      `select string_agg(e.enumlabel,',' order by e.enumsortorder) as v
         from pg_type t join pg_enum e on e.enumtypid=t.oid where t.typname='team_category'`);
    expect(got.v).toBe("avatars,editors,smm,creative_director");
  });

  it("resolves the assigned creative director, and null when nobody holds it", async () => {
    expect((await one<{ d: string | null }>(
      `select active_creative_director($1) as d`, [CLIENT])).d).toBeNull();
    await assign(DIRECTOR, "creative_director");
    expect((await one<{ d: string }>(
      `select active_creative_director($1) as d`, [CLIENT])).d).toBe(DIRECTOR);
  });

  it("ignores an assignment that has ended", async () => {
    await assign(DIRECTOR, "creative_director");
    await db.query(`update client_assignments set ended_at = now()`);
    expect((await one<{ d: string | null }>(
      `select active_creative_director($1) as d`, [CLIENT])).d).toBeNull();
  });

  it("names the seats and says the SMM is what the video resolver returns", async () => {
    await assign(DIRECTOR, "creative_director");
    const row = await one<{ smm_user_id: string; creative_director_user_id: string; problem: string | null }>(
      `select * from client_creative_authority where client_id = $1`, [CLIENT]);
    expect(row.smm_user_id).toBe(SMM);
    expect(row.creative_director_user_id).toBe(DIRECTOR);
    expect(row.problem).toBeNull();
  });

  it("says when creative director sign-off is required and nobody holds the seat", async () => {
    await requireDirector(true);
    const row = await one<{ problem: string }>(
      `select problem from client_creative_authority where client_id = $1`, [CLIENT]);
    expect(row.problem).toContain("nobody holds the seat");
  });

  it("ranks admin above the director, and the director above the SMM", async () => {
    await assign(DIRECTOR, "creative_director");
    const seat = async (uid: string, admin = false) => {
      await actingAs(uid, admin);
      return (await one<{ s: string }>(`select creative_seat_of($1,$2) as s`, [CLIENT, uid])).s;
    };
    expect(await seat(DIRECTOR, true)).toBe("admin");
    expect(await seat(DIRECTOR)).toBe("creative_director");
    expect(await seat(SMM)).toBe("smm");
    expect(await seat(CLIENT_USER)).toBe("client");
    expect(await seat(STRANGER)).toBe("other");
  });
});

describe("recording the seat a decision was made from", () => {
  it("records the seat on an approval", async () => {
    await assign(DIRECTOR, "creative_director");
    await actingAs(DIRECTOR);
    const id = await asset();
    await db.query(`select review_media_asset($1,'approved','On brand')`, [id]);
    const row = await one<{ seat: string; decision: string }>(
      `select seat, decision from creative_decisions where asset_id = $1`, [id]);
    expect(row.seat).toBe("creative_director");
    expect(row.decision).toBe("approved");
  });

  it("records 'other' when somebody with access but no seat decides", async () => {
    await actingAs(STRANGER);
    const id = await asset();
    await db.query(`select review_media_asset($1,'approved',null)`, [id]);
    expect((await one<{ seat: string }>(
      `select seat from creative_decisions where asset_id = $1`, [id])).seat).toBe("other");
  });

  it("reads 'unrecorded' for a review written before this migration", async () => {
    const id = await asset();
    await db.query(
      `insert into client_asset_reviews (asset_id, decision, reviewed_by) values ($1,'approved',$2)`,
      [id, SMM]);
    expect((await one<{ seat: string }>(
      `select seat from creative_decisions where asset_id = $1`, [id])).seat).toBe("unrecorded");
  });

  it("says whether the deciding director still holds the seat", async () => {
    await assign(DIRECTOR, "creative_director");
    await actingAs(DIRECTOR);
    const id = await asset();
    await db.query(`select review_media_asset($1,'approved','Good')`, [id]);
    expect((await one<{ still_in_seat: boolean }>(
      `select still_in_seat from creative_decisions where asset_id = $1`, [id])).still_in_seat).toBe(true);
    await db.query(`update client_assignments set ended_at = now() where client_id = $1`, [CLIENT]);
    expect((await one<{ still_in_seat: boolean }>(
      `select still_in_seat from creative_decisions where asset_id = $1`, [id])).still_in_seat).toBe(false);
  });
});

describe("enforcement is opt-in", () => {
  it("changes nothing with the setting off", async () => {
    await requireDirector(false);
    await actingAs(STRANGER);
    const id = await asset();
    await db.query(`select review_media_asset($1,'approved',null)`, [id]);
    expect((await one<{ review_status: string }>(
      `select review_status from client_media_assets where id = $1`, [id])).review_status)
      .toBe("approved");
  });

  it("refuses an approval when required and nobody holds the seat", async () => {
    await requireDirector(true);
    await actingAs(SMM);
    const id = await asset();
    expect(await refusal(`select review_media_asset($1,'approved',null)`, [id]))
      .toContain("nobody holds that seat");
  });

  it("refuses an approval from the wrong seat when required", async () => {
    await requireDirector(true);
    await assign(DIRECTOR, "creative_director");
    await actingAs(SMM);
    const id = await asset();
    expect(await refusal(`select review_media_asset($1,'approved',null)`, [id]))
      .toContain("Only the assigned creative director or an admin");
  });

  it("lets the director, and an admin, approve when required", async () => {
    await requireDirector(true);
    await assign(DIRECTOR, "creative_director");
    const first = await asset();
    await actingAs(DIRECTOR);
    await db.query(`select review_media_asset($1,'approved',null)`, [first]);

    const second = await asset();
    await actingAs(STRANGER, true);
    await db.query(`select review_media_asset($1,'approved',null)`, [second]);
    expect((await one<{ seat: string }>(
      `select seat from creative_decisions where asset_id = $1`, [second])).seat).toBe("admin");
  });

  it("never blocks a rejection, because refusing work needs no authority", async () => {
    await requireDirector(true);
    await actingAs(STRANGER);
    const id = await asset();
    await db.query(`select review_media_asset($1,'rejected','Off brand')`, [id]);
    expect((await one<{ review_status: string }>(
      `select review_status from client_media_assets where id = $1`, [id])).review_status)
      .toBe("rejected");
  });

  it("keeps every refusal it had before, in the same words", async () => {
    await actingAs(SMM);
    const reel = await one<{ id: string }>(
      `insert into client_media_assets (client_id, media_type, content_format, edit_stage)
       values ($1,'image','reel','review_ready') returning id`, [CLIENT]);
    expect(await refusal(`select review_media_asset($1,'approved',null)`, [reel.id]))
      .toContain("Finish the reel cut before approving it");

    const unedited = await one<{ id: string }>(
      `insert into client_media_assets (client_id, media_type, content_format, edit_stage)
       values ($1,'image','single','drafted') returning id`, [CLIENT]);
    expect(await refusal(`select review_media_asset($1,'approved',null)`, [unedited.id]))
      .toContain("Edit the source footage");

    const id = await asset();
    expect(await refusal(`select review_media_asset($1,'pending',null)`, [id]))
      .toContain("Decision must be approved or rejected");
  });
});
