import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Run migration 271 against a disposable PostgreSQL database with the exact
// pre-migration policy names and caller grants observed in production. The
// auth trigger's no-profile behavior is tested separately by 270's suite.
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROFILELESS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MANAGER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DIRECTOR = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PROFILELESS_ROLE = "authenticated";

const referencePolicies = [
  ["agents", "agents_read"],
  ["awareness_audience_map", "awareness_audience_map_read"],
  ["campaign_action_executors", "campaign_action_executors_read"],
  ["campaign_template_matrix", "campaign_template_matrix_read"],
  ["engine_controls", "ec_read"],
  ["message_channels", "message_channels_read"],
  ["opportunity_score_factors", "opportunity_score_factors_read"],
  ["opportunity_transitions", "opportunity_transitions_read"],
  ["platform_format_publishing", "pfp_read"],
  ["platform_publishing", "pp_read"],
  ["profile_field_support", "profile_field_support_read"],
  ["proof_destinations", "proof_destinations_read"],
  ["proof_placement_transitions", "proof_placement_transitions_read"],
  ["record_templates", "record_templates_read"],
  ["slot_pipeline", "sp_read"],
  ["slot_transitions", "st_read"],
] as const;

const scopedPolicies = [
  ["agent_jobs", "agent_jobs_scoped_read"],
  ["agent_job_events", "agent_job_events_scoped_read"],
  ["campaigns", "campaigns_scoped_read"],
  ["post_copy", "post_copy_scoped_read"],
  ["scheduled_posts", "sp_scoped_read"],
] as const;

const sweeps = [
  "enqueue_campaign_action_sweep", "enqueue_lead_magnet_sweep",
  "enqueue_outbound_sweep", "enqueue_profile_update_sweep",
  "enqueue_proof_placement_sweep", "enqueue_publish_sweep",
  "enqueue_sequence_sweep", "enqueue_token_health_job",
] as const;

let db: PGlite;
const migration = (name: string) =>
  readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "service_role", id: string, sql: string, params: unknown[] = [],
): Promise<T[]> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.query("select set_config('request.jwt.claim.role', $1, false)", [role]);
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

async function grantRoutine(signature: string) {
  await db.exec(`revoke execute on function public.${signature} from public, anon;
    grant execute on function public.${signature} to authenticated, service_role;`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema mcp_internal;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create table public.profiles (id uuid primary key, role text not null);
    create table public.client_users (client_id uuid not null, user_id uuid not null);
    insert into public.profiles (id, role) values
      ('${ADMIN}','admin'), ('${CLIENT_USER}','client'), ('${STAFF}','employee');
    insert into public.client_users (client_id,user_id) values ('${CLIENT}','${CLIENT_USER}');
    create function public.current_role_of() returns text language sql stable security definer
      set search_path=public as $$ select role from public.profiles where id=auth.uid() $$;
    create function public.is_admin() returns boolean language sql stable security definer
      set search_path=public as $$ select coalesce(
        (select role='admin' from public.profiles where id=auth.uid()), false) $$;
    create function public.can_access_client(target uuid) returns boolean
      language sql stable security definer set search_path=public as $$
        select public.is_admin() or exists(select 1 from public.client_users
          where client_id=target and user_id=auth.uid()) $$;
    create function public.caller_gate_markers() returns text language sql immutable
      as $$ select 'is_admin'::text $$;
    create function public.lock_down_definer_functions() returns integer language sql
      as $$ select 0 $$;
  `);

  for (const [table, policy] of referencePolicies) {
    await db.exec(`create table public.${table} (id uuid primary key default gen_random_uuid(), note text);
      alter table public.${table} enable row level security;
      create policy ${policy} on public.${table} for select to authenticated using (true);
      insert into public.${table} (note) values ('shared console reference');`);
  }
  await db.exec(`
    create table public.agent_jobs (
      id uuid primary key default gen_random_uuid(), agent_key text not null,
      client_id uuid, created_by uuid);
    create table public.agent_job_events (
      id uuid primary key default gen_random_uuid(), job_id uuid not null references public.agent_jobs(id),
      note text);
    create table public.campaigns (id uuid primary key default gen_random_uuid(), client_id uuid, note text);
    create table public.post_copy (id uuid primary key default gen_random_uuid(), client_id uuid, note text);
    create table public.scheduled_posts (id uuid primary key default gen_random_uuid(), client_id uuid, note text);
  `);
  for (const [table, policy] of scopedPolicies) {
    await db.exec(`alter table public.${table} enable row level security;
      create policy ${table}_admin_all on public.${table} for all to authenticated
        using (public.is_admin()) with check (public.is_admin());
      create policy ${policy} on public.${table} for select to authenticated using (
        ${table === "agent_job_events"
          ? "exists (select 1 from public.agent_jobs j where j.id=job_id and (j.client_id is null or public.can_access_client(j.client_id)))"
          : "client_id is null or public.can_access_client(client_id)"}
      );`);
  }
  await db.exec(`
    insert into public.agent_jobs (agent_key,client_id) values ('icp',null),('icp','${CLIENT}'),('icp','${OTHER}');
    insert into public.agent_job_events (job_id,note)
      select id,'queued' from public.agent_jobs;
    insert into public.campaigns (client_id,note) values (null,'global'),('${CLIENT}','own'),('${OTHER}','other');
    insert into public.post_copy (client_id,note) values (null,'global'),('${CLIENT}','own'),('${OTHER}','other');
    insert into public.scheduled_posts (client_id,note) values (null,'global'),('${CLIENT}','own'),('${OTHER}','other');
    create view public.agent_stats with (security_invoker=true) as
      select a.id, count(j.id) as runs from public.agents a
      left join public.agent_jobs j on true group by a.id;
    create view public.campaign_totals with (security_invoker=true) as
      select count(*)::integer as campaigns from public.campaigns;
    create or replace view public.security_definer_exposure with (security_invoker=true) as
      select n.nspname as schema, p.proname as function,
        pg_get_function_identity_arguments(p.oid) as arguments,
        has_function_privilege('anon',p.oid,'execute') as anon_can_execute,
        has_function_privilege('authenticated',p.oid,'execute') as signed_in_can_execute,
        (p.prosrc ~* public.caller_gate_markers()) as body_checks_the_caller
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','mcp_internal') and p.prosecdef
        and (has_function_privilege('anon',p.oid,'execute')
          or has_function_privilege('authenticated',p.oid,'execute'))
      order by anon_can_execute desc,body_checks_the_caller,n.nspname,p.proname;
    create table public.team_members (
      id uuid primary key default gen_random_uuid(), user_id uuid,
      active boolean not null, category text not null);
    create table public.client_assignments (
      id uuid primary key default gen_random_uuid(), client_id uuid not null,
      member_id uuid not null references public.team_members(id),
      ended_at timestamptz, created_at timestamptz not null default now());
    insert into public.team_members (user_id,active,category) values
      ('${MANAGER}',true,'smm'),('${DIRECTOR}',true,'creative_director');
    insert into public.client_assignments (client_id,member_id)
      select '${CLIENT}'::uuid,id from public.team_members;
    create function public.enqueue_agent_job_internal(
      p_agent_key text,p_client_id uuid,p_input_table text,p_input_id uuid,
      p_actor uuid,p_params jsonb default '{}'::jsonb,p_description text default 'Queued'
    ) returns uuid language plpgsql security definer set search_path=public as $$
      declare v_id uuid;
      begin
        insert into public.agent_jobs(agent_key,client_id,created_by)
        values (p_agent_key,p_client_id,p_actor) returning id into v_id;
        return v_id;
      end $$;
  `);

  // Load the actual pre-271 human enqueue and staff-resolver definitions.
  for (const [file, signature] of [
    ["20260908080000_63_mcp_brief_enqueue.sql", "create or replace function enqueue_agent_job("],
    ["20261010130000_175_video_approval_routing.sql", "create or replace function active_video_approval_manager("],
    ["20261025120000_247_creative_decisions_have_a_seat.sql", "create or replace function public.active_creative_director("],
  ] as const) {
    const sql = await migration(file);
    const start = sql.indexOf(signature);
    const end = sql.indexOf("$$;", start) + 3;
    if (start < 0 || end < 3) throw new Error(`Missing function ${signature} in ${file}`);
    await db.exec(sql.slice(start, end));
  }
  await grantRoutine("enqueue_agent_job(text,uuid,text,uuid)");
  await grantRoutine("active_video_approval_manager(uuid)");
  await grantRoutine("active_creative_director(uuid)");
  for (const name of sweeps) {
    await db.exec(`create function public.${name}() returns uuid language sql security definer
      as $$ select gen_random_uuid() $$;`);
    await grantRoutine(`${name}()`);
  }
  await db.exec(`
    create function public.available_slots_v6(uuid,integer) returns integer language sql
      security definer as $$ select 1 $$;
    create function public.can_run_agent(text,uuid) returns boolean language sql
      security definer as $$ select true $$;
  `);
  await grantRoutine("available_slots_v6(uuid,integer)");
  await grantRoutine("can_run_agent(text,uuid)");
  await db.exec(`
    grant usage on schema public,auth to authenticated,service_role;
    grant select,insert on all tables in schema public to authenticated;
    grant select on public.agent_stats,public.campaign_totals,public.security_definer_exposure to authenticated;
    grant execute on function public.current_role_of(),public.is_admin(),
      public.can_access_client(uuid),public.caller_gate_markers() to authenticated;
  `);

  // Prove the fixture reproduces real pre-271 reachability before changing it.
  expect(await asRole(PROFILELESS_ROLE, PROFILELESS,
    "select id from public.engine_controls")).toHaveLength(1);
  expect(await asRole(PROFILELESS_ROLE, PROFILELESS,
    "select id from public.agent_jobs where client_id is null")).toHaveLength(1);
  expect(await asRole(PROFILELESS_ROLE, PROFILELESS,
    "select public.active_video_approval_manager($1) as user_id", [CLIENT]))
    .toEqual([{ user_id: MANAGER }]);
  expect((await asRole(PROFILELESS_ROLE, PROFILELESS,
    "select schema from public.security_definer_exposure")).length).toBeGreaterThan(0);
  expect(await asRole(PROFILELESS_ROLE, PROFILELESS,
    "select id from public.agent_stats")).toHaveLength(1);
  expect(await asRole<{ campaigns: number }>(PROFILELESS_ROLE, PROFILELESS,
    "select campaigns from public.campaign_totals")).toEqual([{ campaigns: 1 }]);
  expect(await asRole(PROFILELESS_ROLE, PROFILELESS,
    "select public.enqueue_agent_job('icp',null) as job_id")).toHaveLength(1);

  await db.exec(await migration("20261029220000_271_profileless_authenticated_scope.sql"));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("profileless authenticated JWT boundary after migration 271", () => {
  it("hides all sixteen globally readable reference tables until trusted provisioning", async () => {
    for (const [table] of referencePolicies) {
      expect(await asRole(PROFILELESS_ROLE, PROFILELESS,
        `select id from public.${table}`)).toHaveLength(0);
      expect(await asRole("authenticated", CLIENT_USER,
        `select id from public.${table}`)).toHaveLength(1);
      expect(await asRole("authenticated", STAFF,
        `select id from public.${table}`)).toHaveLength(1);
    }
  });

  it("hides agency-wide rows and client rows from profileless users while preserving scoped and admin reads", async () => {
    for (const [table] of scopedPolicies) {
      expect(await asRole("authenticated", PROFILELESS,
        `select id from public.${table}`)).toHaveLength(0);
      expect(await asRole("authenticated", CLIENT_USER,
        `select id from public.${table}`)).toHaveLength(1);
      expect(await asRole("authenticated", ADMIN,
        `select id from public.${table}`)).toHaveLength(table === "agent_jobs" ? 4 : 3);
    }
  });

  it("keeps invoker views and the catalog exposure view empty for profileless identities", async () => {
    expect(await asRole("authenticated", PROFILELESS,
      "select id from public.agent_stats")).toHaveLength(0);
    expect(await asRole<{ campaigns: number }>("authenticated", PROFILELESS,
      "select campaigns from public.campaign_totals")).toEqual([{ campaigns: 0 }]);
    expect(await asRole("authenticated", PROFILELESS,
      "select schema from public.security_definer_exposure")).toHaveLength(0);
    expect((await asRole("authenticated", ADMIN,
      "select schema from public.security_definer_exposure")).length).toBeGreaterThan(0);
  });

  it("denies profileless enqueue, allows scoped clients, and reserves null-client jobs for admins", async () => {
    await expect(asRole("authenticated", PROFILELESS,
      "select public.enqueue_agent_job('icp',null)")).rejects.toThrow(/provisioned console account/i);
    await expect(asRole("authenticated", PROFILELESS,
      "select public.enqueue_agent_job('icp',$1)", [CLIENT])).rejects.toThrow(/provisioned console account/i);
    await expect(asRole("authenticated", CLIENT_USER,
      "select public.enqueue_agent_job('icp',null)")).rejects.toThrow(/admin/i);
    await expect(asRole("authenticated", CLIENT_USER,
      "select public.enqueue_agent_job('icp',$1)", [OTHER])).rejects.toThrow(/not permitted/i);
    expect(await asRole("authenticated", CLIENT_USER,
      "select public.enqueue_agent_job('icp',$1) as job_id", [CLIENT])).toHaveLength(1);
    expect(await asRole("authenticated", ADMIN,
      "select public.enqueue_agent_job('icp',null) as job_id")).toHaveLength(1);
  });

  it("hides staff resolver IDs from profileless identities but preserves provisioned and service callers", async () => {
    for (const fn of ["active_video_approval_manager", "active_creative_director"]) {
      expect(await asRole("authenticated", PROFILELESS,
        `select public.${fn}($1) as user_id`, [CLIENT])).toEqual([{ user_id: null }]);
      expect((await asRole("authenticated", CLIENT_USER,
        `select public.${fn}($1) as user_id`, [CLIENT]))[0]?.user_id).toBeTruthy();
      expect((await asRole("service_role", PROFILELESS,
        `select public.${fn}($1) as user_id`, [CLIENT]))[0]?.user_id).toBeTruthy();
    }
  });

  it("removes direct browser execution of worker-only sweeps and read helpers", async () => {
    for (const signature of [
      ...sweeps.map((name) => `public.${name}()`),
      "public.available_slots_v6(uuid,integer)", "public.can_run_agent(text,uuid)",
    ]) {
      expect((await db.query<{ allowed: boolean }>(
        "select has_function_privilege('authenticated',$1,'execute') as allowed", [signature],
      )).rows[0]?.allowed).toBe(false);
      expect((await db.query<{ allowed: boolean }>(
        "select has_function_privilege('service_role',$1,'execute') as allowed", [signature],
      )).rows[0]?.allowed).toBe(true);
    }
    await expect(asRole("authenticated", PROFILELESS,
      "select public.enqueue_publish_sweep()")).rejects.toThrow(/permission denied/i);
  });
});
