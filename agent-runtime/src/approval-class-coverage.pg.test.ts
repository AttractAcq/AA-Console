import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOURCE = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
let db: PGlite;

async function asUser<T extends Record<string, unknown>>(id: string, sql: string) {
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec("set role authenticated");
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.role','',false); select set_config('request.jwt.claim.sub','',false)");
  }
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
    create table public.clients (id uuid primary key);
    create table public.campaign_action_approvals
      (id uuid primary key, status text, request_hash text);
    create table public.client_sales_entitlement_requests
      (id uuid primary key, status text, scope_hash text);
    create table public.client_briefs
      (id uuid primary key, status text, archived_at timestamptz, body_hash text);
    create function public.recruitment_brief_snapshot_hash_v6(
      public.client_briefs) returns text language sql stable as
      $$ select $1.body_hash $$;
    create table public.google_review_replies
      (id uuid primary key, status text, payload jsonb);
    create function public.google_reply_inbox_payload_v6(
      public.google_review_replies) returns jsonb language sql stable as
      $$ select $1.payload $$;
    create table public.content_slots (id uuid primary key, stage text);
    create table public.slot_events
      (id uuid primary key, slot_id uuid, to_stage text, created_at timestamptz);
    create table public.profiles (id uuid primary key, role text not null);
    insert into public.profiles values ('${ADMIN}','admin'),('${CLIENT_USER}','client');
    create function public.current_role_of() returns text language sql stable
      security definer set search_path=public as $$
        select role from public.profiles where id=auth.uid()
      $$;
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path=public as $$
        select coalesce(public.current_role_of()='admin',false)
      $$;
    create function public.active_video_approval_manager(uuid) returns uuid
      language sql stable as $$ select null::uuid $$;
    create function public.lock_down_definer_functions() returns integer
      language sql as $$ select 0 $$;
    grant usage on schema public,auth to authenticated,service_role;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin() to authenticated,service_role;
  `);
  for (const filename of [
    "20261030110000_273_canonical_approval_ledger.sql",
    "20261030160000_279_approval_class_coverage.sql",
  ]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
  }
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("34-class Approval Inbox coverage feed migration 279", () => {
  it("contains every class exactly once and remains red while executors are missing", async () => {
    const classes = (await db.query<{
      class_id: number; class_key: string; overall_status: string;
      source_state: string; decision_state: string; executor_state: string;
    }>("select * from public.approval_class_coverage_v6 order by class_id")).rows;
    expect(classes).toHaveLength(34);
    expect(classes.map((row) => row.class_id)).toEqual(
      Array.from({ length: 34 }, (_, index) => index + 1),
    );
    expect(new Set(classes.map((row) => row.class_key)).size).toBe(34);
    expect(classes.every((row) => row.overall_status !== "operational")).toBe(true);
    expect(classes.find((row) => row.class_id === 1)).toMatchObject({
      class_key: "engine_slot", source_state: "blocked",
      decision_state: "missing", executor_state: "missing",
    });
    expect(classes.find((row) => row.class_id === 21)).toMatchObject({
      class_key: "google_review_reply", source_state: "verified",
      decision_state: "verified", executor_state: "missing",
      overall_status: "blocked",
    });
    expect(classes.find((row) => row.class_id === 34)).toMatchObject({
      class_key: "team_invitation", overall_status: "missing",
    });
    const summary = (await db.query<{
      expected_classes: number; inventoried_classes: number;
      operational_classes: number; fully_operational: boolean;
    }>("select * from public.approval_coverage_summary_v6")).rows[0]!;
    expect(summary).toMatchObject({ expected_classes: 34, inventoried_classes: 34,
      operational_classes: 0, fully_operational: false });
  });

  it("requires separate executor evidence and preserves an append-only history", async () => {
    await expect(db.query(`insert into public.approval_class_coverage_versions_v6
      (class_id,revision,class_key,title,source_state,source_evidence,
       decision_state,decision_evidence,executor_state)
      values (21,2,'google_review_reply','Google review reply',
        'verified','278 source trigger','verified','278 decision trigger','verified')`))
      .rejects.toThrow(/check constraint/i);
    await expect(db.query(`insert into public.approval_class_coverage_versions_v6
      (class_id,revision,class_key,title,source_state,
       decision_state,executor_state)
      values (21,2,'renamed_reply','Google review reply',
        'missing','missing','missing')`))
      .rejects.toThrow(/immutable class identity/i);
    await expect(db.query(`update public.approval_class_coverage_versions_v6
      set executor_state='verified' where class_id=21`))
      .rejects.toThrow(/append-only/i);
    await expect(db.query("delete from public.approval_class_coverage_versions_v6 where class_id=21"))
      .rejects.toThrow(/append-only/i);
    await expect(db.query("truncate public.approval_class_coverage_versions_v6"))
      .rejects.toThrow(/append-only/i);
  });

  it("exposes the feed to an admin, not to a client reader", async () => {
    const admin = await asUser<{ class_id: number }>(ADMIN,
      "select class_id from public.approval_class_coverage_v6");
    const client = await asUser<{ class_id: number }>(CLIENT_USER,
      "select class_id from public.approval_class_coverage_v6");
    expect(admin).toHaveLength(34);
    expect(client).toHaveLength(0);
  });

  it("reconciles edited, archived, and cancelled source cards live in the canonical view", async () => {
    const register = async (kind: string, sourceVersion: string,
      sourceSystem = "aa_console", extra: Record<string, unknown> = {}) => {
      const payload = {
        client_id: null, source_system: sourceSystem, source_kind: kind,
        source_id: SOURCE, source_version: sourceVersion,
        title: kind, artifact_hash: HASH, preview: { words: "exact" },
        destination: "internal:test", scope: { source: kind },
        owner_role: "admin", requester_kind: "unknown",
        expires_at: "2030-01-01T00:00:00Z", ...extra,
      };
      return (await db.query<{ id: string }>(
        "select public.register_approval_request_v6($1::jsonb) as id",
        [JSON.stringify(payload)],
      )).rows[0]!.id;
    };
    const state = async (id: string) => (await asUser<{
      status: string; source_state: string;
    }>(ADMIN, `select status,source_state from public.approval_inbox_v6 where id='${id}'`))[0]!;

    await db.query("insert into public.client_briefs values ($1,'draft',null,$2)",
      [SOURCE, HASH]);
    const brief = await register("recruitment_brief", HASH + ":v1");
    expect(await state(brief)).toMatchObject({ status: "pending", source_state: "pending" });
    await db.query("update public.client_briefs set body_hash=$2 where id=$1",
      [SOURCE, "b".repeat(64)]);
    expect(await state(brief)).toMatchObject({ status: "superseded", source_state: "superseded" });
    await db.query("update public.client_briefs set archived_at=now() where id=$1", [SOURCE]);
    expect(await state(brief)).toMatchObject({ status: "cancelled", source_state: "cancelled" });

    await db.query("insert into public.campaign_action_approvals values ($1,'pending','version-1')",
      [SOURCE]);
    const action = await register("campaign_action", "version-1");
    expect(await state(action)).toMatchObject({ status: "pending", source_state: "pending" });
    await db.query("update public.campaign_action_approvals set status='rejected' where id=$1",
      [SOURCE]);
    expect(await state(action)).toMatchObject({
      status: "source_decided", source_state: "source_decided",
    });

    await db.query("insert into public.google_review_replies values ($1,'drafted',$2::jsonb)",
      [SOURCE, JSON.stringify({
        source_version: HASH, artifact_hash: HASH, preview: { words: "exact" },
        destination: "internal:test", account_ref: null,
        scope: { source: "google_review_reply" }, preview_blocker: null,
      })]);
    const reply = await register("google_review_reply", HASH);
    expect(await state(reply)).toMatchObject({ status: "pending", source_state: "pending" });
    await db.query("update public.google_review_replies set payload=jsonb_set(payload,'{preview,words}','\"edited\"') where id=$1",
      [SOURCE]);
    expect(await state(reply)).toMatchObject({ status: "superseded", source_state: "superseded" });

    const firstEpoch = "33333333-3333-4333-8333-333333333333";
    const secondEpoch = "44444444-4444-4444-8444-444444444444";
    await db.query("insert into public.content_slots values ($1,'awaiting_approval')", [SOURCE]);
    await db.query("insert into public.slot_events values ($1,$2,'awaiting_approval','2030-01-01T00:00:00Z')",
      [firstEpoch, SOURCE]);
    const slot = await register("engine_slot", firstEpoch, "aa_console",
      { artifact_hash: null, preview_blocker: "Media bytes unverified" });
    expect(await state(slot)).toMatchObject({ status: "pending", source_state: "pending" });
    await db.query("insert into public.slot_events values ($1,$2,'awaiting_approval','2029-01-01T00:00:00Z')",
      [secondEpoch, SOURCE]);
    expect(await state(slot)).toMatchObject({
      status: "unverified", source_state: "unverified",
    });

    await db.query("create table public.console_invitation_requests_v6 (id uuid primary key, status text, payload_hash text)");
    await db.query("insert into public.console_invitation_requests_v6 values ($1,'requested',$2)",
      [SOURCE, HASH]);
    const invite = await register("console_invitation", HASH, "auth");
    expect(await state(invite)).toMatchObject({ status: "pending", source_state: "pending" });
    await db.query("update public.console_invitation_requests_v6 set status='cancelled' where id=$1",
      [SOURCE]);
    expect(await state(invite)).toMatchObject({ status: "cancelled", source_state: "cancelled" });

    const unknown = await register("new_unbound_source", HASH);
    expect(await state(unknown)).toMatchObject({
      status: "unverified", source_state: "unverified",
    });
  });
});
