// Migrations 138 and 139: an enum column compared against an enum variable.
//
// Migration 95 declared `v_need_cat text` and then compared it against
// team_members.category, which is a team_category enum. Postgres has no
// team_category = text operator, so every avatar or editor send raised
//   42883: operator does not exist: team_category = text
// The 'full' role escaped it because v_need_cat stays null and the guard
// short-circuits, which is why this went unnoticed.
//
// dispatch_brief_to_members was hotfixed straight into production and never
// committed; migration 138 captures that. mcp_internal.assign_production was
// not, and migration 139 is the first fix it has had.
//
// Each describe keeps a counter-test that re-installs the migration-95 body and
// asserts the operator error comes back. Without it a green run would prove
// only that these tests execute.

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const VIDEO_BRIEF = "33333333-3333-4333-8333-333333333333";
const IMAGE_BRIEF = "44444444-4444-4444-8444-444444444444";

let db: PGlite;
let avatarId: string;
let editorId: string;
/** The migration-95 bodies, captured before 138 and 139 repair them. */
let brokenDispatch: string;
let brokenAssign: string;
let fixedDispatch: string;
let fixedAssign: string;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const defOf = async (signature: string) => {
  const row = await db.query<{ def: string }>(
    `select pg_get_functiondef('${signature}'::regprocedure) as def`);
  return row.rows[0]!.def;
};

async function asAdmin() {
  await db.exec(`reset role;
    select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema mcp_internal;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    grant usage on schema public, auth, mcp_internal to authenticated, service_role, anon;
  `);
  for (const file of [
    "20260903104450_01_foundations_roles_clients.sql",
    "20260903104529_02_team_and_operations.sql",
    "20260903104615_03_agent_registry_and_job_queue.sql",
    "20260903104816_05_content_chain_proof_ideas_briefs_media.sql",
    "20260904083559_15_brief_refs_and_job_link.sql",
  ]) await db.exec(await migration(file));

  // Columns the registry and the queue grow later, added here rather than
  // replaying migrations 32, 54 and 68 whole: 39 reads agents.scheduled_only,
  // and enqueue_agent_job_internal writes agent_jobs.params and
  // agent_job_events.payload.
  await db.exec(`
    alter table agents add column if not exists scheduled_only boolean not null default false;
    alter table agents add column if not exists archived_at timestamptz;
    alter table agents add column if not exists requires_input boolean not null default false;
    alter table agent_jobs add column if not exists params jsonb not null default '{}'::jsonb;
    alter table agent_job_events add column if not exists payload jsonb;
  `);

  for (const file of [
    "20260905131703_39_brief_build_pipeline.sql",
    "20260905131958_40_brief_build_rpcs.sql",
    "20260905134322_41_creative_reference_image.sql",
    "20260905143029_42_creative_renders.sql",
    "20260908080000_63_mcp_brief_enqueue.sql",
  ]) await db.exec(await migration(file));

  // The guards and the ledger assign_production calls. Stubbed: this file is
  // about the enum comparison, and bot isolation has its own suite.
  await db.exec(`
    create function mcp_internal.require_active_bot(p text) returns void language sql as $$ select $$;
    create function mcp_internal.require_bot_client_grant(p text, c uuid) returns void language sql as $$ select $$;
    create function mcp_internal.require_mcp_ids(a text, b text) returns void language sql as $$ select $$;
    create function mcp_internal.clip_text(t text) returns text language sql immutable as $$ select t $$;
    create table mcp_internal.mcp_content_requests (
      id uuid primary key default gen_random_uuid(),
      bot_id text, execution_id text, request_id text, tool text,
      client_id uuid, brief_id uuid, payload jsonb, result jsonb
    );
    create function mcp_internal.take_content_request(
      p_bot_id text, p_execution_id text, p_tool text, p_client_id uuid, p_payload jsonb)
    returns jsonb language sql as $$ select null::jsonb $$;
  `);

  await db.exec(await migration("20260919180000_95_video_dual_briefs.sql"));
  brokenDispatch = await defOf("public.dispatch_brief_to_members(uuid,uuid[],date,numeric,text)");
  brokenAssign = await defOf(
    "mcp_internal.assign_production(text,text,text,uuid,uuid,text,uuid[],date,numeric,text,text,text)");
  expect(brokenDispatch).toMatch(/v_need_cat\s+text;/);
  expect(brokenAssign).toMatch(/v_need_cat\s+text;/);

  await db.exec(await migration("20261002090000_138_dispatch_brief_team_category.sql"));
  await db.exec(await migration("20261002090100_139_assign_production_columns_and_category.sql"));
  fixedDispatch = await defOf("public.dispatch_brief_to_members(uuid,uuid[],date,numeric,text)");
  fixedAssign = await defOf(
    "mcp_internal.assign_production(text,text,text,uuid,uuid,text,uuid[],date,numeric,text,text,text)");
  expect(fixedDispatch).toMatch(/v_need_cat\s+team_category;/);
  expect(fixedAssign).toMatch(/v_need_cat\s+team_category;/);

  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}');
    update profiles set role = 'admin' where id = '${ADMIN}';
    insert into clients (id, name, initials) values ('${CLIENT}', 'Client A', 'A');
    insert into agents (agent_key, name, initials, domain, description)
      values ('brief_dispatch','Brief dispatch','BD','content','Emails a brief'),
             ('creative_build','Creative build','CB','content','Renders an asset')
      on conflict (agent_key) do nothing;
    insert into client_briefs (id, client_id, title, media_type, status, avatar_brief, editor_brief)
      values ('${VIDEO_BRIEF}', '${CLIENT}', 'A reel', 'video', 'approved', 'Say this', 'Cut that');
    insert into client_briefs (id, client_id, title, media_type, status)
      values ('${IMAGE_BRIEF}', '${CLIENT}', 'A still', 'image', 'approved');
  `);
  const avatar = await db.query<{ id: string }>(`
    insert into team_members (category, name, initials, engagement)
    values ('avatars', 'Avatar 1', 'A1', 'contractor') returning id`);
  const editor = await db.query<{ id: string }>(`
    insert into team_members (category, name, initials, engagement)
    values ('editors', 'Editor 1', 'E1', 'contractor') returning id`);
  avatarId = avatar.rows[0]!.id;
  editorId = editor.rows[0]!.id;
});

beforeEach(async () => {
  await db.exec(`reset role;
    delete from brief_dispatches; delete from job_assignments; delete from agent_jobs;
    ${fixedDispatch}; ${fixedAssign};`);
  await asAdmin();
});

describe("migration 138: dispatch_brief_to_members", () => {
  it("sends a video brief to an avatar, and records which body went", async () => {
    const sent = await db.query<{ n: number }>(
      "select dispatch_brief_to_members($1, $2, null, null, 'avatar') as n",
      [VIDEO_BRIEF, [avatarId]]);
    expect(sent.rows[0]!.n).toBe(1);

    const dispatch = await db.query<{ brief_role: string; member_id: string }>(
      "select brief_role, member_id from brief_dispatches");
    expect(dispatch.rows).toHaveLength(1);
    expect(dispatch.rows[0]).toMatchObject({ brief_role: "avatar", member_id: avatarId });
  });

  it("sends the editor body to an editor independently of the avatar one", async () => {
    await db.query("select dispatch_brief_to_members($1, $2, null, null, 'avatar')", [VIDEO_BRIEF, [avatarId]]);
    await db.query("select dispatch_brief_to_members($1, $2, null, null, 'editor')", [VIDEO_BRIEF, [editorId]]);
    const roles = await db.query<{ brief_role: string }>(
      "select brief_role from brief_dispatches order by brief_role");
    expect(roles.rows.map((r) => r.brief_role)).toEqual(["avatar", "editor"]);
  });

  it("still refuses the wrong category, with the business message rather than a type error", async () => {
    await expect(
      db.query("select dispatch_brief_to_members($1, $2, null, null, 'avatar')", [VIDEO_BRIEF, [editorId]]),
    ).rejects.toThrow(/is not in the avatars category/);
  });

  it("raises Postgres's own operator error on the migration-95 body", async () => {
    await db.exec(`reset role; ${brokenDispatch}`);
    await asAdmin();
    await expect(
      db.query("select dispatch_brief_to_members($1, $2, null, null, 'avatar')", [VIDEO_BRIEF, [avatarId]]),
    ).rejects.toThrow(/operator does not exist: team_category = text/);
  });

  it("breaks the full role too: plpgsql plans the guard before it short-circuits", async () => {
    // Worth stating because the opposite is the intuitive reading, and it was
    // mine until this test contradicted it. `if a and b` in plpgsql is planned
    // as a single SQL expression, so team_category = text has to resolve even
    // when v_need_cat is null and the condition could never reach b. So
    // migration 95 broke every dispatch that reaches the member loop, not just
    // the avatar and editor ones.
    await db.exec(`reset role; ${brokenDispatch}`);
    await asAdmin();
    await expect(
      db.query("select dispatch_brief_to_members($1, $2, null, null, 'full') as n",
        [VIDEO_BRIEF, [editorId]]),
    ).rejects.toThrow(/operator does not exist: team_category = text/);
  });
});

describe("migration 139: mcp_internal.assign_production", () => {
  const call = (route: string, members: string[] | null, briefRole: string | null, brief = VIDEO_BRIEF) =>
    db.query(
      `select mcp_internal.assign_production('bot_production','req-1','exec-1',$1,$2,$3,$4,null,null,'medium','1024x1536',$5)`,
      [CLIENT, brief, route, members, briefRole]);

  it("assigns the human avatar route, which has never worked in production", async () => {
    await db.exec("reset role");
    await call("human", [avatarId], "avatar");
    const dispatch = await db.query<{ brief_role: string; member_id: string }>(
      "select brief_role, member_id from brief_dispatches");
    expect(dispatch.rows).toHaveLength(1);
    expect(dispatch.rows[0]).toMatchObject({ brief_role: "avatar", member_id: avatarId });
  });

  it("raises the operator error on the migration-95 body", async () => {
    await db.exec(`reset role; ${brokenAssign}`);
    await expect(call("human", [avatarId], "avatar"))
      .rejects.toThrow(/operator does not exist: team_category = text/);
  });

  it("inserts creative_renders with the migration-93 column list on the AI route", async () => {
    await db.exec("reset role");
    await call("ai", null, null, IMAGE_BRIEF);
    const render = await db.query<{ generation_id: string; client_id: string; quality: string }>(
      "select generation_id, client_id, quality from creative_renders");
    expect(render.rows).toHaveLength(1);
    expect(render.rows[0]!.client_id).toBe(CLIENT);
    expect(render.rows[0]!.quality).toBe("medium");
  });

  it("fails on the AI route with the migration-95 body, which is the column bug", async () => {
    await db.exec(`reset role; ${brokenAssign}`);
    await expect(call("ai", null, null, IMAGE_BRIEF)).rejects.toThrow();
  });
});
