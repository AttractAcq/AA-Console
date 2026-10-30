import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const OTHER_LEAD = "44444444-4444-4444-8444-444444444444";
const DIRTY_LEAD = "44444444-4444-4444-8444-444444444445";
const SEQUENCE = "55555555-5555-4555-8555-555555555555";
const ENROLLMENT = "66666666-6666-4666-8666-666666666666";
const APPOINTMENT = "77777777-7777-4777-8777-777777777777";
const CONVERSATION = "88888888-8888-4888-8888-888888888888";
const RUN = "99999999-9999-4999-8999-999999999999";
const OTHER_CAMPAIGN = "aaaaaaaa-0000-4000-8000-000000000001";
const LOCAL_CAMPAIGN = "aaaaaaaa-0000-4000-8000-000000000002";
const PRIVATE_CALLS: Array<[string, unknown[], RegExp | null]> = [
  ["select suppress_lead_v6($1,'','manual')", [CLIENT], /Say who/],
  ["select sequence_exit_reason_v6($1,$2)", [LEAD, SEQUENCE], null],
  ["select enroll_lead_in_sequence_v6($1,$2)", [LEAD, SEQUENCE], null],
  ["select exit_lead_from_sequence_v6($1,'')", [ENROLLMENT], /Say why/],
  ["select book_appointment_v6($1,now(),'person')", [LEAD], /not taking bookings/],
  ["select record_appointment_outcome_v6($1,'bogus')", [APPOINTMENT], /An outcome/],
  ["select create_booking_link_v6($1,'sales','bad')", [CLIENT], /64 hex characters/],
  ["select capture_sales_agent_lead($1)", [CONVERSATION], null],
  ["select workflow_run_outcomes($1)", [RUN], null],
];
let db: PGlite;

async function actor(kind: "editor" | "sales" | "client" | "other_client" | "admin" | "service") {
  await db.query("select set_config('test.actor',$1,false)", [kind]);
  await db.query("select set_config('test.role',$1,false)",
    [kind === "service" ? "service_role" : "authenticated"]);
}
async function refused(sql: string, values: unknown[] = []) {
  try { await db.query(sql, values); } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected refusal from ${sql}`);
}
async function expectAllPrivateCallsDenied() {
  for (const [call, values] of PRIVATE_CALLS) {
    if (call.includes("sequence_exit_reason_v6")) {
      expect((await db.query<{ reason: string }>(call + " as reason", values))
        .rows[0]?.reason, call).toBe("The sequence no longer exists.");
    } else {
      expect(await refused(call, values), call).toMatch(/Not permitted/i);
    }
  }
}
async function expectAllPrivateCallsAllowed() {
  for (const [call, values, downstream] of PRIVATE_CALLS) {
    if (downstream) {
      expect(await refused(call, values), call).toMatch(downstream);
    } else if (call.includes("sequence_exit_reason_v6")) {
      expect((await db.query<{ reason: string | null }>(call + " as reason", values))
        .rows[0]?.reason, call).toBeNull();
    } else {
      await expect(db.query(call, values), call).resolves.toBeDefined();
    }
  }
}
const sql = (file: string) => readFile(new URL(
  `../../../supabase/migrations/${file}`, import.meta.url), "utf8");

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role authenticated; create role service_role;
    create schema auth;
    create function public.enqueue_sequence_sweep() returns uuid language sql as
      $$ select null::uuid $$;
    revoke execute on function public.enqueue_sequence_sweep() from public;
    grant execute on function public.enqueue_sequence_sweep()
      to authenticated,service_role;
    create function auth.role() returns text language sql stable as
      $$ select coalesce(current_setting('test.role',true),'authenticated') $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid $$;
    create function public.is_admin() returns boolean language sql stable as
      $$ select current_setting('test.actor',true)='admin' $$;
    create function public.can_access_client(target uuid) returns boolean language sql stable as
      $$ select target='${CLIENT}'::uuid and current_setting('test.actor',true)
           in ('editor','sales','client','admin') $$;
    create function public.may_manage_client_leads(target uuid) returns boolean language sql stable as
      $$ select auth.role()='service_role' or public.is_admin()
        or (target='${CLIENT}'::uuid and current_setting('test.actor',true)='client')
        or (target='${OTHER}'::uuid and current_setting('test.actor',true)='other_client')
        or (target='${CLIENT}'::uuid and current_setting('test.actor',true)='sales'
          and current_setting('test.sales_enabled',true)='true'
          and current_setting('test.retired',true) is distinct from 'true'
          and current_setting('test.revoked',true) is distinct from 'true') $$;
    create type lead_stage as enum ('lead','conversation','qualified_conversation',
      'appointment','qualified_appointment','shown','sale','cash');
    create table public.client_leads (
      id uuid primary key,client_id uuid not null,name text,email text,phone text,
      dedupe_key text,stage lead_stage not null default 'lead',
      stage_at timestamptz,appointment_at timestamptz,
      consent_given_at timestamptz,consent_wording text,is_probe boolean default false,
      source text,source_channel text,source_page_id uuid,source_sales_agent_id uuid,
      source_client_campaign_id uuid,opportunity_value numeric,notes text,
      cash_collected numeric default 0);
    create table public.lead_suppressions (
      id uuid primary key default gen_random_uuid(),client_id uuid not null,
      dedupe_key text not null,reason text not null,detail text,created_by uuid,
      unique(client_id,dedupe_key));
    create table public.nurture_sequences (
      id uuid primary key,client_id uuid not null,exit_stages lead_stage[] not null default '{}',
      archived_at timestamptz,approved_at timestamptz);
    create table public.nurture_sequence_steps (
      id uuid primary key default gen_random_uuid(),sequence_id uuid,
      position integer,delay_hours integer);
    create table public.lead_sequence_enrollments (
      id uuid primary key default gen_random_uuid(),client_id uuid not null,lead_id uuid,sequence_id uuid,
      status text,next_due_at timestamptz,enrolled_by uuid,exit_reason text,
      exited_at timestamptz,unique(lead_id,sequence_id));
    create table public.client_booking_settings (
      client_id uuid primary key,enabled boolean,slot_minutes integer,max_days_ahead integer,
      timezone text);
    create table public.client_campaigns(id uuid primary key,client_id uuid not null);
    create table public.client_appointments (
      id uuid primary key,client_id uuid not null,lead_id uuid,starts_at timestamptz,
      ends_at timestamptz,booked_via text,booked_by uuid,campaign_id uuid,
      status text,outcome_note text,cancelled_reason text);
    create table public.booking_links (
      id uuid primary key default gen_random_uuid(),client_id uuid,campaign_id uuid,
      purpose text,token_hash text,expires_at timestamptz,created_by uuid);
    create table public.outbound_messages (
      id uuid primary key default gen_random_uuid(),client_id uuid not null,campaign_id uuid);
    create table public.lead_capture_endpoints (
      id uuid primary key default gen_random_uuid(),client_id uuid not null,campaign_id uuid);
    create table public.message_templates (
      id uuid primary key default gen_random_uuid(),client_id uuid not null,
      name text,purpose text,channel_key text,campaign_id uuid,created_by uuid);
    create table public.sales_agent_conversations (
      id uuid primary key,client_id uuid not null,lead_id uuid,contact_email text,
      contact_phone text,contact_name text,qualified boolean,page_id uuid,
      sales_agent_id uuid,outcome text);
    create table public.lead_events (
      id uuid primary key default gen_random_uuid(),lead_id uuid,client_id uuid,
      kind text,body text,detail text,from_stage lead_stage,to_stage lead_stage,
      created_by uuid);
    create table public.workflow_runs (
      id uuid primary key,client_id uuid not null,kind text,status text,
      deadline_at timestamptz,review_ready_at timestamptz);
    create table public.agent_jobs(run_id uuid,cost_usd numeric,status text);
    create table public.workflow_artifacts(run_id uuid,artifact_kind text,record_id uuid);
    create table public.client_media_assets(id uuid,human_approved_at timestamptz);
    create table public.client_asset_reviews(asset_id uuid,decision text);
    create table public.workflow_lead_attribution(run_id uuid,lead_id uuid,label text);
    insert into client_leads(id,client_id,dedupe_key,stage,consent_given_at)
      values ('${LEAD}','${CLIENT}','email:lead@example.com','lead',now()),
             ('${OTHER_LEAD}','${OTHER}','email:other@example.com','cash',now());
    insert into client_leads(id,client_id,dedupe_key,stage,consent_given_at,source_client_campaign_id)
      values ('${DIRTY_LEAD}','${CLIENT}','email:dirty@example.com','lead',now(),
              '${OTHER_CAMPAIGN}');
    insert into nurture_sequences(id,client_id,approved_at)
      values ('${SEQUENCE}','${CLIENT}',now());
    insert into lead_sequence_enrollments(id,client_id,lead_id,sequence_id,status)
      values ('${ENROLLMENT}','${CLIENT}','${LEAD}','${SEQUENCE}','active');
    insert into client_appointments(id,client_id,lead_id,status)
      values ('${APPOINTMENT}','${CLIENT}','${LEAD}','booked');
    insert into sales_agent_conversations(id,client_id,lead_id)
      values ('${CONVERSATION}','${CLIENT}','${LEAD}');
    insert into workflow_runs(id,client_id,kind,status)
      values ('${RUN}','${CLIENT}','content','complete');
    insert into client_campaigns(id,client_id) values
      ('${OTHER_CAMPAIGN}','${OTHER}'),('${LOCAL_CAMPAIGN}','${CLIENT}');
  `);
  await db.exec(await sql("20261029200000_269_authenticated_sales_rpc_scope.sql"));
  await actor("editor");
});
afterEach(async () => { await db?.close(); });

describe("migration 269: all authenticated lead/contact SECURITY DEFINER boundaries", () => {
  it("rejects a foreign campaign when an assigned editor authors a message template", async () => {
    expect((await db.query<{ broad: boolean }>(
      `select can_access_client('${CLIENT}') as broad`)).rows[0]?.broad).toBe(true);
    expect(await refused(
      "select create_message_template_v6($1,'Reply','objection','email',$2)",
      [CLIENT, OTHER_CAMPAIGN])).toContain("campaign belongs to a different client");
    expect((await db.query("select id from message_templates")).rows).toHaveLength(0);
    await expect(db.query(
      "select create_message_template_v6($1,'Reply','objection','email',$2)",
      [CLIENT, LOCAL_CAMPAIGN])).resolves.toBeDefined();
  });

  it("enforces same-client campaign keys on new direct writes while preserving legacy rows for audit", async () => {
    expect((await db.query<{ campaign_id: string }>(
      "select source_client_campaign_id as campaign_id from client_leads where id=$1",
      [DIRTY_LEAD])).rows[0]?.campaign_id).toBe(OTHER_CAMPAIGN);
    const directWrites = [
      "insert into client_leads(id,client_id,source_client_campaign_id) values(gen_random_uuid(),$1,$2)",
      "insert into client_appointments(id,client_id,campaign_id) values(gen_random_uuid(),$1,$2)",
      "insert into outbound_messages(client_id,campaign_id) values($1,$2)",
      "insert into message_templates(client_id,campaign_id) values($1,$2)",
      "insert into booking_links(client_id,campaign_id) values($1,$2)",
      "insert into lead_capture_endpoints(client_id,campaign_id) values($1,$2)",
    ];
    for (const write of directWrites) {
      expect(await refused(write, [CLIENT, OTHER_CAMPAIGN]), write)
        .toMatch(/foreign key constraint/);
    }
    const localLead = "aaaaaaaa-0000-4000-8000-000000000003";
    await db.query("insert into client_leads(id,client_id,source_client_campaign_id) values($1,$2,$3)",
      [localLead, CLIENT, LOCAL_CAMPAIGN]);
    await db.query("delete from client_campaigns where id=$1", [LOCAL_CAMPAIGN]);
    expect((await db.query<{ client_id: string; source_client_campaign_id: string | null }>(
      "select client_id,source_client_campaign_id from client_leads where id=$1", [localLead]))
      .rows[0]).toMatchObject({ client_id: CLIENT, source_client_campaign_id: null });
  });

  it("denies a broad assigned editor at every callable private-data boundary", async () => {
    expect((await db.query<{ broad: boolean }>(
      `select can_access_client('${CLIENT}') as broad`)).rows[0]?.broad).toBe(true);
    await expectAllPrivateCallsDenied();
    expect((await db.query<{ allowed: boolean }>(
      "select has_function_privilege('authenticated','public.enqueue_sequence_sweep()','EXECUTE') as allowed"
    )).rows[0]?.allowed).toBe(false);
    expect((await db.query<{ allowed: boolean }>(
      "select has_function_privilege('service_role','public.enqueue_sequence_sweep()','EXECUTE') as allowed"
    )).rows[0]?.allowed).toBe(true);
  });

  it("keeps an unapproved sales seat dormant, then scopes live grant to its client", async () => {
    await actor("sales");
    await expectAllPrivateCallsDenied();
    await db.query("select set_config('test.sales_enabled','true',false)");
    await expectAllPrivateCallsAllowed();
    expect(await refused("select suppress_lead_v6($1,'x','manual')", [OTHER]))
      .toContain("Not permitted");
    await db.query("select set_config('test.retired','true',false)");
    await expectAllPrivateCallsDenied();
    await db.query("select set_config('test.retired','false',false)");
    await db.query("select set_config('test.revoked','true',false)");
    await expectAllPrivateCallsDenied();
  });

  it("preserves same-client users, admins and service while rejecting cross-client leads", async () => {
    await actor("client");
    await expectAllPrivateCallsAllowed();
    expect((await db.query<{ reason: string }>(
      "select sequence_exit_reason_v6($1,$2) as reason", [OTHER_LEAD, SEQUENCE]))
      .rows[0]?.reason).toBe("The lead no longer exists.");
    expect(await refused("select book_appointment_v6($1,now(),'sales_agent')", [LEAD]))
      .toContain("Only the internal service");
    expect(await refused("select book_appointment_v6($1,now(),'person',$2)",
      [LEAD, OTHER_CAMPAIGN])).toContain("campaign belongs to a different client");
    expect(await refused("select book_appointment_v6($1,now(),'person')", [DIRTY_LEAD]))
      .toContain("campaign belongs to a different client");
    expect(await refused("select create_booking_link_v6($1,'sales',$2,$3)",
      [CLIENT, "a".repeat(64), OTHER_CAMPAIGN]))
      .toContain("campaign belongs to a different client");
    await actor("other_client");
    await expectAllPrivateCallsDenied();
    await actor("admin");
    await expectAllPrivateCallsAllowed();
    await actor("service");
    await expectAllPrivateCallsAllowed();
    expect(await refused("select book_appointment_v6($1,now(),'sales_agent')", [LEAD]))
      .toContain("not taking bookings");
  });
});
