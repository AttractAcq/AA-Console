import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { UNUSABLE_CLIP_BLOCKER } from "./agents/video_build/clip.js";

/**
 * Migration 311 against real Postgres.
 *
 * 212 is loaded from its own file rather than hand-written here. That is the
 * lesson 310 taught the hard way: a scaffold that merely resembles the real
 * definition proves the migration against its own assumption. The function
 * under test is the one production has, with 311 applied on top.
 *
 * The valuable half of these cases is what 311 still REFUSES. One condition was
 * widened and the counting was left alone on purpose, because relaxing it would
 * turn a capped batch recovery into a per-shot re-roll against a paid provider.
 */
let db: PGlite;

const PROVIDER_BLOCKER =
  "Higgsfield reported a shot as failed. The request id is stored. It was not submitted again.";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const STEP = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const CREATE_STEP = "55555555-5555-4555-8555-555555555555";
const ASSET = "66666666-6666-4666-8666-666666666666";
const BRIEF = "77777777-7777-4777-8777-777777777777";
const F = (n: number) => `8888888${n}-8888-4888-8888-888888888888`;

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

/** A blocked motion step whose two shots are both unusable. */
async function blockedStep(blocker: string, over: { storedFirst?: boolean; retried?: boolean } = {}) {
  await db.query(
    `insert into agent_jobs (id, agent_key, client_id, input_table, input_id, status, error)
     values ($1, 'video_build', $2, 'client_briefs', $3, 'failed', $4)`,
    [JOB, CLIENT, BRIEF, blocker],
  );
  await db.query(
    `insert into workflow_runs (id, client_id, kind, status, deadline_at)
     values ($1, $2, 'daily_content_package', 'blocked', now() + interval '2 days')`,
    [RUN, CLIENT],
  );
  await db.query(
    `insert into workflow_steps (id, run_id, step_key, agent_key, input_table, status, blocker,
                                 job_id, resolved_input_id)
     values ($1, $2, 'reel_motion', 'video_build', 'client_briefs', 'blocked', $3, $4, $5)`,
    [STEP, RUN, blocker, JOB, BRIEF],
  );
  // The upstream step that produced the asset, which the function looks through
  // to find the frames.
  await db.query(
    `insert into workflow_steps (id, run_id, step_key, agent_key, input_table, status)
     values ($1, $2, 'reel_create', 'creative_build', 'client_briefs', 'completed')`,
    [CREATE_STEP, RUN],
  );
  await db.query(
    `insert into workflow_artifacts (step_id, artifact_kind, record_id) values ($1, 'asset', $2)`,
    [CREATE_STEP, ASSET],
  );
  await db.query(`insert into client_media_assets (id, client_id) values ($1, $2)`, [ASSET, CLIENT]);
  for (const n of [1, 2]) {
    await db.query(
      `insert into client_media_frames (id, asset_id, position, provider_job_id, clip_path,
                                        provider_retry_count)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        F(n), ASSET, n, `req-${n}`,
        over.storedFirst && n === 1 ? `${CLIENT}/generated/clips/${F(1)}.mp4` : null,
        over.retried ? 1 : 0,
      ],
    );
  }
}

const batch = (ns: number[] = [1, 2]) =>
  JSON.stringify(ns.map((n) => ({ frame_id: F(n), request_id: `req-${n}` })));

const recover = () =>
  db.query(`select retry_failed_higgsfield_motion_step($1, $2::jsonb)`, [STEP, batch()]);

beforeEach(async () => {
  await db?.close();
  db = new PGlite();

  await db.exec(`
 create schema if not exists auth;
 create role authenticated; create role anon; create role service_role;

 create table clients(id uuid primary key);
 create table client_briefs(id uuid primary key default gen_random_uuid());
 create table client_media_assets(id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade);
 -- Without 212's two columns: the migration adds them.
 create table client_media_frames(
   id uuid primary key default gen_random_uuid(),
   asset_id uuid not null references client_media_assets(id) on delete cascade,
   position integer not null,
   provider_job_id text,
   clip_path text);
 create table agent_jobs(
   id uuid primary key default gen_random_uuid(),
   agent_key text not null, client_id uuid, input_table text, input_id uuid,
   status text not null default 'queued', error text);
 create table workflow_runs(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   kind text not null, status text not null default 'pending',
   blocker text, deadline_at timestamptz not null,
   updated_at timestamptz not null default now());
 create table workflow_steps(
   id uuid primary key default gen_random_uuid(),
   run_id uuid not null references workflow_runs(id) on delete cascade,
   step_key text not null, agent_key text, input_table text,
   status text not null default 'pending', blocker text,
   job_id uuid, resolved_input_id uuid, completed_at timestamptz,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now());
 create table workflow_artifacts(
   id uuid primary key default gen_random_uuid(),
   step_id uuid not null references workflow_steps(id) on delete cascade,
   artifact_kind text not null, record_id uuid);

 create function auth.role() returns text language sql stable as $a$
   select coalesce(nullif(current_setting('test.role', true), ''), 'service_role') $a$;
 create function lock_down_definer_functions() returns void language plpgsql as $a$
   begin return; end $a$;

 insert into clients(id) values ('${CLIENT}');
 insert into client_briefs(id) values ('${BRIEF}');
 `);

  // The real 212, then 311 on top of it.
  await db.exec(await sql("20261015120000_212_v5_failed_higgsfield_prompt_recovery.sql"));
  await db.exec(await sql("20261105030000_311_a_clip_with_no_shot_in_it_is_recoverable.sql"));
});

afterAll(async () => {
  await db?.close();
});

describe("what 311 adds", () => {
  it("recovers a batch the screen refused", async () => {
    await blockedStep(UNUSABLE_CLIP_BLOCKER);
    await recover();
    const step = await one<{ status: string; blocker: string | null }>(
      `select status, blocker from workflow_steps where id = $1`, [STEP],
    );
    expect(step).toMatchObject({ status: "pending", blocker: null });
    // Each frame keeps its provider id for audit and spends its one retry.
    const frames = await rows<{ provider_job_id: string | null; provider_retry_count: number; provider_prior_job_ids: string[] }>(
      `select provider_job_id, provider_retry_count, provider_prior_job_ids
         from client_media_frames order by position`,
    );
    expect(frames.map((f) => f.provider_job_id)).toEqual([null, null]);
    expect(frames.map((f) => f.provider_retry_count)).toEqual([1, 1]);
    expect(frames.map((f) => f.provider_prior_job_ids)).toEqual([["req-1"], ["req-2"]]);
  });

  it("still recovers a batch the provider itself reported failed", async () => {
    // The case 212 was written for. Widening the match must not replace it.
    await blockedStep(PROVIDER_BLOCKER);
    await recover();
    expect(await one(`select status from workflow_steps where id = $1`, [STEP]))
      .toMatchObject({ status: "pending" });
  });
});

describe("what 311 deliberately still refuses", () => {
  it("refuses any other blocker", async () => {
    await blockedStep("Something else went wrong.");
    await expect(recover()).rejects.toThrow(/not eligible/);
  });

  it("refuses a partial refusal, because that would be a per-shot re-roll", async () => {
    // One clip stored, one refused. The counting was left alone on purpose:
    // v_matched counts only unstored frames, so it no longer equals v_total.
    // Relaxing this is what would let somebody re-roll individual shots
    // against a paid provider, and the one-retry cap is all that stands in
    // front of that.
    await blockedStep(UNUSABLE_CLIP_BLOCKER, { storedFirst: true });
    await expect(recover()).rejects.toThrow(/not eligible/);
  });

  it("refuses a second retry on frames that already spent theirs", async () => {
    await blockedStep(UNUSABLE_CLIP_BLOCKER, { retried: true });
    await expect(recover()).rejects.toThrow(/not eligible/);
  });

  it("refuses when the job's error and the step's blocker disagree", async () => {
    await blockedStep(UNUSABLE_CLIP_BLOCKER);
    await db.query(`update agent_jobs set error = $1 where id = $2`, ["drifted", JOB]);
    await expect(recover()).rejects.toThrow(/not eligible/);
  });

  it("refuses a batch that does not name every frame", async () => {
    await blockedStep(UNUSABLE_CLIP_BLOCKER);
    await expect(
      db.query(`select retry_failed_higgsfield_motion_step($1, $2::jsonb)`, [STEP, batch([1])]),
    ).rejects.toThrow(/not eligible/);
  });

  it("refuses anyone who is not the service role", async () => {
    await blockedStep(UNUSABLE_CLIP_BLOCKER);
    await db.exec(`set test.role = 'authenticated'`);
    await expect(recover()).rejects.toThrow(/service role required/);
  });
});
