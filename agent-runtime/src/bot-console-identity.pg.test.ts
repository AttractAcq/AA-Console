import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const EMPLOYEE = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";

const migration = () =>
  readFile(new URL("../../supabase/migrations/20261115190000_324_bot_console_identity.sql", import.meta.url), "utf8");

function section(sql: string, name: string): string {
  const start = sql.indexOf(`-- <<${name}>>`);
  const end = sql.indexOf(`-- <<end ${name}>>`);
  if (start < 0 || end < start) throw new Error(`Missing migration section ${name}`);
  return sql.slice(start, end);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function applyCreatingMissingTypes(sql: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await db.exec(sql);
      return;
    } catch (error) {
      const message = messageOf(error);
      const type = /type "([^"]+)" does not exist/i.exec(message);
      if (!type) throw error;
      const raw = type[1]!.replace(/^public\./, "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) throw error;
      await db.exec(`create table if not exists public.${raw} (id uuid);`);
    }
  }
  throw new Error("Could not create the hard-hold functions");
}

async function asUser(id: string, aal = "aal2") {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ aal, role: "authenticated", sub: id }),
  ]);
  await db.exec("set role authenticated");
}

async function asService() {
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
  await db.query("select set_config('request.jwt.claim.role', 'service_role', false)");
  await db.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false)");
  await db.exec("reset role");
}

async function callReady(id: string, sql: string, params: unknown[] = []): Promise<string | null> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await asUser(id, "aal2");
    const error = await call(sql, params);
    const missing = /(?:type|relation) "(?:public\.)?([^"]+)" does not exist/i.exec(error ?? "");
    if (!missing) return error;
    const raw = missing[1]!.split(".").pop() ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return error;
    await db.exec("reset role");
    await db.exec(`create table if not exists public.${raw} (id uuid primary key);`);
  }
  return "stub loop exhausted";
}

async function call(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return messageOf(error);
  } finally {
    await db.exec("reset role");
  }
}

const calls: Array<[string, string, unknown[]]> = [
  ["admin_store_integration_credential",
    "select public.admin_store_integration_credential($1,'meta','main','secret',null)", [CLIENT]],
  ["set_engine_enabled", "select public.set_engine_enabled($1, false)", [CLIENT]],
  ["set_engine_running", "select public.set_engine_running(false, null)", []],
  ["set_publishing_enabled", "select public.set_publishing_enabled($1, false)", [CLIENT]],
  ["set_proof_publishing_enabled", "select public.set_proof_publishing_enabled($1, false)", [CLIENT]],
  ["set_campaign_actions_enabled", "select public.set_campaign_actions_enabled($1, false)", [CLIENT]],
  ["set_lead_capture_enabled_v6", "select public.set_lead_capture_enabled_v6($1, false)", [CLIENT]],
  ["set_lead_magnet_delivery_enabled", "select public.set_lead_magnet_delivery_enabled($1, false)", [CLIENT]],
  ["set_outbound_messaging_enabled", "select public.set_outbound_messaging_enabled($1, false)", [CLIENT]],
  ["set_client_booking_enabled_v6", "select public.set_client_booking_enabled_v6($1, false)", [CLIENT]],
  ["set_client_engine_budget_v6", "select public.set_client_engine_budget_v6($1, current_date, null, null)", [CLIENT]],
  ["delete_recruitment_ad", "select * from public.delete_recruitment_ad($1)", [CLIENT]],
  ["delete_client_idea", "select * from public.delete_client_idea($1)", [CLIENT]],
  ["delete_client_campaign", "select * from public.delete_client_campaign($1)", [CLIENT]],
  ["delete_content_asset_v6", "select * from public.delete_content_asset_v6($1)", [CLIENT]],
  ["delete_content_brief_v6", "select * from public.delete_content_brief_v6($1)", [CLIENT]],
  ["request_client_sales_entitlement",
    "select public.request_client_sales_entitlement($1,$1,'grant')", [CLIENT]],
  ["decide_client_sales_entitlement",
    "select public.decide_client_sales_entitlement($1,'hash',true,null)", [CLIENT]],
];

const approvalCalls: Array<[string, string, unknown[]]> = [
  ["record_approval_decision_v6",
    "select public.record_approval_decision_v6($1,'approved','hash','ref',null)", [CLIENT]],
  ["approve_recruitment_brief", "select public.approve_recruitment_brief($1)", [CLIENT]],
  ["approve_recruitment_brief_from_inbox_v6",
    "select public.approve_recruitment_brief_from_inbox_v6($1,$1,'version','hash')", [CLIENT]],
  ["decide_google_review_reply_v6", "select public.decide_google_review_reply_v6($1,true,null)", [CLIENT]],
  ["decide_google_review_reply_from_inbox_v6",
    "select public.decide_google_review_reply_from_inbox_v6($1,'version','hash',true,null)", [CLIENT]],
  ["record_console_auth_sender_verification_v6",
    "select public.record_console_auth_sender_verification_v6('sender@attractacq.com','https://project.supabase.co','https://console.attractacq.com','Subject','Body','evidence','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')", []],
  ["decide_console_invitation_v6",
    "select public.decide_console_invitation_v6($1,'version','hash',true,null)", [CLIENT]],
  ["cancel_console_invitation_v6", "select public.cancel_console_invitation_v6($1,'cancelled')", [CLIENT]],
  ["resolve_console_invitation_uncertain_v6",
    "select public.resolve_console_invitation_uncertain_v6($1,'hash','evidence','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','no send')", [CLIENT]],
  ["submit_production_release_candidate_v6",
    "select public.submit_production_release_candidate_v6('{}'::jsonb, now() + interval '1 hour')", []],
  ["decide_production_release_candidate_v6",
    "select public.decide_production_release_candidate_v6($1,'version','artifact','packet','rejected','no')", [CLIENT]],
  ["decide_campaign_action_approval_v6",
    "select public.decide_campaign_action_approval_v6($1,'rejected','no')", [CLIENT]],
  ["decide_proof_placement_approval_v6",
    "select public.decide_proof_placement_approval_v6($1,false,'no')", [CLIENT]],
  ["decide_lead_magnet_approval_v6",
    "select public.decide_lead_magnet_approval_v6($1,false,'no')", [CLIENT]],
];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text unique,
      raw_app_meta_data jsonb,
      raw_user_meta_data jsonb
    );
    create table auth.sessions (
      id uuid primary key,
      user_id uuid not null
    );
    create table auth.refresh_tokens (
      id bigint generated always as identity primary key,
      user_id text,
      session_id uuid
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '')
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select nullif(current_setting('request.jwt.claims', true), '')::jsonb
    $$;
    create type public.app_role as enum ('admin', 'employee', 'client');
    create type public.team_category as enum ('avatars', 'editors', 'smm');
    create table public.profiles (
      id uuid primary key references auth.users(id) on delete cascade,
      role public.app_role not null default 'employee',
      full_name text,
      email text,
      employee_category public.team_category,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create function public.is_admin() returns boolean
    language sql stable security definer set search_path = public as $$
      select coalesce((select role = 'admin'::public.app_role from public.profiles where id = auth.uid()), false)
    $$;
    create function public.can_access_client(target uuid) returns boolean
    language sql stable security definer set search_path = public as $$
      select public.is_admin()
    $$;
    create function public.active_video_approval_manager(target uuid) returns uuid
    language sql stable as $$ select null::uuid $$;
  `);

  const sql = await migration();
  await db.exec(section(sql, "bot-identity"));

  await db.exec(`
    insert into auth.users (id, email) values
      ('${HUMAN}', 'alex-test@attractacq.com'),
      ('${BOT}', 'bot-cos@attractacq.com'),
      ('${EMPLOYEE}', 'employee-test@attractacq.com');
  `);
  await asService();
  await db.query(
    `insert into public.profiles (id, role, full_name, email, is_bot, bot_key)
     values ($1, 'admin', 'Alex Test', 'alex-test@attractacq.com', false, null)`,
    [HUMAN],
  );
  await db.query(
    `insert into public.profiles (id, role, full_name, email, is_bot, bot_key)
     values ($1, 'admin', 'Chief of Staff', 'bot-cos@attractacq.com', true, 'bot-cos')`,
    [BOT],
  );
  await db.query(
    `insert into public.profiles (id, role, full_name, email, is_bot, bot_key)
     values ($1, 'employee', 'Employee', 'employee-test@attractacq.com', false, null)`,
    [EMPLOYEE],
  );
  await db.exec("reset role");

  // The real migration runs after every referenced table exists. This harness
  // only needs the auth gate, which is the first statement in each function.
  await db.exec("set check_function_bodies = off");
  await applyCreatingMissingTypes(section(sql, "hard-hold-rpcs"));
  await db.exec(`
    create table if not exists public.lead_magnet_approvals (
      id uuid primary key,
      client_id uuid,
      magnet_version_id uuid,
      payload_hash text,
      scope jsonb,
      status text,
      requested_at timestamptz,
      requested_by uuid,
      decided_at timestamptz,
      decided_by uuid,
      decided_by_bot boolean not null default false,
      rejection_reason text,
      revoked_at timestamptz,
      revoked_reason text
    );
  `);
  await applyCreatingMissingTypes(section(sql, "approval-decisions"));
  await db.exec(`
    do $$ begin
      create type public.review_status as enum ('pending', 'approved', 'rejected');
    exception when duplicate_object then null;
    end $$;
    do $$ begin
      create type public.post_channel as enum ('organic', 'paid');
    exception when duplicate_object then null;
    end $$;
    do $$ begin
      create type public.post_platform as enum ('facebook', 'instagram', 'tiktok', 'linkedin', 'youtube');
    exception when duplicate_object then null;
    end $$;
    create table if not exists public.client_media_assets (
      id uuid primary key,
      client_id uuid,
      brief_id uuid,
      media_type text,
      review_status public.review_status,
      human_approved_at timestamptz,
      bot_reviewed_at timestamptz,
      edit_stage text,
      content_format text,
      render_path text,
      storage_path text
    );
    create table if not exists public.client_engine_settings (
      id uuid primary key default gen_random_uuid()
    );
    alter table public.client_engine_settings
      add column if not exists client_id uuid;
    alter table public.client_engine_settings
      add column if not exists creative_director_required boolean;
    alter table public.client_engine_settings
      add column if not exists lead_magnet_delivery_enabled boolean;
    create unique index if not exists client_engine_settings_client_idx
      on public.client_engine_settings (client_id);
    create table if not exists public.lead_magnets (
      id uuid primary key,
      name text
    );
    create table if not exists public.lead_magnet_versions (
      id uuid primary key,
      magnet_id uuid,
      storage_path text,
      media_type text,
      content_sha256 text,
      delivery_subject text,
      delivery_body text
    );
    create table if not exists public.lead_magnet_deliveries (
      id uuid primary key,
      client_id uuid,
      submission_id uuid,
      lead_id uuid,
      magnet_version_id uuid,
      channel text,
      recipient text,
      status text,
      attempts integer default 0,
      provider_ref text,
      last_error text,
      claimed_at timestamptz,
      lease_until timestamptz,
      created_at timestamptz default now()
    );
    create or replace function public.lead_magnet_payload_hash_v6(p_version_id uuid)
    returns text language sql stable as $$
      select 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text
    $$;
    create or replace function public.active_creative_director(p_client_id uuid)
    returns uuid language sql stable as $$ select null::uuid $$;
    create or replace function public.active_video_approval_manager(target uuid)
    returns uuid language sql stable as $$ select null::uuid $$;
  `);
  await applyCreatingMissingTypes(section(sql, "security-review-preambles"));
  await db.exec("set check_function_bodies = on");
  await db.exec(`
    create table if not exists public.approval_requests_v6 (
      id uuid primary key,
      source_kind text,
      client_id uuid
    );
  `);
  // %rowtype variables are resolved before the function body, so the auth
  // gate is only reached once those tables exist.
  for (const table of [
    "client_briefs", "client_ideas", "client_campaigns", "client_media_assets",
    "client_sales_entitlement_requests",
  ]) {
    await db.exec(`create table if not exists public.${table} (id uuid primary key);`);
  }

  for (const table of [
    "client_billing", "finance_entries", "sops", "client_integrations", "engine_controls",
    "proof_capture_configs", "client_proof_destinations", "client_google_locations", "motion_scenes",
    "service_offers",
  ]) {
    await db.exec(`
      create table if not exists public.${table} (id uuid primary key default gen_random_uuid());
      alter table public.${table} enable row level security;
      grant select, insert, update, delete on public.${table} to authenticated;
    `);
  }
  await db.exec(`
    alter table public.profiles enable row level security;
    grant select, insert, delete on public.profiles to authenticated;
    drop policy if exists profiles_self_read on public.profiles;
    create policy profiles_self_read on public.profiles
      for select to authenticated using (id = auth.uid() or public.is_admin());
    drop policy if exists profiles_self_update on public.profiles;
    create policy profiles_self_update on public.profiles
      for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
  `);
  const rls = section(sql, "rls-split");
  await db.exec(`
    create schema if not exists storage;
    grant usage on schema storage to authenticated;
    create or replace function storage.foldername(p text) returns text[]
      language sql immutable as $$ select string_to_array(coalesce(p, ''), '/') $$;
    create or replace function public.try_uuid(p text) returns uuid
      language sql immutable as $$
        select case
          when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then p::uuid else null end
      $$;
    create table if not exists storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text
    );
    alter table storage.objects enable row level security;
    grant select, insert, update, delete on storage.objects to authenticated;
    alter table public.proof_capture_configs add column if not exists client_id uuid;
    alter table public.client_proof_destinations add column if not exists client_id uuid;
    alter table public.client_google_locations add column if not exists client_id uuid;
    alter table public.motion_scenes add column if not exists client_id uuid;
    alter table public.service_offers add column if not exists client_id uuid;
  `);
  const wanted = [
    "profiles", "client_billing", "finance_entries", "sops", "client_integrations", "engine_controls",
    "proof_capture_configs", "client_proof_destinations", "client_google_locations", "motion_scenes",
    "storage.objects", "service_offers",
  ];
  const statements = rls.split(/;\s*\n/).map((part) => part.trim()).filter(Boolean);
  for (const statement of statements) {
    if (wanted.some((table) => statement.includes(table.includes(".") ? table : `public.${table}`))) {
      await db.exec(`${statement};`);
    }
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("bot console identity", () => {
  it("treats a human admin as human and a bot admin as an admin who is not human", async () => {
    await asUser(HUMAN);
    const human = await db.query<{ is_admin: boolean; is_human_admin: boolean }>(
      "select public.is_admin() as is_admin, public.is_human_admin() as is_human_admin",
    );
    await asUser(BOT, "aal2");
    const bot = await db.query<{ is_admin: boolean; is_human_admin: boolean }>(
      "select public.is_admin() as is_admin, public.is_human_admin() as is_human_admin",
    );
    await asUser(EMPLOYEE);
    const employee = await db.query<{ is_admin: boolean; is_human_admin: boolean }>(
      "select public.is_admin() as is_admin, public.is_human_admin() as is_human_admin",
    );
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    const anon = await db.query<{ is_admin: boolean; is_human_admin: boolean }>(
      "select public.is_admin() as is_admin, public.is_human_admin() as is_human_admin",
    );
    expect(human.rows[0]).toEqual({ is_admin: true, is_human_admin: true });
    expect(bot.rows[0]).toEqual({ is_admin: true, is_human_admin: false });
    expect(employee.rows[0]).toEqual({ is_admin: false, is_human_admin: false });
    expect(anon.rows[0]).toEqual({ is_admin: false, is_human_admin: false });
  });

  it("mirrors bot identity into raw_app_meta_data and leaves the human unset", async () => {
    const rows = await db.query<{ id: string; is_bot: string | null; bot_key: string | null }>(
      `select id::text, raw_app_meta_data->>'is_bot' as is_bot, raw_app_meta_data->>'bot_key' as bot_key
         from auth.users where id in ($1, $2) order by id`,
      [HUMAN, BOT],
    );
    expect(rows.rows).toEqual([
      { id: HUMAN, is_bot: "false", bot_key: null },
      { id: BOT, is_bot: "true", bot_key: "bot-cos" },
    ]);
  });

  it("refuses a bot or a human admin changing is_bot, and allows service_role", async () => {
    // Table owner bypasses column privileges, so this is the trigger itself.
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [BOT]);
    await db.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
    const botFlip = await call("update public.profiles set is_bot = false where id = $1", [BOT]);
    expect(botFlip).toMatch(/only service_role may change bot identity/);

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [HUMAN]);
    await db.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
    const humanFlip = await call(
      "update public.profiles set is_bot = true, bot_key = 'bot-finance' where id = $1",
      [BOT],
    );
    expect(humanFlip).toMatch(/only service_role may change bot identity/);

    await asUser(BOT);
    const sessionFlip = await call("update public.profiles set is_bot = false where id = $1", [BOT]);
    expect(sessionFlip ?? "").toMatch(/only service_role may change bot identity|permission denied/i);

    await asService();
    await db.query(
      "update public.profiles set full_name = 'Chief of Staff' where id = $1",
      [BOT],
    );
    const stillBot = await db.query<{ is_bot: boolean; bot_key: string }>(
      "select is_bot, bot_key from public.profiles where id = $1",
      [BOT],
    );
    expect(stillBot.rows[0]).toEqual({ is_bot: true, bot_key: "bot-cos" });
  });

  it.each(calls)("%s denies a bot admin and does not fail the human admin auth check", async (_name, sql, params) => {
    await asUser(BOT, "aal2");
    const botError = await call(sql, params);
    expect(botError).toMatch(/Bot accounts cannot perform this action/);

    await asUser(HUMAN, "aal2");
    const humanError = await call(sql, params);
    expect(humanError ?? "").not.toMatch(/Bot accounts cannot perform this action/);
    expect(humanError ?? "").not.toMatch(/Admins only|Only an admin|Only an administrator/);
  });

  it("lets a bot admin read a split table and refuses the write", async () => {
    await db.exec("reset role");
    const seeded = await db.query<{ id: string }>(
      "insert into public.client_billing (id) values (gen_random_uuid()) returning id",
    );
    const id = seeded.rows[0]!.id;

    await asUser(BOT);
    const visible = await db.query<{ id: string }>("select id::text from public.client_billing");
    expect(visible.rows.map((row) => row.id)).toContain(id);
    const inserted = await call("insert into public.client_billing (id) values (gen_random_uuid())");
    expect(inserted).toMatch(/row-level security/i);
    await asUser(BOT);
    const updated = await db.query(
      "update public.client_billing set id = id where id = $1 returning id",
      [id],
    );
    expect(updated.rows).toHaveLength(0);
    await db.exec("reset role");
    const deleted = await (async () => {
      await asUser(BOT);
      const result = await db.query("delete from public.client_billing where id = $1 returning id", [id]);
      await db.exec("reset role");
      return result.rows;
    })();
    expect(deleted).toHaveLength(0);
    const remains = await db.query("select id from public.client_billing where id = $1", [id]);
    expect(remains.rows).toHaveLength(1);

    await asUser(HUMAN);
    const humanInsert = await call(
      "insert into public.finance_entries (id) values ('55555555-5555-4555-8555-555555555555')",
    );
    expect(humanInsert).toBeNull();
    await asUser(EMPLOYEE);
    const employeeInsert = await call(
      "insert into public.sops (id) values ('66666666-6666-4666-8666-666666666666')",
    );
    expect(employeeInsert).toMatch(/row-level security/i);
  });

  it.each(approvalCalls)("%s denies a bot before AAL2 and lets a human admin past that check", async (_name, sql, params) => {
    const botError = await callReady(BOT, sql, params);
    expect(botError).toMatch(/Bot accounts cannot perform this action/);
    const humanError = await callReady(HUMAN, sql, params);
    expect(humanError ?? "").not.toMatch(/Bot accounts cannot perform this action/);
    expect(humanError ?? "").not.toMatch(/AAL2|Admins only|Only an admin|Only an administrator/);
  });

  it("denies bot writes on admin-or-manager tables while a real manager can still write", async () => {
    await asUser(BOT);
    const botWrite = await call(
      "insert into public.motion_scenes (id, client_id) values ('77777777-7777-4777-8777-777777777777', $1)",
      [CLIENT],
    );
    expect(botWrite).toMatch(/row-level security/i);

    await asUser(HUMAN);
    const humanWrite = await call(
      "insert into public.client_google_locations (id, client_id) values ('88888888-8888-4888-8888-888888888888', $1)",
      [CLIENT],
    );
    expect(humanWrite).toBeNull();

    await asUser(EMPLOYEE);
    const employeeWrite = await call(
      "insert into public.proof_capture_configs (id, client_id) values ('99999999-9999-4999-8999-999999999999', $1)",
      [CLIENT],
    );
    expect(employeeWrite).toMatch(/row-level security/i);

    await db.exec("reset role");
    await db.exec(`create or replace function public.active_video_approval_manager(target uuid)
      returns uuid language sql stable as $$ select '${EMPLOYEE}'::uuid $$`);
    await asUser(EMPLOYEE);
    const managerWrite = await call(
      "insert into public.client_proof_destinations (id, client_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $1)",
      [CLIENT],
    );
    expect(managerWrite).toBeNull();
  });

  it("lets a bot admin read storage and refuses admin-gated bucket writes", async () => {
    await db.exec("reset role");
    for (const bucket of ["sops", "contracts", "client-media", "proof"]) {
      await db.query(
        "insert into storage.objects (id, bucket_id, name) values (gen_random_uuid(), $1, 'existing')",
        [bucket],
      );
      await asUser(BOT);
      const visible = await db.query<{ bucket_id: string }>(
        "select bucket_id from storage.objects where bucket_id = $1",
        [bucket],
      );
      expect(visible.rows.map((row) => row.bucket_id)).toContain(bucket);
      const inserted = await call(
        "insert into storage.objects (id, bucket_id, name) values (gen_random_uuid(), $1, 'bot-write')",
        [bucket],
      );
      expect(inserted, bucket).toMatch(/row-level security/i);
    }
    await asUser(HUMAN);
    const humanWrite = await call(
      "insert into storage.objects (id, bucket_id, name) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'proof', 'human-write')",
    );
    expect(humanWrite).toBeNull();
  });

  it("allowlists content approval for bot-production and refuses every other bot", async () => {
    const production = "77777777-7777-4777-8777-777777777771";
    const sales = "77777777-7777-4777-8777-777777777772";
    const marketing = "77777777-7777-4777-8777-777777777773";
    await db.exec("reset role");
    await asService();
    for (const [id, key, email] of [
      [production, "bot-production", "production@attractacq.com"],
      [sales, "bot-sales", "sales@attractacq.com"],
      [marketing, "bot-marketing", "marketing@attractacq.com"],
    ] as const) {
      await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
      await db.query(
        `insert into public.profiles (id, role, full_name, email, is_bot, bot_key)
         values ($1, 'admin', $2, $3, true, $2)`,
        [id, key, email],
      );
    }
    await db.exec("reset role");

    const content: Array<[string, string, unknown[]]> = [
      ["review_media_asset", "select public.review_media_asset($1, 'approved', null)", [CLIENT]],
      ["approve_idea_and_generate_brief", "select public.approve_idea_and_generate_brief($1)", [CLIENT]],
      ["approve_campaign_plan_v6", "select public.approve_campaign_plan_v6($1, null)", [CLIENT]],
    ];
    for (const [name, sql, params] of content) {
      const allowed = await callReady(production, sql, params);
      expect(allowed ?? "", name).not.toMatch(/Bot accounts cannot perform this action/);
      const denied = await callReady(marketing, sql, params);
      expect(denied, name).toMatch(/Bot accounts cannot perform this action/);
    }
    const productionSlot = await callReady(production, "select public.approve_slot($1, null)", [CLIENT]);
    expect(productionSlot).toMatch(/Bot accounts cannot perform this action/);
    const marketingSlot = await callReady(marketing, "select public.approve_slot($1, null)", [CLIENT]);
    expect(marketingSlot).toMatch(/Bot accounts cannot perform this action/);
    const proofArtifact = await callReady(production, "select public.approve_proof_artifact_v6($1)", [CLIENT]);
    expect(proofArtifact).toMatch(/Bot accounts cannot perform this action/);
    const releaseSubmit = await callReady(
      production,
      "select public.submit_production_release_candidate_v6('{}'::jsonb, now() + interval '1 hour')",
      [],
    );
    expect(releaseSubmit).toMatch(/Bot accounts cannot perform this action/);
    const humanAsset = await callReady(HUMAN, content[0]![1], content[0]![2]);
    expect(humanAsset ?? "").not.toMatch(/Bot accounts cannot perform this action/);

    const publish = await callReady(
      production,
      "select public.set_publishing_enabled($1, false)",
      [CLIENT],
    );
    expect(publish).toMatch(/Bot accounts cannot perform this action/);

    const salesAsset = await callReady(sales, content[0]![1], content[0]![2]);
    expect(salesAsset).toMatch(/Bot accounts cannot perform this action/);

    const queued = await callReady(production, "select public.enqueue_agent_job('brief', $1)", [CLIENT]);
    expect(queued ?? "").not.toMatch(/Bot accounts cannot perform this action/);
    const publisher = await callReady(production, "select public.enqueue_agent_job('publisher', $1)", [CLIENT]);
    expect(publisher).toMatch(/Bot accounts cannot perform this action/);
    const upload = await callReady(
      production,
      "insert into storage.objects (id, bucket_id, name) values (gen_random_uuid(), 'client-media', $1 || '/bot.bin')",
      [CLIENT],
    );
    expect(upload).toMatch(/row-level security/i);
    const humanUpload = await callReady(
      HUMAN,
      "insert into storage.objects (id, bucket_id, name) values (gen_random_uuid(), 'client-media', $1 || '/human.bin')",
      [CLIENT],
    );
    expect(humanUpload).toBeNull();

    await db.exec("reset role");
    await asUser(HUMAN);
    const truncated = await call("truncate table public.profiles");
    expect(truncated ?? "").toMatch(/permission denied/i);

    await db.exec("reset role");
    await db.query(
      `insert into public.approval_requests_v6 (id, source_kind)
       values ('12121212-1212-4121-8121-121212121212', 'production_release')
       on conflict (id) do update set source_kind = excluded.source_kind`,
    );
    const releaseDecision = await callReady(
      production,
      "select public.record_approval_decision_v6($1,'rejected','hash','ref','no')",
      ["12121212-1212-4121-8121-121212121212"],
    );
    expect(releaseDecision).toMatch(/Bot accounts cannot perform this action/);
    const marketingRelease = await callReady(
      marketing,
      "select public.record_approval_decision_v6($1,'rejected','hash','ref','no')",
      ["12121212-1212-4121-8121-121212121212"],
    );
    expect(marketingRelease).toMatch(/Bot accounts cannot perform this action/);
  });

  it("keeps a bot review off the publisher until a human schedules it", async () => {
    const production = "77777777-7777-4777-8777-777777777771";
    const campaign = "b1111111-1111-4111-8111-111111111111";
    const idea = "b2222222-2222-4222-8222-222222222222";
    const brief = "b3333333-3333-4333-8333-333333333333";
    const botAsset = "b4444444-4444-4444-8444-444444444441";
    const humanAsset = "b4444444-4444-4444-8444-444444444442";
    const bareAsset = "b4444444-4444-4444-8444-444444444443";
    await db.exec("reset role");
    await asService();
    await db.query(
      `insert into auth.users (id, email) values ($1, 'production@attractacq.com')
       on conflict (id) do nothing`,
      [production],
    );
    await db.query(
      `insert into public.profiles (id, role, full_name, email, is_bot, bot_key)
       values ($1, 'admin', 'bot-production', 'production@attractacq.com', true, 'bot-production')
       on conflict (id) do nothing`,
      [production],
    );
    await db.exec("reset role");
    await db.exec(`
      alter table public.client_briefs add column if not exists client_id uuid;
      alter table public.client_briefs add column if not exists source_idea_id uuid;
      alter table public.client_ideas add column if not exists client_id uuid;
      alter table public.client_ideas add column if not exists campaign_id uuid;
      alter table public.client_campaigns add column if not exists client_id uuid;
      alter table public.client_campaigns add column if not exists acquisition_mode text;
      alter table public.client_campaigns add column if not exists paid_platform text;
      create table if not exists public.client_engine_settings (
        id uuid primary key default gen_random_uuid()
      );
      alter table public.client_engine_settings
        add column if not exists client_id uuid;
      alter table public.client_engine_settings
        add column if not exists creative_director_required boolean;
      create table if not exists public.client_asset_reviews (
        id uuid primary key default gen_random_uuid(),
        asset_id uuid,
        decision text,
        reason text,
        reviewed_by uuid,
        decided_in_seat text
      );
      create table if not exists public.scheduled_posts (
        id uuid primary key default gen_random_uuid(),
        asset_id uuid,
        client_id uuid,
        scheduled_for date,
        scheduled_at timestamptz,
        channel public.post_channel,
        platform public.post_platform,
        created_by uuid
      );
      create or replace function public.creative_seat_of(p_client_id uuid, p_user_id uuid)
        returns text language sql stable as $$ select 'admin'::text $$;
      create or replace function public.client_timezone(p_client_id uuid)
        returns text language sql stable as $$ select 'UTC'::text $$;
    `);
    await db.query(
      `insert into public.client_campaigns (id, client_id, acquisition_mode, paid_platform)
       values ($1, $2, 'organic', null)`,
      [campaign, CLIENT],
    );
    await db.query(
      `insert into public.client_ideas (id, client_id, campaign_id) values ($1, $2, $3)`,
      [idea, CLIENT, campaign],
    );
    await db.query(
      `insert into public.client_briefs (id, client_id, source_idea_id) values ($1, $2, $3)`,
      [brief, CLIENT, idea],
    );
    await db.query(
      `insert into public.client_media_assets
         (id, client_id, brief_id, media_type, review_status, edit_stage, content_format, storage_path)
       values
         ($1, $4, $5, 'image', 'pending', 'review_ready', 'single', 'bot.jpg'),
         ($2, $4, $5, 'image', 'pending', 'review_ready', 'single', 'human.jpg'),
         ($3, $4, $5, 'image', 'approved', 'review_ready', 'single', 'bare.jpg')`,
      [botAsset, humanAsset, bareAsset, CLIENT, brief],
    );

    await asUser(production);
    expect(await call("select public.review_media_asset($1, 'approved', null)", [botAsset])).toBeNull();
    await db.exec("reset role");
    const botReview = await db.query<{ human_approved_at: string | null; bot_reviewed_at: string | null }>(
      "select human_approved_at::text, bot_reviewed_at::text from public.client_media_assets where id = $1",
      [botAsset],
    );
    expect(botReview.rows[0]?.human_approved_at).toBeNull();
    expect(botReview.rows[0]?.bot_reviewed_at).not.toBeNull();

    await asUser(production);
    const botSchedule = await call(
      "select public.schedule_asset($1, current_date, 'organic', null, '09:00')",
      [botAsset],
    );
    expect(botSchedule).toMatch(/Bot accounts cannot perform this action/);
    await db.exec("reset role");
    const beforeHuman = await db.query<{ posts: string; stamped: string | null }>(
      `select (select count(*) from public.scheduled_posts where asset_id = $1)::text as posts,
              human_approved_at::text as stamped
         from public.client_media_assets where id = $1`,
      [botAsset],
    );
    expect(beforeHuman.rows[0]).toEqual({ posts: "0", stamped: null });

    await asUser(HUMAN);
    expect(await call(
      "select public.schedule_asset($1, current_date, 'organic', null, '09:00')",
      [botAsset],
    )).toBeNull();
    await db.exec("reset role");
    const published = await db.query<{ stamped: string | null; created_by: string }>(
      `select a.human_approved_at::text as stamped, sp.created_by::text as created_by
         from public.client_media_assets a
         join public.scheduled_posts sp on sp.asset_id = a.id
        where a.id = $1`,
      [botAsset],
    );
    expect(published.rows[0]?.stamped).not.toBeNull();
    expect(published.rows[0]?.created_by).toBe(HUMAN);
    const actor = await db.query<{
      decision: string; reviewed_by: string; decided_in_seat: string; reason: string;
    }>(
      `select decision::text, reviewed_by::text, decided_in_seat, reason
         from public.client_asset_reviews
        where asset_id = $1
          and reason = 'Approved by scheduling a bot-reviewed asset'`,
      [botAsset],
    );
    expect(actor.rows[0]).toEqual({
      decision: "approved",
      reviewed_by: HUMAN,
      decided_in_seat: "admin",
      reason: "Approved by scheduling a bot-reviewed asset",
    });

    await asUser(HUMAN);
    expect(await call("select public.review_media_asset($1, 'approved', null)", [humanAsset])).toBeNull();
    await db.exec("reset role");
    const humanReview = await db.query<{ human_approved_at: string; bot_reviewed_at: string | null }>(
      "select human_approved_at::text, bot_reviewed_at::text from public.client_media_assets where id = $1",
      [humanAsset],
    );
    expect(humanReview.rows[0]?.human_approved_at).not.toBeNull();
    expect(humanReview.rows[0]?.bot_reviewed_at).toBeNull();
    const stamp = humanReview.rows[0]!.human_approved_at;
    await asUser(HUMAN);
    expect(await call(
      "select public.schedule_asset($1, current_date, 'organic', null, '09:00')",
      [humanAsset],
    )).toBeNull();
    await db.exec("reset role");
    const still = await db.query<{ human_approved_at: string }>(
      "select human_approved_at::text from public.client_media_assets where id = $1",
      [humanAsset],
    );
    expect(still.rows[0]?.human_approved_at).toBe(stamp);

    await asUser(HUMAN);
    const bare = await call(
      "select public.schedule_asset($1, current_date, 'organic', null, '09:00')",
      [bareAsset],
    );
    expect(bare).toMatch(/not been approved by a person/);

    await asUser(production);
    expect(await call("select public.review_media_asset($1, 'rejected', 'reopen')", [humanAsset])).toBeNull();
    await db.exec("reset role");
    const cleared = await db.query<{ human_approved_at: string | null }>(
      "select human_approved_at::text from public.client_media_assets where id = $1",
      [humanAsset],
    );
    expect(cleared.rows[0]?.human_approved_at).toBeNull();

    const clientUser = "d1111111-1111-4111-8111-111111111111";
    const director = "d2222222-2222-4222-8222-222222222222";
    const clientAsset = "d3333333-3333-4333-8333-333333333331";
    const seatAsset = "d3333333-3333-4333-8333-333333333332";
    const smmAsset = "d3333333-3333-4333-8333-333333333333";
    await asService();
    await db.query(
      `insert into auth.users (id, email) values
         ($1, 'client-324@attractacq.com'),
         ($2, 'director-324@attractacq.com')
       on conflict (id) do nothing`,
      [clientUser, director],
    );
    await db.query(
      `insert into public.profiles (id, role, full_name, email, is_bot, bot_key) values
         ($1, 'client', 'Client', 'client-324@attractacq.com', false, null),
         ($2, 'employee', 'Director', 'director-324@attractacq.com', false, null)
       on conflict (id) do nothing`,
      [clientUser, director],
    );
    await db.query(
      `insert into public.client_media_assets
         (id, client_id, brief_id, media_type, review_status, edit_stage, content_format,
          storage_path, bot_reviewed_at)
       values
         ($1, $4, $5, 'image', 'approved', 'review_ready', 'single', 'client.jpg', now()),
         ($2, $4, $5, 'image', 'approved', 'review_ready', 'single', 'seat.jpg', now()),
         ($3, $4, $5, 'image', 'approved', 'review_ready', 'single', 'smm.jpg', now())`,
      [clientAsset, seatAsset, smmAsset, CLIENT, brief],
    );
    await db.exec(`
      create or replace function public.can_access_client(target uuid)
      returns boolean language sql stable security definer set search_path = public as $$
        select true
      $$;
    `);
    await db.exec("reset role");

    await asUser(clientUser);
    const clientSchedule = await call(
      "select public.schedule_asset($1, current_date, 'organic', null, '09:00')",
      [clientAsset],
    );
    expect(clientSchedule).toMatch(/42501|Only a human admin, the creative director, or the active SMM/);
    expect(clientSchedule).toMatch(/Only a human admin, the creative director, or the active SMM/);

    await db.exec("reset role");
    await db.query(
      `insert into public.client_engine_settings (client_id, creative_director_required)
       values ($1, true)
       on conflict (client_id) do update set creative_director_required = true`,
      [CLIENT],
    );
    await db.exec(`
      create or replace function public.active_creative_director(p_client_id uuid)
      returns uuid language sql stable as $$ select '${director}'::uuid $$;
      create or replace function public.active_video_approval_manager(target uuid)
      returns uuid language sql stable as $$ select '${EMPLOYEE}'::uuid $$;
    `);

    await asUser(production);
    const botSeat = await call("select public.review_media_asset($1, 'approved', null)", [seatAsset]);
    expect(botSeat).toMatch(/Only the assigned creative director or an admin/);

    await asUser(EMPLOYEE);
    const smmSchedule = await call(
      "select public.schedule_asset($1, current_date, 'organic', null, '09:00')",
      [smmAsset],
    );
    expect(smmSchedule).toMatch(/Only the assigned creative director or an admin/);

    await db.exec("reset role");
    await db.exec(`
      create or replace function public.can_access_client(target uuid)
      returns boolean language sql stable security definer set search_path = public as $$
        select public.is_admin()
      $$;
      create or replace function public.active_creative_director(p_client_id uuid)
      returns uuid language sql stable as $$ select null::uuid $$;
      create or replace function public.active_video_approval_manager(target uuid)
      returns uuid language sql stable as $$ select null::uuid $$;
    `);
  });

  it("lets bot-sales decide a pending lead magnet and refuses every other bot", async () => {
    const production = "77777777-7777-4777-8777-777777777771";
    const sales = "77777777-7777-4777-8777-777777777772";
    const marketing = "77777777-7777-4777-8777-777777777773";
    const salesApproval = "c1111111-1111-4111-8111-111111111111";
    const humanApproval = "c2222222-2222-4222-8222-222222222222";
    const hash = "a".repeat(64);
    await db.exec("reset role");
    await asService();
    for (const [id, key, email] of [
      [production, "bot-production", "production@attractacq.com"],
      [sales, "bot-sales", "sales@attractacq.com"],
      [marketing, "bot-marketing", "marketing@attractacq.com"],
    ] as const) {
      await db.query(
        "insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing",
        [id, email],
      );
      await db.query(
        `insert into public.profiles (id, role, full_name, email, is_bot, bot_key)
         values ($1, 'admin', $2, $3, true, $2)
         on conflict (id) do nothing`,
        [id, key, email],
      );
    }
    await db.exec("reset role");
    await db.exec(`
      create or replace function public.lead_magnet_payload_hash_v6(p_version_id uuid)
      returns text language sql stable as $$
        select '${hash}'::text
      $$;
    `);
    await db.query(
      `insert into public.lead_magnet_approvals
         (id, client_id, magnet_version_id, payload_hash, status)
       values
         ($1, $3, $1, $4, 'pending'),
         ($2, $3, $2, $4, 'pending')`,
      [salesApproval, humanApproval, CLIENT, hash],
    );

    await asUser(production);
    expect(await call(
      "select public.decide_lead_magnet_approval_v6($1, true, null)",
      [salesApproval],
    )).toMatch(/Bot accounts cannot perform this action/);
    await asUser(marketing);
    expect(await call(
      "select public.decide_lead_magnet_approval_v6($1, true, null)",
      [humanApproval],
    )).toMatch(/Bot accounts cannot perform this action/);

    await asUser(sales);
    const salesDecision = await db.query<{ status: string; decided_by: string }>(
      `select status, decided_by::text as decided_by
         from public.decide_lead_magnet_approval_v6($1::uuid, true, null)`,
      [salesApproval],
    );
    await db.exec("reset role");
    expect(salesDecision.rows[0]).toEqual({ status: "approved", decided_by: sales });
    const frozen = await db.query<{ decided_by_bot: boolean }>(
      "select decided_by_bot from public.lead_magnet_approvals where id = $1",
      [salesApproval],
    );
    expect(frozen.rows[0]?.decided_by_bot).toBe(true);
    const columnPriv = await db.query<{
      anon: boolean; authn: boolean; service: boolean; service_status: boolean;
    }>(`
      select
        has_column_privilege('anon', 'public.lead_magnet_approvals', 'decided_by_bot', 'UPDATE') as anon,
        has_column_privilege('authenticated', 'public.lead_magnet_approvals', 'decided_by_bot', 'UPDATE') as authn,
        has_column_privilege('service_role', 'public.lead_magnet_approvals', 'decided_by_bot', 'UPDATE') as service,
        has_column_privilege('service_role', 'public.lead_magnet_approvals', 'status', 'UPDATE') as service_status
    `);
    expect(columnPriv.rows[0]).toEqual({
      anon: false, authn: false, service: false, service_status: true,
    });
    await db.exec("grant select on public.lead_magnet_approvals to service_role");
    await db.exec("set role service_role");
    expect(await call(
      "update public.lead_magnet_approvals set rejection_reason = rejection_reason where id = $1",
      [salesApproval],
    )).toBeNull();
    await db.exec("set role service_role");
    expect(await call(
      "update public.lead_magnet_approvals set decided_by_bot = false where id = $1",
      [salesApproval],
    )).toMatch(/permission denied/);

    await asUser(HUMAN);
    const humanDecision = await db.query<{ status: string; decided_by: string }>(
      `select status, decided_by::text as decided_by
         from public.decide_lead_magnet_approval_v6($1::uuid, true, null)`,
      [humanApproval],
    );
    await db.exec("reset role");
    expect(humanDecision.rows[0]).toEqual({ status: "approved", decided_by: HUMAN });

    const delivery = await callReady(
      sales,
      "select public.set_lead_magnet_delivery_enabled($1, true)",
      [CLIENT],
    );
    expect(delivery).toMatch(/Bot accounts cannot perform this action/);
    const courier = await callReady(
      sales,
      "select public.enqueue_agent_job('lead_magnet_courier', $1)",
      [CLIENT],
    );
    expect(courier).toMatch(/Bot accounts cannot perform this action/);

    await db.exec("reset role");
    await db.query(
      `insert into public.lead_magnets (id, name) values
         ('e0000000-0000-4000-8000-000000000001', 'Sales magnet'),
         ('e0000000-0000-4000-8000-000000000002', 'Human magnet')`,
    );
    await db.query(
      `insert into public.lead_magnet_versions (id, magnet_id) values ($1, 'e0000000-0000-4000-8000-000000000001'),
         ($2, 'e0000000-0000-4000-8000-000000000002')`,
      [salesApproval, humanApproval],
    );
    await db.query(
      `insert into public.lead_magnet_deliveries
         (id, client_id, magnet_version_id, channel, recipient, status, attempts)
       values
         ('e1000000-0000-4000-8000-000000000001', $1, $2, 'email', 'lead@example.com', 'queued', 0),
         ('e1000000-0000-4000-8000-000000000002', $1, $3, 'email', 'lead@example.com', 'queued', 0)`,
      [CLIENT, salesApproval, humanApproval],
    );
    await db.query(
      `insert into public.client_engine_settings (client_id, lead_magnet_delivery_enabled)
       values ($1, true)
       on conflict (client_id) do update set lead_magnet_delivery_enabled = true`,
      [CLIENT],
    );
    const due = await db.query<{ magnet_version_id: string; blocker: string | null }>(
      `select magnet_version_id::text, blocker from public.lead_magnet_due
        where client_id = $1 order by magnet_version_id`,
      [CLIENT],
    );
    const byVersion = new Map(due.rows.map((row) => [row.magnet_version_id, row.blocker]));
    expect(byVersion.get(salesApproval)).toMatch(/A bot approved this magnet/);
    expect(byVersion.get(humanApproval)).toBeNull();

    await asUser(sales);
    expect(await call(
      "select public.revoke_lead_magnet_approval_v6($1, 'stop')",
      [salesApproval],
    )).toMatch(/Bot accounts cannot perform this action/);
    await db.exec("reset role");
    const stillQueued = await db.query<{ status: string }>(
      "select status from public.lead_magnet_deliveries where id = 'e1000000-0000-4000-8000-000000000001'",
    );
    expect(stillQueued.rows[0]?.status).toBe("queued");

    await asService();
    const claimed = await db.query<{ magnet_version_id: string }>(
      "select magnet_version_id::text from public.claim_lead_magnet_deliveries(5)",
    );
    await db.exec("reset role");
    expect(claimed.rows.map((row) => row.magnet_version_id)).toEqual([humanApproval]);

    await db.query(
      "update public.lead_magnet_approvals set decided_by = null where id = $1",
      [salesApproval],
    );
    const deletedBot = await db.query<{ decided_by_bot: boolean; blocker: string | null }>(
      `select a.decided_by_bot, d.blocker
         from public.lead_magnet_approvals a
         join public.lead_magnet_due d on d.magnet_version_id = a.magnet_version_id
        where a.id = $1`,
      [salesApproval],
    );
    expect(deletedBot.rows[0]?.decided_by_bot).toBe(true);
    expect(deletedBot.rows[0]?.blocker).toMatch(/A bot approved this magnet/);
    await db.query(
      "update public.lead_magnet_approvals set decided_by_bot = false where id = $1",
      [salesApproval],
    );
    const nullDecider = await db.query<{ blocker: string | null }>(
      `select blocker from public.lead_magnet_due where magnet_version_id = $1`,
      [salesApproval],
    );
    expect(nullDecider.rows[0]?.blocker).toMatch(/A bot approved this magnet/);

    await db.query(
      `update public.lead_magnet_approvals
          set decided_by = $2, decided_by_bot = true
        where id = $1`,
      [salesApproval, sales],
    );
    await asService();
    await db.query(
      "update public.profiles set is_bot = false, bot_key = null where id = $1",
      [sales],
    );
    await db.exec("reset role");
    const demoted = await db.query<{ decided_by_bot: boolean; blocker: string | null }>(
      `select a.decided_by_bot, d.blocker
         from public.lead_magnet_approvals a
         join public.lead_magnet_due d on d.magnet_version_id = a.magnet_version_id
        where a.id = $1`,
      [salesApproval],
    );
    expect(demoted.rows[0]).toMatchObject({
      decided_by_bot: true,
      blocker: expect.stringMatching(/A bot approved this magnet/),
    });
    await asService();
    await db.query(
      "update public.profiles set is_bot = true, bot_key = 'bot-sales' where id = $1",
      [sales],
    );
    await db.exec("reset role");

    await db.query(
      `update public.lead_magnet_approvals
          set status = 'pending', decided_at = null, decided_by = null, decided_by_bot = false
        where id = $1`,
      [salesApproval],
    );
    await asUser(HUMAN);
    const reapproved = await db.query<{ decided_by_bot: boolean; decided_by: string }>(
      `select decided_by_bot, decided_by::text
         from public.decide_lead_magnet_approval_v6($1::uuid, true, null)`,
      [salesApproval],
    );
    await db.exec("reset role");
    expect(reapproved.rows[0]).toEqual({ decided_by_bot: false, decided_by: HUMAN });
    const deliverable = await db.query<{ blocker: string | null }>(
      "select blocker from public.lead_magnet_due where magnet_version_id = $1",
      [salesApproval],
    );
    expect(deliverable.rows[0]?.blocker).toBeNull();
    await asService();
    const claimedAfter = await db.query<{ magnet_version_id: string }>(
      "select magnet_version_id::text from public.claim_lead_magnet_deliveries(5)",
    );
    await db.exec("reset role");
    expect(claimedAfter.rows.map((row) => row.magnet_version_id)).toEqual([salesApproval]);
  });

  it("purges a bot's sessions and refuses a human", async () => {
    await db.exec("reset role");
    const botSession = "99999999-9999-4999-8999-999999999991";
    const humanSession = "99999999-9999-4999-8999-999999999992";
    await db.query("insert into auth.sessions (id, user_id) values ($1, $2), ($3, $4)", [
      botSession, BOT, humanSession, HUMAN,
    ]);
    await db.query(
      "insert into auth.refresh_tokens (user_id, session_id) values ($1, $2), ($3, $4)",
      [BOT, botSession, HUMAN, humanSession],
    );
    await asService();
    const refused = await call(`select * from public.revoke_bot_sessions('${HUMAN}'::uuid)`);
    expect(refused).toMatch(/only a bot account may have sessions revoked here/);
    await asUser(BOT);
    const asBot = await call(`select * from public.revoke_bot_sessions('${BOT}'::uuid)`);
    expect(asBot ?? "").toMatch(/permission denied|only service_role/);
    await asService();
    const purged = await db.query<{ sessions_deleted: number; refresh_tokens_deleted: number }>(
      "select * from public.revoke_bot_sessions($1)",
      [BOT],
    );
    expect(purged.rows[0]).toEqual({ sessions_deleted: 1, refresh_tokens_deleted: 1 });
    const left = await db.query<{ user_id: string }>("select user_id::text from auth.sessions");
    expect(left.rows.map((row) => row.user_id)).toEqual([HUMAN]);
    const tokens = await db.query<{ user_id: string }>("select user_id from auth.refresh_tokens");
    expect(tokens.rows.map((row) => row.user_id)).toEqual([HUMAN]);
    await db.exec("reset role");
  });

  it("fires the AAL2 decision triggers against a bot before they trust assurance", async () => {
    await db.exec("reset role");
    await db.exec(`
      create table if not exists public.bot_sales_probe (id uuid primary key);
      drop trigger if exists bot_sales_probe_guard on public.bot_sales_probe;
      create trigger bot_sales_probe_guard before insert on public.bot_sales_probe
        for each row execute function public.sales_entitlement_inbox_request_guard_v6();
      create table if not exists public.bot_release_probe (id uuid primary key);
      drop trigger if exists bot_release_probe_guard on public.bot_release_probe;
      create trigger bot_release_probe_guard before insert on public.bot_release_probe
        for each row execute function public.bind_approved_production_release_packet_v6();
      grant insert on public.bot_sales_probe, public.bot_release_probe to authenticated;
      grant execute on function public.sales_entitlement_inbox_request_guard_v6() to authenticated;
      grant execute on function public.bind_approved_production_release_packet_v6() to authenticated;
    `);
    await asUser(BOT, "aal2");
    const sales = await call("insert into public.bot_sales_probe (id) values (gen_random_uuid())");
    expect(sales).toMatch(/Bot accounts cannot perform this action/);
    await asUser(BOT, "aal2");
    const release = await call("insert into public.bot_release_probe (id) values (gen_random_uuid())");
    expect(release).toMatch(/Bot accounts cannot perform this action/);
  });
});
