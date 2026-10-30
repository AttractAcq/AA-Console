import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_SMM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT_DIRECTOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EDITOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SMM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DIRECTOR = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const RETIRED = "99999999-9999-4999-8999-999999999999";
const PROFILELESS = "88888888-8888-4888-8888-888888888888";
const M_CLIENT_SMM = "bbbbbbbb-1111-4111-8111-111111111111";
const M_CLIENT_DIRECTOR = "cccccccc-1111-4111-8111-111111111111";
const M_EDITOR = "dddddddd-1111-4111-8111-111111111111";
const M_SMM = "eeeeeeee-1111-4111-8111-111111111111";
const M_DIRECTOR = "ffffffff-1111-4111-8111-111111111111";
const M_RETIRED = "99999999-1111-4111-8111-111111111111";
const VIDEO_A = "aaaa1111-1111-4111-8111-111111111111";
const VIDEO_B = "bbbb2222-2222-4222-8222-222222222222";
const VIDEO_C = "cccc3333-3333-4333-8333-333333333333";

let db: PGlite;

const migration = (name: string) =>
  readFile(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");

function functionFrom(sql: string, marker: string) {
  const start = sql.indexOf(marker);
  const end = sql.indexOf("$$;", start) + 3;
  if (start < 0 || end < 3) throw new Error(`Missing function ${marker}`);
  return sql.slice(start, end);
}

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "anon" | "service_role",
  user: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create function storage.foldername(p text) returns text[] language sql stable as
      $$ select string_to_array(p,'/') $$;
    create function public.try_uuid(p text) returns uuid language sql stable as
      $$ select nullif(p,'')::uuid $$;
    create type public.app_role as enum ('admin','employee','client');
    create table public.profiles(id uuid primary key,role public.app_role not null,
      full_name text,email text);
    create table public.clients(id uuid primary key,name text);
    create table public.client_users(client_id uuid not null,user_id uuid not null,
      primary key(client_id,user_id));
    create table public.team_members(id uuid primary key,user_id uuid,active boolean,
      category text,name text);
    create table public.client_assignments(id uuid primary key,member_id uuid,
      client_id uuid,ended_at timestamptz,created_at timestamptz default now());
    create table public.job_assignments(id uuid primary key,member_id uuid,
      client_id uuid,source_asset_id uuid);
    create table public.client_media_assets(id uuid primary key,client_id uuid,
      media_type text,edit_stage text,human_approved_at timestamptz,
      render_path text,storage_path text);
    create table public.content_approval_settings(singleton boolean primary key,
      owner_user_id uuid);
    create table public.video_client_approval_requests(asset_id uuid primary key,
      client_user_id uuid,requested_by uuid,requested_at timestamptz default now(),
      rejected_at timestamptz,rejection_reason text);
    create table public.video_approval_signoffs(asset_id uuid,approval_role text,
      user_id uuid,render_path text,signed_at timestamptz default now(),
      primary key(asset_id,approval_role));
    create table storage.objects(id uuid primary key,bucket_id text,name text,owner uuid);
    insert into public.profiles(id,role) values
      ('${ADMIN}','admin'),('${CLIENT_SMM}','client'),
      ('${CLIENT_DIRECTOR}','client'),('${EDITOR}','employee'),
      ('${SMM}','employee'),('${DIRECTOR}','employee'),('${RETIRED}','employee');
    insert into public.clients values ('${A}','A'),('${B}','B'),('${C}','C');
    insert into public.client_users values
      ('${A}','${CLIENT_SMM}'),('${A}','${CLIENT_DIRECTOR}');
    insert into public.team_members values
      ('${M_CLIENT_SMM}','${CLIENT_SMM}',true,'smm','Client profile SMM'),
      ('${M_CLIENT_DIRECTOR}','${CLIENT_DIRECTOR}',true,'creative_director','Client profile director'),
      ('${M_EDITOR}','${EDITOR}',true,'editors','Editor'),
      ('${M_SMM}','${SMM}',true,'smm','Employee SMM'),
      ('${M_DIRECTOR}','${DIRECTOR}',true,'creative_director','Employee director'),
      ('${M_RETIRED}','${RETIRED}',false,'editors','Retired editor');
    insert into public.client_assignments values
      ('00000001-1111-4111-8111-111111111111','${M_SMM}','${B}',null,'2026-01-01'),
      ('00000002-1111-4111-8111-111111111111','${M_CLIENT_SMM}','${B}',null,'2026-01-02'),
      ('00000003-1111-4111-8111-111111111111','${M_SMM}','${C}',null,'2026-01-03'),
      ('00000004-1111-4111-8111-111111111111','${M_DIRECTOR}','${B}',null,'2026-01-01'),
      ('00000005-1111-4111-8111-111111111111','${M_CLIENT_DIRECTOR}','${B}',null,'2026-01-02'),
      ('00000006-1111-4111-8111-111111111111','${M_DIRECTOR}','${C}',null,'2026-01-03'),
      ('00000007-1111-4111-8111-111111111111','${M_CLIENT_SMM}','${C}','2026-01-04','2026-01-01'),
      ('00000008-1111-4111-8111-111111111111','${M_RETIRED}','${C}','2026-01-04','2026-01-01'),
      ('00000011-1111-4111-8111-111111111111','${M_EDITOR}','${C}','2026-01-04','2026-01-01');
    insert into public.job_assignments values
      ('00000009-1111-4111-8111-111111111111','${M_CLIENT_SMM}','${B}',null),
      ('00000010-1111-4111-8111-111111111111','${M_EDITOR}','${B}',null);
    insert into public.client_media_assets values
      ('${VIDEO_A}','${A}','video','review_ready',null,'${A}/render.mp4',null),
      ('${VIDEO_B}','${B}','video','review_ready',null,'${B}/render.mp4',null),
      ('${VIDEO_C}','${C}','video','review_ready',null,'${C}/render.mp4',null);
    insert into public.content_approval_settings values (true,'${ADMIN}');
    insert into public.video_client_approval_requests(asset_id,client_user_id,requested_by)
      values ('${VIDEO_A}','${CLIENT_SMM}','${SMM}');
    insert into storage.objects values
      ('aaaa0001-1111-4111-8111-111111111111','client-media','${A}/media.mp4','${CLIENT_SMM}'),
      ('bbbb0002-2222-4222-8222-222222222222','client-media','${B}/media.mp4','${CLIENT_SMM}'),
      ('cccc0003-3333-4333-8333-333333333333','client-media','${C}/media.mp4','${SMM}');
    create function public.current_role_of() returns public.app_role
      language sql stable security definer set search_path='' as $$
        select role from public.profiles where id=auth.uid() $$;
    create function public.is_admin() returns boolean
      language sql stable security definer set search_path='' as $$
        select coalesce((select role='admin' from public.profiles where id=auth.uid()),false) $$;
    create function public.is_client_user(target uuid) returns boolean
      language sql stable security definer set search_path='' as $$
        select coalesce(public.current_role_of()='client'::public.app_role,false)
          and exists(select 1 from public.client_users
            where client_id=target and user_id=auth.uid()) $$;
  `);

  for (const [file, marker] of [
    ["20261101130000_296_current_client_role_entitlement.sql", "create or replace function public.accessible_client_ids()"],
    ["20261101130000_296_current_client_role_entitlement.sql", "create or replace function public.can_access_client(target uuid)"],
    ["20260925110000_127_retired_team_access.sql", "create or replace function is_member(target uuid)"],
    ["20260925110000_127_retired_team_access.sql", "create or replace function current_member_id()"],
    ["20261029220000_271_profileless_authenticated_scope.sql", "create or replace function public.active_video_approval_manager(p_client_id uuid)"],
    ["20261029220000_271_profileless_authenticated_scope.sql", "create or replace function public.active_creative_director(p_client_id uuid)"],
    ["20261010160000_178_video_edit_intake.sql", "create or replace function is_active_assigned_smm()"],
    ["20261101130000_296_current_client_role_entitlement.sql", "create or replace function public.sign_video_approval(p_asset_id uuid, p_role text)"],
    ["20261101130000_296_current_client_role_entitlement.sql", "create or replace function public.creative_seat_of(p_client_id uuid, p_user_id uuid)"],
    ["20261101130000_296_current_client_role_entitlement.sql", "create or replace function public.guard_video_client_signoff_role()"],
  ] as const) {
    await db.exec(functionFrom(await migration(file), marker));
  }
  await db.exec(`
    create trigger cma_guard_video_client_signoff_role
      before update of human_approved_at on public.client_media_assets
      for each row execute function public.guard_video_client_signoff_role();
    alter table public.clients enable row level security;
    alter table public.team_members enable row level security;
    alter table public.client_assignments enable row level security;
    alter table public.job_assignments enable row level security;
    alter table public.client_media_assets enable row level security;
    alter table storage.objects enable row level security;
    create policy clients_admin_all on public.clients for all to authenticated
      using(public.is_admin()) with check(public.is_admin());
    create policy clients_scoped_read on public.clients for select to authenticated
      using(public.can_access_client(id));
    create policy clients_former_assignee_read on public.clients for select to authenticated
      using(exists(select 1 from public.client_assignments ca
        join public.team_members tm on tm.id=ca.member_id
        where tm.user_id=auth.uid() and ca.client_id=clients.id and ca.ended_at is not null));
    create policy team_members_admin_all on public.team_members for all to authenticated
      using(public.is_admin()) with check(public.is_admin());
    create policy team_members_self_read on public.team_members for select to authenticated
      using(user_id=auth.uid() and active);
    create policy team_members_editor_for_smm_read on public.team_members for select to authenticated
      using(category='editors' and active and public.is_active_assigned_smm());
    create policy client_assignments_self_read on public.client_assignments for select to authenticated
      using(public.is_member(member_id));
    create policy job_assignments_self_read on public.job_assignments for select to authenticated
      using(public.is_member(member_id));
    create policy cma_smm_video_read on public.client_media_assets for select to authenticated
      using(media_type='video' and auth.uid()=public.active_video_approval_manager(client_id));
    create policy cma_client_read on public.client_media_assets for select to authenticated
      using(public.is_client_user(client_id));
    create policy media_obj_smm_video_read on storage.objects for select to authenticated
      using(bucket_id='client-media' and auth.uid()=public.active_video_approval_manager(
        public.try_uuid((storage.foldername(name))[1])));
    create policy media_obj_client_read on storage.objects for select to authenticated
      using(bucket_id='client-media' and public.is_client_user(
        public.try_uuid((storage.foldername(name))[1])));
    create policy media_obj_employee_insert on storage.objects for insert to authenticated
      with check(bucket_id='client-media' and public.can_access_client(
        public.try_uuid((storage.foldername(name))[1])));
    grant select on all tables in schema public to authenticated,service_role;
    grant select,insert,update on storage.objects to authenticated,service_role;
    grant insert on public.video_approval_signoffs to authenticated,service_role;
    grant execute on all functions in schema public to authenticated,service_role;
    grant execute on all functions in schema auth,storage to authenticated,service_role;
  `);

  // Establish that the fixture actually reproduces the unsafe prior paths.
  expect((await asRole<{ ok: boolean }>("authenticated", CLIENT_SMM,
    "select public.can_access_client($1) ok", [B]))[0]?.ok).toBe(true);
  expect((await asRole<{ id: string }>("authenticated", CLIENT_SMM,
    "select id from public.team_members where category='editors'"))).toHaveLength(1);
  expect((await asRole<{ user_id: string }>("authenticated", CLIENT_SMM,
    "select public.active_video_approval_manager($1) user_id", [B]))[0]?.user_id)
    .toBe(CLIENT_SMM);

  await db.exec(await migration("20261101150000_298_current_employee_role_entitlement.sql"));
}, 60_000);

afterAll(async () => { await db?.close(); });

describe.sequential("conditional migration 298 employee assignment scope", () => {
  it("keeps same-client client authority but denies staff and cross-client paths", async () => {
    expect((await asRole<{ ok: boolean }>("authenticated", CLIENT_SMM,
      "select public.can_access_client($1) ok", [A]))[0]?.ok).toBe(true);
    expect((await asRole<{ ok: boolean }>("authenticated", CLIENT_SMM,
      "select public.can_access_client($1) ok", [B]))[0]?.ok).toBe(false);
    expect((await asRole<{ id: string }>("authenticated", CLIENT_SMM,
      "select public.accessible_client_ids() id"))).toEqual([{ id: A }]);
    expect((await asRole<{ ok: boolean }>("authenticated", CLIENT_SMM,
      "select public.is_member($1) ok", [M_CLIENT_SMM]))[0]?.ok).toBe(false);
    expect((await asRole<{ id: string | null }>("authenticated", CLIENT_SMM,
      "select public.current_member_id() id"))[0]?.id).toBeNull();
    expect((await asRole("authenticated", CLIENT_SMM,
      "select id from public.clients order by id"))).toEqual([{ id: A }]);
    expect(await asRole("authenticated", CLIENT_SMM,
      "select id from public.team_members")).toHaveLength(0);
    expect(await asRole("authenticated", CLIENT_SMM,
      "select id from public.job_assignments")).toHaveLength(0);
    expect(await asRole("authenticated", CLIENT_SMM,
      "select id from storage.objects where name like $1", [`${B}/%`])).toHaveLength(0);
    expect(await asRole("authenticated", CLIENT_SMM,
      "select id from storage.objects where name like $1", [`${A}/%`])).toHaveLength(1);
    await expect(asRole("authenticated", CLIENT_SMM,
      "insert into storage.objects(id,bucket_id,name,owner) values ($1,'client-media',$2,$3)",
      ["bbbb0004-2222-4222-8222-222222222222", `${B}/new.mp4`, CLIENT_SMM]))
      .rejects.toThrow(/row-level security/i);
    await asRole("authenticated", CLIENT_SMM,
      "insert into storage.objects(id,bucket_id,name,owner) values ($1,'client-media',$2,$3)",
      ["aaaa0005-1111-4111-8111-111111111111", `${A}/new.mp4`, CLIENT_SMM]);
    expect((await asRole<{ ok: boolean }>("authenticated", CLIENT_SMM,
      "select public.is_active_assigned_smm() ok"))[0]?.ok).toBe(false);
  });

  it("retains employee, active former-assignee, admin, and client-signoff behavior", async () => {
    expect((await asRole<{ ok: boolean }>("authenticated", EDITOR,
      "select public.can_access_client($1) ok", [B]))[0]?.ok).toBe(true);
    expect((await asRole<{ ok: boolean }>("authenticated", EDITOR,
      "select public.is_member($1) ok", [M_EDITOR]))[0]?.ok).toBe(true);
    expect(await asRole("authenticated", EDITOR,
      "select id from public.job_assignments")).toHaveLength(1);
    expect((await asRole<{ ok: boolean }>("authenticated", SMM,
      "select public.is_active_assigned_smm() ok"))[0]?.ok).toBe(true);
    expect(await asRole("authenticated", SMM,
      "select id from public.team_members where category='editors'"))
      .toHaveLength(1);
    expect(await asRole("authenticated", EDITOR,
      "select id from public.clients where id=$1", [C])).toHaveLength(1);
    expect(await asRole("authenticated", RETIRED,
      "select id from public.clients where id=$1", [C])).toHaveLength(0);
    expect((await asRole<{ id: string | null }>("authenticated", RETIRED,
      "select public.current_member_id() id"))[0]?.id).toBeNull();
    expect(await asRole("authenticated", ADMIN,
      "select id from public.clients")).toHaveLength(3);
    expect((await asRole<{ ok: boolean }>("authenticated", ADMIN,
      "select public.can_access_client($1) ok", [B]))[0]?.ok).toBe(true);
    expect((await asRole<{ ok: boolean }>("authenticated", CLIENT_SMM,
      "select public.is_client_user($1) ok", [A]))[0]?.ok).toBe(true);
    await asRole("authenticated", CLIENT_SMM,
      "select public.sign_video_approval($1,'client')", [VIDEO_A]);
    expect((await db.query("select * from public.video_approval_signoffs where asset_id=$1", [VIDEO_A])).rows)
      .toHaveLength(1);
  });

  it("does not revive an older manager or director behind a latest invalid seat", async () => {
    expect((await asRole<{ user_id: string | null }>("authenticated", CLIENT_SMM,
      "select public.active_video_approval_manager($1) user_id", [B]))[0]?.user_id)
      .toBeNull();
    expect((await asRole<{ user_id: string | null }>("authenticated", CLIENT_DIRECTOR,
      "select public.active_creative_director($1) user_id", [B]))[0]?.user_id)
      .toBeNull();
    expect((await asRole<{ seat: string }>("authenticated", CLIENT_DIRECTOR,
      "select public.creative_seat_of($1,$2) seat", [B, CLIENT_DIRECTOR]))[0]?.seat)
      .toBe("other");
    expect((await asRole<{ user_id: string | null }>("service_role", "",
      "select public.active_video_approval_manager($1) user_id", [C]))[0]?.user_id)
      .toBe(SMM);
    expect((await asRole<{ user_id: string | null }>("service_role", "",
      "select public.active_creative_director($1) user_id", [C]))[0]?.user_id)
      .toBe(DIRECTOR);
  });

  it("blocks former client-profile manager RPCs and final writes", async () => {
    await expect(asRole("authenticated", CLIENT_SMM,
      "select public.sign_video_approval($1,'manager')", [VIDEO_B]))
      .rejects.toThrow(/another account/i);
    await expect(db.query("update public.client_media_assets set human_approved_at=now() where id=$1", [VIDEO_B]))
      .rejects.toThrow(/employee SMM|no longer a current employee/i);
    await db.query("update public.client_media_assets set human_approved_at=now() where id=$1", [VIDEO_C]);
    expect((await db.query("select human_approved_at from public.client_media_assets where id=$1", [VIDEO_C])).rows[0])
      .toHaveProperty("human_approved_at");
  });

  it("rechecks employee role at read time after drift", async () => {
    await db.query("update public.profiles set role='client' where id=$1", [SMM]);
    try {
      expect((await asRole<{ user_id: string | null }>("authenticated", SMM,
        "select public.active_video_approval_manager($1) user_id", [C]))[0]?.user_id)
        .toBeNull();
      expect((await asRole<{ ok: boolean }>("authenticated", SMM,
        "select public.can_access_client($1) ok", [C]))[0]?.ok).toBe(false);
      expect((await asRole<{ user_id: string | null }>("service_role", "",
        "select public.active_video_approval_manager($1) user_id", [C]))[0]?.user_id)
        .toBeNull();
    } finally {
      await db.query("update public.profiles set role='employee' where id=$1", [SMM]);
    }
  });

  it("denies profileless and anonymous helper calls", async () => {
    expect((await asRole<{ ok: boolean }>("authenticated", PROFILELESS,
      "select public.can_access_client($1) ok", [B]))[0]?.ok).toBe(false);
    expect((await asRole<{ id: string | null }>("authenticated", PROFILELESS,
      "select public.current_member_id() id"))[0]?.id).toBeNull();
    await expect(asRole("anon", "", "select public.can_access_client($1)", [B]))
      .rejects.toThrow(/permission denied/i);
  });
});
