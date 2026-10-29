import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const CLIENT_USER = "44444444-4444-4444-8444-444444444444";
const OTHER_USER = "55555555-5555-4555-8555-555555555555";
const EDITOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SALES = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TABLES = [
  "lead_submissions", "lead_magnet_deliveries", "lead_sequence_enrollments",
  "lead_suppressions", "outbound_messages", "client_appointments",
  "dm_identities", "dm_conversations", "dm_messages", "sales_agent_conversations",
] as const;
const BROAD_TABLES = TABLES.filter((table) => table !== "sales_agent_conversations");
let db: PGlite;

async function asUser(user: string) {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claim.sub','${user}',false); set role authenticated;`);
}
async function asService() {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claim.sub','',false); set role service_role;`);
}
async function asAnon() {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','anon',false);
    select set_config('request.jwt.claim.sub','',false); set role anon;`);
}
async function rows(table: (typeof TABLES)[number]) {
  return (await db.query<{ client_id: string; marker: string }>(
    `select client_id,marker from public.${table} order by client_id`)).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role',true) $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table profiles(id uuid primary key, role text not null);
    create table client_users(client_id uuid not null,user_id uuid not null);
    create table team_members(id uuid primary key,user_id uuid not null,active boolean not null);
    create table job_assignments(client_id uuid not null,member_id uuid not null);
    create table sales_gate(inbox_enforced boolean not null);
    insert into sales_gate values(false);
    create table sales_grants(client_id uuid not null,member_id uuid not null,
      bound_user_id uuid not null,inbox_decision_id uuid,revoked_at timestamptz);
    insert into profiles values
      ('${ADMIN}','admin'),('${CLIENT_USER}','client'),('${OTHER_USER}','client'),
      ('${EDITOR}','employee'),('${SALES}','employee');
    insert into client_users values ('${CLIENT}','${CLIENT_USER}'),('${OTHER}','${OTHER_USER}');
    insert into team_members values
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','${EDITOR}',true),
      ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','${SALES}',true);
    insert into job_assignments values
      ('${CLIENT}','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    create function public.is_admin() returns boolean language sql stable security definer
      set search_path='' as $$ select exists(select 1 from public.profiles
        where id=auth.uid() and role='admin') $$;
    create function public.is_client_user(target uuid) returns boolean
      language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.client_users
          where client_id=target and user_id=auth.uid()) $$;
    create function public.can_access_client(target uuid) returns boolean
      language sql stable security definer set search_path='' as $$
        select public.is_admin() or public.is_client_user(target) or exists(
          select 1 from public.job_assignments j join public.team_members tm on tm.id=j.member_id
           where j.client_id=target and tm.user_id=auth.uid() and tm.active) $$;
    create function public.has_client_sales_entitlement(target uuid) returns boolean
      language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.sales_gate where inbox_enforced) and exists(
          select 1 from public.sales_grants g
          join public.team_members tm on tm.id=g.member_id
          join public.profiles p on p.id=tm.user_id
           where g.client_id=target and g.bound_user_id=auth.uid()
             and tm.user_id=g.bound_user_id and tm.active and p.role='employee'
             and g.inbox_decision_id is not null and g.revoked_at is null) $$;
    create function public.may_manage_client_leads(target uuid) returns boolean
      language sql stable security definer set search_path='' as $$
        select auth.role()='service_role' or public.is_admin()
          or public.is_client_user(target)
          or public.has_client_sales_entitlement(target) $$;
    revoke execute on function public.may_manage_client_leads(uuid)
      from public,anon,authenticated;
    grant execute on function public.is_admin(),public.is_client_user(uuid),
      public.can_access_client(uuid),public.has_client_sales_entitlement(uuid)
      to authenticated;
  `);
  for (const table of TABLES) {
    await db.exec(`create table public.${table} (
      id uuid primary key default gen_random_uuid(), client_id uuid not null, marker text not null);
      insert into public.${table}(client_id,marker) values
        ('${CLIENT}','A'),('${OTHER}','B');
      alter table public.${table} enable row level security;
      grant select on public.${table} to service_role;`);
    if (table === "sales_agent_conversations") {
      await db.exec(`create policy sac_admin_all on public.${table} for all to authenticated
        using(public.is_admin()) with check(public.is_admin());
        create policy sac_client_read on public.${table} for select to authenticated
        using(public.is_client_user(client_id));`);
    } else {
      await db.exec(`create policy ${table}_read on public.${table}
        for select to authenticated using(public.can_access_client(client_id));
        grant select on public.${table} to authenticated;`);
    }
  }
  // Prove the prior broad assignment path exposes every contact table.
  await asUser(EDITOR);
  for (const table of BROAD_TABLES) expect(await rows(table)).toHaveLength(1);
  await expect(rows("sales_agent_conversations")).rejects.toThrow(/permission denied/);
  await db.exec("reset role");
  const sql = await readFile(new URL(
    "../../../supabase/migrations/20261029190000_268_contact_and_conversation_scope.sql",
    import.meta.url), "utf8");
  await db.exec(sql);
});

describe("migration 268: contact and conversation scope", () => {
  it("denies a generic assigned editor across every contact surface", async () => {
    await asUser(EDITOR);
    expect((await db.query<{ allowed: boolean }>(
      "select can_access_client($1) as allowed", [CLIENT])).rows[0]?.allowed).toBe(true);
    for (const table of TABLES) expect(await rows(table), table).toHaveLength(0);
  });

  it("preserves admin, same-client user and service reads without cross-client bleed", async () => {
    await asUser(ADMIN);
    for (const table of TABLES) expect(await rows(table), table).toHaveLength(2);
    await asUser(CLIENT_USER);
    for (const table of TABLES) expect((await rows(table)).map((row) => row.marker), table)
      .toEqual(["A"]);
    await asUser(OTHER_USER);
    for (const table of TABLES) expect((await rows(table)).map((row) => row.marker), table)
      .toEqual(["B"]);
    await asService();
    for (const table of TABLES) expect(await rows(table), table).toHaveLength(2);
    await asAnon();
    await expect(rows("lead_submissions")).rejects.toThrow(/permission denied/);
  });

  it("permits only a live explicitly granted sales member and removes access on retirement or revoke", async () => {
    await asUser(SALES);
    for (const table of TABLES) expect(await rows(table), table).toHaveLength(0);
    await db.exec(`reset role;
      insert into sales_grants values
        ('${CLIENT}','dddddddd-dddd-4ddd-8ddd-dddddddddddd','${SALES}',gen_random_uuid(),null);
      update sales_gate set inbox_enforced=true;`);
    await asUser(SALES);
    for (const table of TABLES) expect((await rows(table)).map((row) => row.marker), table)
      .toEqual(["A"]);
    await db.exec(`reset role;
      update team_members set active=false where user_id='${SALES}';`);
    await asUser(SALES);
    for (const table of TABLES) expect(await rows(table), table).toHaveLength(0);
    await db.exec(`reset role;
      update team_members set active=true where user_id='${SALES}';
      update sales_grants set revoked_at=now() where bound_user_id='${SALES}';`);
    await asUser(SALES);
    for (const table of TABLES) expect(await rows(table), table).toHaveLength(0);
  });
});
