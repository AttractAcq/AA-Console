import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOUSE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BRIEF = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
const FOREIGN_ASSET = "55555555-5555-4555-8555-555555555555";
let db: PGlite;

const migration = (name: string) =>
  readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "service_role" | "anon", userId: string | null,
  sql: string, params: unknown[] = [],
): Promise<T[]> {
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId ?? ""]);
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.role','',false)");
    await db.exec("select set_config('request.jwt.claim.sub','',false)");
  }
}

async function card(sourceId: string) {
  return (await asRole<{
    id: string; status: string; source_state: string;
    artifact_hash: string; preview_blocker: string;
    preview: Record<string, unknown>; account_ref: string | null;
    budget: Record<string, unknown>; source_version: string;
  }>("authenticated", ADMIN,
    `select id,status,source_state,artifact_hash,preview_blocker,
            preview,account_ref,budget,source_version
       from public.approval_inbox_v6
      where source_kind='recruitment_meta_build' and source_id=$1
      order by requested_at desc limit 1`, [sourceId]))[0]!;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select '{}'::jsonb $$;
    create table public.clients (id uuid primary key, is_internal boolean, name text);
    insert into public.clients values
      ('${HOUSE}',true,'Attract Acquisition'),('${OTHER}',false,'Other');
    create table public.profiles (id uuid primary key, role text not null);
    insert into public.profiles values ('${ADMIN}','admin'),('${MEMBER}','employee');
    create function public.current_role_of() returns text language sql stable
      security definer set search_path=public as $$
        select role from public.profiles where id=auth.uid()
      $$;
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path=public as $$
        select coalesce(public.current_role_of()='admin',false)
      $$;
    create function public.can_access_client(p_client_id uuid) returns boolean
      language sql stable security definer set search_path=public as $$
        select coalesce(public.is_admin(),false) and p_client_id = '${HOUSE}'::uuid
      $$;
    create function public.can_run_agent(text, uuid) returns boolean
      language sql stable as $$ select true $$;
    create function public.aa_house_client_id() returns uuid language sql stable
      as $$ select id from public.clients where is_internal
        and lower(name)='attract acquisition' order by id limit 1 $$;
    create function public.active_video_approval_manager(uuid) returns uuid
      language sql stable as $$ select null::uuid $$;
    create function public.lock_down_definer_functions() returns integer
      language sql as $$ select 0 $$;

    create table public.client_briefs (
      id uuid primary key, client_id uuid not null references public.clients(id),
      purpose text, hook text, script text, compensation_text text,
      call_to_action text, apply_url text, status text,
      archived_at timestamptz, body_hash text);
    create function public.recruitment_brief_snapshot_hash_v6(
      public.client_briefs) returns text language sql stable as
      $$ select $1.body_hash $$;
    create table public.client_media_assets (
      id uuid primary key, client_id uuid not null references public.clients(id),
      brief_id uuid references public.client_briefs(id) on delete set null,
      purpose text, review_status text, media_type text, content_format text,
      storage_path text, title text, human_approved_at timestamptz,
      archived_at timestamptz, usage_rights text);
    create table public.client_integrations (
      id uuid primary key default gen_random_uuid(), client_id uuid not null,
      provider text, status text, ad_account_id text,
      meta_page_id text, meta_pixel_id text, credential_label text,
      credential_secret_id uuid);
    create table public.agents (
      agent_key text primary key, name text, initials text, domain text,
      description text, requires_upstream text[], requires_input boolean,
      paused boolean not null default false, archived_at timestamptz,
      scheduled_only boolean not null default false);
    create table public.agent_jobs (
      id uuid primary key default gen_random_uuid(), agent_key text,
      client_id uuid, input_table text, input_id uuid,
      status text not null default 'queued', run_id uuid, created_by uuid);
    create table public.agent_job_events (
      id uuid primary key default gen_random_uuid(), job_id uuid,
      description text);
    create function public.enqueue_agent_job_internal(
      p_agent_key text, p_client_id uuid, p_input_table text,
      p_input_id uuid, p_actor uuid, p_params jsonb default '{}'::jsonb,
      p_description text default 'Queued'
    ) returns uuid language plpgsql security definer as $$
    declare v_id uuid;
    begin
      insert into public.agent_jobs(agent_key,client_id,input_table,input_id)
      values(p_agent_key,p_client_id,p_input_table,p_input_id) returning id into v_id;
      return v_id;
    end; $$;
    create table public.campaign_action_approvals
      (id uuid primary key, client_id uuid, campaign_id uuid,
       manifest_id uuid, status text, request_hash text);
    create table public.campaign_manifest_versions
      (id uuid primary key, campaign_id uuid, version integer);
    create table public.client_sales_entitlement_requests
      (id uuid primary key, client_id uuid, status text, scope_hash text);
    create table public.google_review_replies
      (id uuid primary key, client_id uuid, status text, payload jsonb);
    create function public.google_reply_inbox_payload_v6(
      public.google_review_replies) returns jsonb language sql stable as
      $$ select $1.payload $$;
    create table public.content_slots (
      id uuid primary key, client_id uuid, asset_id uuid,
      platform text, scheduled_at timestamptz, format text, stage text);
    create table public.slot_events
      (id uuid primary key, slot_id uuid, to_stage text, created_at timestamptz);

    insert into public.client_briefs
      (id,client_id,purpose,hook,script,compensation_text,call_to_action,apply_url,status,body_hash)
      values ('${BRIEF}','${HOUSE}','recruitment','Join AA','Hiring an editor',
        'Salary negotiable','APPLY_NOW','https://example.com/apply','draft',repeat('a',64));
    insert into public.client_media_assets
      (id,client_id,brief_id,purpose,review_status,media_type,content_format,
       storage_path,title,human_approved_at)
      values ('${ASSET}','${HOUSE}','${BRIEF}','recruitment','approved',
        'image','single','hiring/editor.png','Editor',now()),
       ('${FOREIGN_ASSET}','${OTHER}',null,'recruitment','approved',
        'image','single','other/ad.png','Foreign',now());
    insert into public.client_integrations
      (client_id,provider,status,ad_account_id,meta_page_id,meta_pixel_id,credential_label)
      values ('${HOUSE}','meta','connected','act_123','page_1','pixel_1','house');
    insert into public.agents(agent_key) values
      ('icp'),('meta_build'),('recruitment_meta_build');
    grant usage on schema public,auth to authenticated,service_role,anon;
    grant select,insert,update,delete on public.agent_jobs to authenticated;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin(),public.can_access_client(uuid),
      public.aa_house_client_id() to authenticated,service_role,anon;
  `);
  for (const name of [
    "20260926110000_133_recruitment_meta_distribution.sql",
    "20261030110000_273_canonical_approval_ledger.sql",
    "20261030160000_279_approval_class_coverage.sql",
    "20261101050000_288_production_release_candidate_inbox.sql",
    "20261101070000_290_meta_legacy_producer_containment.sql",
  ]) await db.exec(await migration(name));
  await db.exec("set timezone='UTC'");
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("Meta legacy producer containment migration 290", () => {
  it("denies both generic Meta keys and legacy request while preserving benign enqueue", async () => {
    for (const key of ["meta_build", "recruitment_meta_build"]) {
      await expect(asRole("authenticated", ADMIN,
        "select public.enqueue_agent_job($1,$2,null,null)", [key, HOUSE]))
        .rejects.toThrow(/exact AAL2 Approval Inbox/);
    }
    await expect(asRole("authenticated", ADMIN,
      "select public.request_meta_build($1)", [HOUSE]))
      .rejects.toThrow(/Legacy Meta builds are held/);
    expect((await db.query("select id from public.agent_jobs")).rows).toHaveLength(0);
    await asRole("authenticated", ADMIN,
      "select public.enqueue_agent_job('icp',$1,null,null)", [HOUSE]);
    expect((await db.query<{ agent_key: string }>(
      "select agent_key from public.agent_jobs")).rows).toEqual([{ agent_key: "icp" }]);
  });

  it("revokes direct authenticated job writes and holds service-role generic Meta producers", async () => {
    await expect(asRole("authenticated", ADMIN,
      "insert into public.agent_jobs(agent_key,client_id) values('meta_build',$1)", [HOUSE]))
      .rejects.toThrow(/permission denied/i);
    const benignId = (await db.query<{ id: string }>(
      "insert into public.agent_jobs(agent_key,client_id) values('icp',$1) returning id",
      [HOUSE])).rows[0]!.id;
    await expect(asRole("authenticated", ADMIN,
      "update public.agent_jobs set agent_key='meta_build' where id=$1", [benignId]))
      .rejects.toThrow(/permission denied/i);
    for (const key of ["meta_build", "recruitment_meta_build"]) {
      await expect(asRole("service_role", null,
        "select public.enqueue_agent_job_as($1,$2,$3,null,null)",
        [ADMIN, key, HOUSE])).rejects.toThrow(/exact AAL2 Approval Inbox/);
    }
    await asRole("service_role", null,
      "select public.enqueue_agent_job_as($1,'icp',$2,null,null)", [ADMIN, HOUSE]);
    await asRole("service_role", null,
      "select public.start_master_run_as($1,$2)", [ADMIN, OTHER]);
    const masterKeys = (await db.query<{ agent_key: string }>(
      "select agent_key from public.agent_jobs where client_id=$1", [OTHER]))
      .rows.map((row) => row.agent_key);
    expect(masterKeys).toEqual(["icp"]);
    expect((await db.query("select id from public.agent_jobs where agent_key in ('meta_build','recruitment_meta_build')"))
      .rows).toHaveLength(0);
  });

  it("creates a house recruitment source and one blocked, exact Inbox card without a job", async () => {
    await expect(asRole("authenticated", MEMBER,
      "select public.create_recruitment_meta_campaign($1,$2,$3,$4)",
      ["Hiring", 25, ["ZA"], [ASSET]])).rejects.toThrow(/Only an admin/);
    await expect(asRole("authenticated", ADMIN,
      "select public.create_recruitment_meta_campaign($1,$2,$3,$4)",
      ["Hiring", 25, ["ZA"], [FOREIGN_ASSET]])).rejects.toThrow(/approved AA recruitment/);
    const campaignId = (await asRole<{ id: string }>("authenticated", ADMIN,
      "select public.create_recruitment_meta_campaign($1,$2,$3,$4) as id",
      ["Editor hiring", 25, ["ZA"], [ASSET]]))[0]!.id;
    expect((await db.query("select id from public.agent_jobs where agent_key='recruitment_meta_build'"))
      .rows).toHaveLength(0);
    const current = await card(campaignId);
    expect(current).toMatchObject({
      status: "source_held", source_state: "source_held", account_ref: "act_123",
      budget: { daily_budget: 25, currency: null },
    });
    expect(current.preview_blocker).toMatch(/exact image bytes.*AAL2 decision.*provider-write/i);
    expect(current.source_version).toMatch(new RegExp(`^${current.artifact_hash}:v1$`));
    expect(JSON.stringify(current.preview)).toContain("Hiring an editor");
    expect(JSON.stringify(current.preview)).toContain("hiring/editor.png");
    expect(JSON.stringify(current.preview)).toContain("act_123");
    const duplicate = (await asRole<{ id: string }>("authenticated", ADMIN,
      "select public.request_recruitment_meta_build($1) as id", [campaignId]))[0]!.id;
    expect(duplicate).toBe(current.id);
    expect((await db.query("select id from public.agent_jobs where agent_key='recruitment_meta_build'"))
      .rows).toHaveLength(0);

    await db.query("update public.client_briefs set script='Revised creative' where id=$1", [BRIEF]);
    expect(await card(campaignId)).toMatchObject({
      id: current.id, status: "superseded", source_state: "superseded",
    });
    const replacement = (await asRole<{ id: string }>("authenticated", ADMIN,
      "select public.request_recruitment_meta_build($1) as id", [campaignId]))[0]!.id;
    expect(replacement).not.toBe(current.id);
    expect(await card(campaignId)).toMatchObject({
      id: replacement, status: "source_held", source_state: "source_held",
    });
    await db.query("update public.client_integrations set ad_account_id='act_999' where client_id=$1", [HOUSE]);
    expect(await card(campaignId)).toMatchObject({
      id: replacement, status: "superseded", source_state: "superseded",
    });
    const accountReplacement = (await asRole<{ id: string }>("authenticated", ADMIN,
      "select public.request_recruitment_meta_build($1) as id", [campaignId]))[0]!.id;
    expect(accountReplacement).not.toBe(replacement);
    expect(await card(campaignId)).toMatchObject({
      id: accountReplacement, status: "source_held", source_state: "source_held",
      account_ref: "act_999",
    });
    await db.query("delete from public.recruitment_meta_campaigns where id=$1", [campaignId]);
    expect(await card(campaignId)).toMatchObject({
      status: "cancelled", source_state: "cancelled",
    });
  });

  it("keeps the held class unavailable to non-admin readers and never reports it operational", async () => {
    const classes = (await asRole<{
      class_id: number; source_state: string; decision_state: string;
      executor_state: string; overall_status: string;
    }>("authenticated", ADMIN,
      "select class_id,source_state,decision_state,executor_state,overall_status from public.approval_class_coverage_v6 where class_id=18"));
    expect(classes[0]).toMatchObject({
      class_id: 18, source_state: "blocked", decision_state: "missing",
      executor_state: "missing", overall_status: "blocked",
    });
    expect(await asRole("authenticated", MEMBER,
      "select id from public.approval_inbox_v6 where source_kind='recruitment_meta_build'"))
      .toHaveLength(0);
    await expect(asRole("authenticated", ADMIN,
      "select public.recruitment_meta_build_snapshot_v6($1)", [HOUSE]))
      .rejects.toThrow(/permission denied/i);
  });

  it("supersedes a held card if its client stops being the AA house account", async () => {
    const campaignId = (await asRole<{ id: string }>("authenticated", ADMIN,
      "select public.create_recruitment_meta_campaign($1,$2,$3,$4) as id",
      ["House lineage", 25, ["ZA"], [ASSET]]))[0]!.id;
    expect(await card(campaignId)).toMatchObject({ status: "source_held" });
    await db.query("update public.clients set is_internal=false where id=$1", [HOUSE]);
    expect(await card(campaignId)).toMatchObject({ status: "superseded" });
    await db.query("update public.clients set is_internal=true where id=$1", [HOUSE]);
  });
});
