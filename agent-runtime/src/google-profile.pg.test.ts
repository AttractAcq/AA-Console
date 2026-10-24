import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 240 against a real Postgres.
 *
 * The loop worth protecting is the review one. Proof Bank's first named
 * source is "online reviews", and today they are retyped from a browser tab —
 * so the author, the url and the date are whatever somebody copied, and a
 * review that is later deleted leaves a proof asset quoting something that no
 * longer exists.
 *
 * So: a captured review arrives uncleared with its own url and date, a second
 * capture does not make a second asset, and a review that leaves the profile
 * is marked rather than deleted and counted against the proof resting on it.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const LOCATION = "66666666-6666-4666-8666-666666666666";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

async function review(over: { ref?: string; comment?: string | null } = {}) {
  const row = await one<{ id: string }>(
    `insert into google_reviews (client_id, location_id, review_ref, author_name, star_rating,
       comment, review_url, reviewed_at)
     values ($1,$2,$3,'J. Okafor',5,$4,'https://g.co/r/abc','2026-10-14T10:00:00Z')
     returning id`,
    [CLIENT, LOCATION, over.ref ?? "rev-1", "comment" in over ? over.comment : "They did the garage in four days and it is bone dry."],
  );
  return row.id;
}

async function blocker(): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from google_profile_due where location_id = $1",
    [LOCATION],
  );
  return row?.blocker ?? null;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select coalesce(current_setting('test.role',true),'authenticated')$$;
 create function auth.uid() returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
 create function active_video_approval_manager(uuid) returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function can_access_client(uuid) returns boolean language sql as $$select true$$;
 create function integration_usable(uuid, text) returns boolean language sql as $$select coalesce(current_setting('test.integration',true),'true')='true'$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end$$;

 create type media_type as enum ('image','text','video');

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table agent_jobs(id uuid primary key default gen_random_uuid());
 create table client_proof_assets(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   media_type media_type not null,
   title text, body text, storage_path text, source text,
   proof_type text, usage_rights text not null default 'not_cleared',
   captured_on date, expires_on date,
   created_at timestamptz not null default now(),
   constraint proof_has_content check (body is not null or storage_path is not null),
   constraint proof_type_known check (proof_type is null or proof_type in
     ('customer_result','testimonial','review','case_study','before_after','stat',
      'credential','award','press','process','team_expertise','customer_story')),
   constraint proof_rights_known check (usage_rights in ('approved','restricted','not_cleared')));

 insert into clients values('${CLIENT}');
 insert into profiles values('${MANAGER}');`);

  await db.exec(await sql("20261024140000_240_google_business_profile.sql"));
  await db.exec(`
 insert into client_google_locations (id, client_id, location_ref, title, verification_state, last_read_at)
   values ('${LOCATION}','${CLIENT}','accounts/1184/locations/7730','Harbour Home · Portsmouth','verified', now());`);
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("a review becoming proof", () => {
  it("carries its own author, url and date, and arrives uncleared", async () => {
    const id = await review();
    const captured = await one<{ capture_google_review_as_proof_v6: string }>(
      "select capture_google_review_as_proof_v6($1)",
      [id],
    );
    const proof = await one<{
      title: string; body: string; source: string; usage_rights: string;
      proof_type: string; captured_on: Date | string; media_type: string;
    }>("select * from client_proof_assets where id = $1", [
      captured.capture_google_review_as_proof_v6,
    ]);

    expect(proof.title).toContain("J. Okafor");
    expect(proof.title).toContain("5 stars");
    expect(proof.body).toContain("bone dry");
    // The thing itself, not a transcription of it.
    expect(proof.source).toBe("https://g.co/r/abc");
    // A date column comes back as a Date here; what matters is that it is the
    // review's own date rather than today's.
    expect(new Date(proof.captured_on).toISOString().slice(0, 10)).toBe("2026-10-14");
    expect(proof.media_type).toBe("text");
    expect(proof.proof_type).toBe("review");
    // A public review is not a blanket permission to republish it.
    expect(proof.usage_rights).toBe("not_cleared");
  });

  it("does not make a second asset for the same review", async () => {
    const id = await review();
    const first = await one<{ capture_google_review_as_proof_v6: string }>(
      "select capture_google_review_as_proof_v6($1)", [id]);
    const second = await one<{ capture_google_review_as_proof_v6: string }>(
      "select capture_google_review_as_proof_v6($1)", [id]);
    expect(second.capture_google_review_as_proof_v6).toBe(first.capture_google_review_as_proof_v6);
    expect(await rows("select 1 from client_proof_assets")).toHaveLength(1);
  });

  it("refuses a review with no words in it", async () => {
    const id = await review({ ref: "rev-2", comment: null });
    await expect(
      db.query("select capture_google_review_as_proof_v6($1)", [id]),
    ).rejects.toThrow("no words in it");
  });

  it("counts a review that has left the profile while proof rests on it", async () => {
    const id = await review();
    await db.query("select capture_google_review_as_proof_v6($1)", [id]);
    await db.query("update google_reviews set gone_at = now() where id = $1", [id]);

    const due = await one<{ reviews: number; captured_as_proof: number; gone_but_cited: number }>(
      "select reviews, captured_as_proof, gone_but_cited from google_profile_due",
    );
    // Marked, never deleted: a proof asset may be resting on it, and somebody
    // needs telling rather than the row quietly vanishing.
    expect(Number(due.reviews)).toBe(0);
    expect(Number(due.captured_as_proof)).toBe(1);
    expect(Number(due.gone_but_cited)).toBe(1);
  });
});

describe("replying, which changes somebody's profile", () => {
  it("drafts, needs a decision, and records who made it", async () => {
    const id = await review();
    const draft = await one<{ draft_google_review_reply_v6: string }>(
      "select draft_google_review_reply_v6($1,$2)",
      [id, "Thanks Jay — glad the floor is holding up."],
    );
    const replyId = draft.draft_google_review_reply_v6;
    expect(
      await one<{ status: string }>("select status from google_review_replies where id = $1", [replyId]),
    ).toMatchObject({ status: "drafted" });

    await db.query("select decide_google_review_reply_v6($1,true)", [replyId]);
    expect(
      await one<{ status: string; approved_by: string }>(
        "select status, approved_by from google_review_replies where id = $1",
        [replyId],
      ),
    ).toMatchObject({ status: "approved", approved_by: MANAGER });
  });

  it("requires a reason to reject", async () => {
    const id = await review();
    const draft = await one<{ draft_google_review_reply_v6: string }>(
      "select draft_google_review_reply_v6($1,$2)", [id, "No thanks."]);
    await expect(
      db.query("select decide_google_review_reply_v6($1,false,null)", [
        draft.draft_google_review_reply_v6,
      ]),
    ).rejects.toThrow("Say why");
  });

  it("allows only one live reply per review, because Google keeps one", async () => {
    const id = await review();
    await db.query("select draft_google_review_reply_v6($1,$2)", [id, "First answer."]);
    await expect(
      db.query("select draft_google_review_reply_v6($1,$2)", [id, "Second answer."]),
    ).rejects.toThrow();
  });

  it("will not reply to a review that has gone", async () => {
    const id = await review();
    await db.query("update google_reviews set gone_at = now() where id = $1", [id]);
    await expect(
      db.query("select draft_google_review_reply_v6($1,$2)", [id, "Thanks."]),
    ).rejects.toThrow("no longer on the profile");
  });

  it("refuses anyone who is neither an admin nor the assigned manager", async () => {
    const id = await review();
    await db.exec("set test.admin = 'false'");
    await db.exec("drop function active_video_approval_manager(uuid) cascade");
    await db.exec(`create function active_video_approval_manager(uuid) returns uuid
      language sql as $$select null::uuid$$`);
    await expect(
      db.query("select draft_google_review_reply_v6($1,$2)", [id, "Thanks."]),
    ).rejects.toThrow("admin or the assigned client manager");
  });
});

describe("what stops a profile being read at all", () => {
  it("names each reason in words", async () => {
    expect(await blocker()).toBeNull();

    await db.exec("update client_google_locations set verification_state = 'unverified'");
    expect(await blocker()).toContain("not verified");

    await db.exec("update client_google_locations set verification_state = 'no_access'");
    expect(await blocker()).toContain("cannot see the location");

    await db.exec("update client_google_locations set verification_state = 'verified'");
    await db.exec("set test.integration = 'false'");
    expect(await blocker()).toBe("No usable google_business integration for this client.");

    await db.exec("set test.integration = 'true'");
    await db.exec("update client_google_locations set last_read_at = null");
    expect(await blocker()).toBe("Nothing has been read from this profile yet.");

    await db.exec(
      "update client_google_locations set last_read_at = now(), last_read_error = 'token expired'",
    );
    expect(await blocker()).toContain("token expired");
  });

  it("refuses a location reference that is not one", async () => {
    await expect(
      db.query(
        `insert into client_google_locations (client_id, location_ref, title)
         values ($1,'7730','Harbour Home')`,
        [CLIENT],
      ),
    ).rejects.toThrow();
  });

  it("ends with the grant sweep", async () => {
    expect(await sql("20261024140000_240_google_business_profile.sql")).toContain(
      "select lock_down_definer_functions();",
    );
  });
});
