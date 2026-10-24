import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 242 against a real Postgres.
 *
 * Two things matter here. Seeding must never overwrite a scene somebody has
 * edited — that is the whole reason scenes became rows. And a cut whose scene
 * cites proof that has since lost its permission must be stopped whatever the
 * QA says, because the QA ran before the rights changed and has no way to
 * know.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const PROJECT = "66666666-6666-4666-8666-666666666666";
const PROOF = "77777777-7777-4777-8777-777777777777";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

async function candidate(over: { attempt?: number; brand?: string | null; claim?: string | null; render?: string | null } = {}) {
  const row = await one<{ id: string }>(
    `insert into motion_render_candidates (project_id, client_id, attempt, render_path,
       brand_qa, claim_qa) values ($1,$2,$3,$4,$5,$6) returning id`,
    [
      PROJECT, CLIENT, over.attempt ?? 1,
      "render" in over ? over.render : "motion/r1.mp4",
      "brand" in over ? over.brand : "pass",
      "claim" in over ? over.claim : "pass",
    ],
  );
  return row.id;
}

async function blocker(candidateId: string): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from motion_candidate_due where candidate_id = $1",
    [candidateId],
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
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end$$;

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table agent_jobs(id uuid primary key default gen_random_uuid());
 create table client_proof_assets(id uuid primary key, client_id uuid, title text,
   usage_rights text, expires_on date);
 create table motion_design_projects(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id),
   prompt text not null, preset text not null, aspect text not null,
   duration_sec integer not null, brand_mode text not null,
   status text not null default 'completed', scene_plan jsonb,
   render_path text, poster_path text, created_at timestamptz not null default now());

 insert into clients values('${CLIENT}');
 insert into profiles values('${MANAGER}');
 insert into client_proof_assets values('${PROOF}','${CLIENT}','Four-day conversion','approved',null);
 insert into motion_design_projects (id, client_id, prompt, preset, aspect, duration_sec, brand_mode, scene_plan)
   values ('${PROJECT}','${CLIENT}','Garage conversion explainer','explainer','vertical',16,'on_brand',
     jsonb_build_array(
       jsonb_build_object('beat','Hook','script','Your garage is wasted space','duration_sec',2),
       jsonb_build_object('beat','Problem','script','Damp, cold, unusable','duration_sec',5),
       jsonb_build_object('beat','Proof','script','Four days, bone dry','duration_sec',6),
       jsonb_build_object('beat','Ask','script','Book a survey','duration_sec',3)));`);

  await db.exec(await sql("20261024160000_242_motion_scenes_and_candidates.sql"));
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("seeding scenes from what v1 already writes", () => {
  it("turns the scene plan into editable rows with running start times", async () => {
    const seeded = await one<{ seed_motion_scenes_v6: number }>(
      "select seed_motion_scenes_v6($1)", [PROJECT]);
    expect(seeded.seed_motion_scenes_v6).toBe(4);

    const scenes = await rows<{ position: number; beat: string; start_sec: string; duration_sec: string }>(
      "select position, beat, start_sec, duration_sec from motion_scenes order by position",
    );
    expect(scenes.map((s) => s.beat)).toEqual(["Hook", "Problem", "Proof", "Ask"]);
    // Running, so the timeline reads as a timeline.
    expect(scenes.map((s) => Number(s.start_sec))).toEqual([0, 2, 7, 13]);
    expect(Number(scenes[2]!.duration_sec)).toBe(6);
  });

  it("never overwrites a scene somebody has edited", async () => {
    await db.query("select seed_motion_scenes_v6($1)", [PROJECT]);
    await db.exec(
      `update motion_scenes set beat = 'Reworked proof', locked = true where position = 3`,
    );

    // Seeding again is the mistake this guard exists for: it would quietly
    // throw away the edit.
    const again = await one<{ seed_motion_scenes_v6: number }>(
      "select seed_motion_scenes_v6($1)", [PROJECT]);
    expect(again.seed_motion_scenes_v6).toBe(0);
    expect(
      await one<{ beat: string; locked: boolean }>(
        "select beat, locked from motion_scenes where position = 3",
      ),
    ).toMatchObject({ beat: "Reworked proof", locked: true });
    expect(await rows("select 1 from motion_scenes")).toHaveLength(4);
  });

  it("leaves scene_plan alone, so a project made before this still renders", async () => {
    await db.query("select seed_motion_scenes_v6($1)", [PROJECT]);
    const project = await one<{ scene_plan: unknown[] }>(
      "select scene_plan from motion_design_projects where id = $1", [PROJECT]);
    expect(project.scene_plan).toHaveLength(4);
  });

  it("copes with a project that has no plan yet", async () => {
    await db.exec("update motion_design_projects set scene_plan = null");
    expect(
      await one<{ seed_motion_scenes_v6: number }>("select seed_motion_scenes_v6($1)", [PROJECT]),
    ).toMatchObject({ seed_motion_scenes_v6: 0 });
  });
});

describe("candidates and their verdicts", () => {
  it("keeps every attempt rather than overwriting the last", async () => {
    await candidate({ attempt: 1, brand: "fail" });
    await candidate({ attempt: 2, claim: "fail" });
    await candidate({ attempt: 3 });
    // After the fourth attempt the interesting question is which way quality
    // moved, which needs the earlier ones to still exist.
    expect(await rows("select 1 from motion_render_candidates")).toHaveLength(3);
  });

  it("names which QA failed, and does not call a pass an acceptance", async () => {
    const brandFail = await candidate({ attempt: 1, brand: "fail" });
    await db.query("update motion_render_candidates set brand_qa_detail = $1 where id = $2", [
      "Off-palette in scene 3",
      brandFail,
    ]);
    expect(await blocker(brandFail)).toBe("Brand QA failed: Off-palette in scene 3.");

    const claimFail = await candidate({ attempt: 2, claim: "fail" });
    await db.query("update motion_render_candidates set claim_qa_detail = $1 where id = $2", [
      'Unevidenced "cheapest in Portsmouth"',
      claimFail,
    ]);
    expect(await blocker(claimFail)).toContain("Claim QA failed");

    // Both passing is not shipped: it is waiting for a person.
    const clean = await candidate({ attempt: 3 });
    expect(await blocker(clean)).toBeNull();
  });

  it("says QA has not run rather than treating silence as a pass", async () => {
    const untested = await candidate({ attempt: 1, brand: null, claim: null });
    expect(await blocker(untested)).toBe("QA has not run on this candidate yet.");
  });

  it("says a candidate with no render is not a candidate yet", async () => {
    const pending = await candidate({ attempt: 1, render: null });
    expect(await blocker(pending)).toBe("Still rendering, or the render failed.");
  });
});

describe("a scene citing proof that has gone", () => {
  it("stops the cut whatever the QA said", async () => {
    await db.query("select seed_motion_scenes_v6($1)", [PROJECT]);
    await db.query("update motion_scenes set proof_asset_id = $1 where position = 3", [PROOF]);
    const clean = await candidate({ attempt: 1 });
    expect(await blocker(clean)).toBeNull();

    // The QA ran before the rights changed and has no way to know.
    await db.exec("update client_proof_assets set expires_on = current_date - 1");
    expect(await blocker(clean)).toBe(
      "A scene cites proof that is no longer usable. The cut is wrong whatever the QA says.",
    );
    const row = await one<{ scenes_citing_proof: number; scenes_citing_lost_proof: number }>(
      "select scenes_citing_proof, scenes_citing_lost_proof from motion_candidate_due where candidate_id = $1",
      [clean],
    );
    expect(Number(row.scenes_citing_proof)).toBe(1);
    expect(Number(row.scenes_citing_lost_proof)).toBe(1);
  });
});

describe("accepting a cut", () => {
  it("is a person, and only one per project", async () => {
    const first = await candidate({ attempt: 1 });
    const second = await candidate({ attempt: 2 });
    await db.query("select accept_motion_candidate_v6($1,true)", [first]);
    expect(
      await one<{ accepted_by: string }>(
        "select accepted_by from motion_render_candidates where id = $1", [first]),
    ).toMatchObject({ accepted_by: MANAGER });
    expect(await blocker(first)).toBe("Accepted.");

    // Two things claiming to be the finished video is not a state to allow.
    await expect(
      db.query("select accept_motion_candidate_v6($1,true)", [second]),
    ).rejects.toThrow("already has an accepted cut");
  });

  it("needs a reason to reject, and records it", async () => {
    const id = await candidate({ attempt: 1 });
    await expect(
      db.query("select accept_motion_candidate_v6($1,false,null)", [id]),
    ).rejects.toThrow("Say why");
    await db.query("select accept_motion_candidate_v6($1,false,$2)", [id, "The pacing is wrong."]);
    expect(await blocker(id)).toBe("A person rejected it: The pacing is wrong.");
  });

  it("will not accept something with no render", async () => {
    const id = await candidate({ attempt: 1, render: null });
    await expect(
      db.query("select accept_motion_candidate_v6($1,true)", [id]),
    ).rejects.toThrow("no render to accept");
  });

  it("ends with the grant sweep", async () => {
    expect(await sql("20261024160000_242_motion_scenes_and_candidates.sql")).toContain(
      "select lock_down_definer_functions();",
    );
  });
});
