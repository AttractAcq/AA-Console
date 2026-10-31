import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_USER_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT_USER_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EDITOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SMM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROFILELESS = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SMM_MEMBER = "99999999-9999-4999-8999-999999999999";

let db: PGlite;
const rows = async () =>
  (await db.query<{ client_id: string; submitted_name: string; consent_text: string }>(
    "select client_id,submitted_name,consent_text from public.proof_capture_submissions order by client_id",
  )).rows;

async function asRole(role: "authenticated" | "anon" | "service_role", user = "") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec(`set role ${role}`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    grant usage on schema public, auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role',true) $$;
    create type public.app_role as enum ('admin','employee','client');
    create table public.profiles(id uuid primary key, role public.app_role not null);
    create table public.client_users(client_id uuid not null, user_id uuid not null);
    create table public.team_members(
      id uuid primary key, user_id uuid not null, active boolean not null, category text not null);
    create table public.client_assignments(
      id uuid primary key default gen_random_uuid(), member_id uuid not null,
      client_id uuid not null, ended_at timestamptz, created_at timestamptz default now());
    create table public.job_assignments(client_id uuid not null, member_id uuid not null);
    insert into public.profiles values
      ('${ADMIN}','admin'),('${CLIENT_USER_A}','client'),('${CLIENT_USER_B}','client'),
      ('${EDITOR}','employee'),('${SMM}','employee');
    insert into public.client_users values
      ('${CLIENT_A}','${CLIENT_USER_A}'),('${CLIENT_B}','${CLIENT_USER_B}');
    insert into public.team_members values
      ('88888888-8888-4888-8888-888888888888','${EDITOR}',true,'editors'),
      ('${SMM_MEMBER}','${SMM}',true,'smm');
    insert into public.job_assignments values
      ('${CLIENT_A}','88888888-8888-4888-8888-888888888888');
    insert into public.client_assignments(member_id,client_id) values
      ('${SMM_MEMBER}','${CLIENT_A}');
    create function public.current_role_of() returns public.app_role
      language sql stable security definer set search_path='' as $$
        select role from public.profiles where id=auth.uid() $$;
    create function public.is_admin() returns boolean
      language sql stable security definer set search_path='' as $$
        select coalesce((select role='admin' from public.profiles where id=auth.uid()),false) $$;
    create function public.is_client_user(target uuid) returns boolean
      language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.client_users
          where client_id=target and user_id=auth.uid()) $$;
    create function public.can_access_client(target uuid) returns boolean
      language sql stable security definer set search_path='' as $$
        select public.is_admin() or public.is_client_user(target) or exists(
          select 1 from public.job_assignments ja join public.team_members tm
            on tm.id=ja.member_id
           where ja.client_id=target and tm.user_id=auth.uid() and tm.active) $$;
    create function public.active_video_approval_manager(target uuid) returns uuid
      language sql stable security definer set search_path='' as $$
        select tm.user_id from public.client_assignments ca
          join public.team_members tm on tm.id=ca.member_id
         where ca.client_id=target and ca.ended_at is null and tm.active
           and tm.category='smm' and tm.user_id is not null
           and (auth.role() is distinct from 'authenticated'
                or public.current_role_of() is not null)
         order by ca.created_at desc, ca.id desc limit 1 $$;
    create table public.proof_capture_submissions(
      id uuid primary key default gen_random_uuid(), client_id uuid not null,
      submitted_name text not null, consent_text text not null);
    insert into public.proof_capture_submissions(client_id,submitted_name,consent_text)
      values ('${CLIENT_A}','Alice','Consent A'),('${CLIENT_B}','Bob','Consent B');
    alter table public.proof_capture_submissions enable row level security;
    create policy proof_submissions_read on public.proof_capture_submissions
      for select to authenticated using(public.can_access_client(client_id));
    grant select on public.proof_capture_submissions to authenticated;
    grant all on public.proof_capture_submissions to service_role;
  `);

  // Demonstrate the migration-216 leak before applying the actual 294 SQL.
  await asRole("authenticated", EDITOR);
  expect((await rows()).map((row) => row.submitted_name)).toEqual(["Alice"]);
  await db.exec("reset role");
  await db.exec(await readFile(new URL(
    "../../../supabase/migrations/20261101110000_297_proof_submission_read_scope.sql",
    import.meta.url,
  ), "utf8"));
}, 60000);

afterAll(async () => { await db?.close(); });

describe("migration 294 proof submission personal-evidence reads", () => {
  it("denies an active editor whose job assignment still grants broad client access", async () => {
    await asRole("authenticated", EDITOR);
    expect((await db.query<{ allowed: boolean }>(
      "select public.can_access_client($1) as allowed", [CLIENT_A],
    )).rows[0]?.allowed).toBe(true);
    expect(await rows()).toHaveLength(0);
  });

  it("preserves administrator and same-client client-profile reads", async () => {
    await asRole("authenticated", ADMIN);
    expect((await rows()).map((row) => row.submitted_name)).toEqual(["Alice", "Bob"]);
    await asRole("authenticated", CLIENT_USER_A);
    expect((await rows()).map((row) => row.submitted_name)).toEqual(["Alice"]);
    await asRole("authenticated", CLIENT_USER_B);
    expect((await rows()).map((row) => row.submitted_name)).toEqual(["Bob"]);
  });

  it("requires the current employee SMM seat and removes access on transfer or retirement", async () => {
    await asRole("authenticated", SMM);
    expect((await rows()).map((row) => row.submitted_name)).toEqual(["Alice"]);
    await db.exec("reset role; update public.client_assignments set ended_at=now()");
    await asRole("authenticated", SMM);
    expect(await rows()).toHaveLength(0);
    await db.exec(`reset role; update public.client_assignments set ended_at=null;
      update public.team_members set active=false where id='${SMM_MEMBER}'`);
    await asRole("authenticated", SMM);
    expect(await rows()).toHaveLength(0);
    await db.exec(`reset role; update public.team_members set active=true where id='${SMM_MEMBER}'`);
  });

  it("does not treat a stale client membership or SMM assignment as a profile role", async () => {
    await db.exec(`reset role; update public.profiles set role='employee'
      where id='${CLIENT_USER_A}'`);
    await asRole("authenticated", CLIENT_USER_A);
    expect(await rows()).toHaveLength(0);
    await db.exec(`reset role; update public.profiles set role='client'
      where id='${CLIENT_USER_A}'; update public.profiles set role='client' where id='${SMM}'`);
    await asRole("authenticated", SMM);
    expect(await rows()).toHaveLength(0);
    await db.exec(`reset role; update public.profiles set role='employee' where id='${SMM}'`);
  });

  it("denies profileless and anonymous callers while preserving service/cron reads", async () => {
    await asRole("authenticated", PROFILELESS);
    expect(await rows()).toHaveLength(0);
    await asRole("anon");
    await expect(rows()).rejects.toThrow(/permission denied/i);
    await asRole("service_role");
    expect((await rows()).map((row) => row.submitted_name)).toEqual(["Alice", "Bob"]);
  });
});
