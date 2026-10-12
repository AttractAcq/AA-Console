import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let db: PGlite;

async function service<T>(sql: string): Promise<T> {
  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
  return (await db.query<T>(sql)).rows[0]!;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create table clients (id uuid primary key);
    create table agent_jobs (id uuid primary key, client_id uuid, agent_key text,
      input_table text, input_id uuid, attempts integer);
    create table client_media_assets (id uuid primary key, client_id uuid,
      render_path text, human_approved_at timestamptz,
      width integer, height integer, duration_sec numeric, edit_plan jsonb);
    create function can_access_client(uuid) returns boolean language sql as $$ select true $$;
    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;
    insert into clients values ('${CLIENT}'), ('${OTHER}');
    insert into client_media_assets (id, client_id) values ('${ASSET}', '${CLIENT}');
    insert into agent_jobs values ('${JOB}', '${CLIENT}', 'video_edit',
      'client_media_assets', '${ASSET}', 1);
  `);
  await db.exec(await readFile(new URL(
    "../../../../supabase/migrations/20261012110000_192_video_render_candidates.sql",
    import.meta.url,
  ), "utf8"));
});

describe("video render candidate acceptance", () => {
  it("keeps a rejected candidate and promotes only a passing exact file", async () => {
    const path = `${CLIENT}/reels/${ASSET}/candidates/${JOB}-1-digest.mp4`;
    const candidate = await service<{ id: string }>(`select id from record_video_render_candidate(
      '${JOB}', 1, '${ASSET}', '${path}',
      '{"result":"pass","width":1080,"height":1920,"duration_sec":18.5}'::jsonb)`);
    await expect(service(`select id from decide_video_render_candidate('${candidate.id}', 'accepted',
      '{"result":"fail","checks":["continuity"]}'::jsonb)`))
      .rejects.toThrow(/both pass/);
    const decided = await service<{ verdict: string }>(`select verdict from decide_video_render_candidate(
      '${candidate.id}', 'rejected', '{"result":"fail","checks":["continuity"]}'::jsonb,
      'Cast changed between shots.')`);
    expect(decided.verdict).toBe("rejected");
    expect((await db.query<{ render_path: string | null }>(`
      select render_path from client_media_assets where id = '${ASSET}'`)).rows[0]?.render_path)
      .toBeNull();
    await expect(service(`select id from decide_video_render_candidate('${candidate.id}', 'accepted',
      '{"result":"pass","checks":["continuity"]}'::jsonb)`))
      .rejects.toThrow(/idempotency_conflict/);

    await db.exec(`update agent_jobs set attempts = 2 where id = '${JOB}'`);
    const nextPath = `${CLIENT}/reels/${ASSET}/candidates/${JOB}-2-better.mp4`;
    const next = await service<{ id: string }>(`select id from record_video_render_candidate(
      '${JOB}', 2, '${ASSET}', '${nextPath}',
      '{"result":"pass","width":1080,"height":1920,"duration_sec":19}'::jsonb)`);
    await service(`select id from decide_video_render_candidate('${next.id}', 'accepted',
      '{"result":"pass","checks":["continuity","crop"]}'::jsonb,
      null, '{"segments":[{"shot":1}]}'::jsonb)`);
    const asset = (await db.query<{ render_path: string; width: number; duration_sec: string }>(`
      select render_path, width, duration_sec from client_media_assets where id = '${ASSET}'`)).rows[0];
    expect(asset?.render_path).toBe(nextPath);
    expect(asset?.width).toBe(1080);
    expect(Number(asset?.duration_sec)).toBe(19);
  });

  it("rejects a job/asset mismatch and prevents replacing a human-approved render", async () => {
    const foreign = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await db.exec(`insert into client_media_assets (id, client_id) values ('${foreign}', '${OTHER}')`);
    await expect(service(`select id from record_video_render_candidate('${JOB}', 2, '${foreign}',
      '${OTHER}/reels/${foreign}/candidates/foreign.mp4', '{"result":"pass"}'::jsonb)`))
      .rejects.toThrow(/must belong/);
    await db.exec(`update client_media_assets set human_approved_at = now() where id = '${ASSET}'`);
    await db.exec(`update agent_jobs set attempts = 3 where id = '${JOB}'`);
    const path = `${CLIENT}/reels/${ASSET}/candidates/${JOB}-3-later.mp4`;
    const candidate = await service<{ id: string }>(`select id from record_video_render_candidate(
      '${JOB}', 3, '${ASSET}', '${path}',
      '{"result":"pass","width":1080,"height":1920,"duration_sec":20}'::jsonb)`);
    await expect(service(`select id from decide_video_render_candidate('${candidate.id}', 'accepted',
      '{"result":"pass","checks":["continuity"]}'::jsonb,
      null, '{"segments":[{"shot":1}]}'::jsonb)`))
      .rejects.toThrow(/cannot be replaced/);
  });
});
