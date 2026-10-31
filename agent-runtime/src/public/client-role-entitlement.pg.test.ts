import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DUAL_EMPLOYEE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ASSIGNED_EMPLOYEE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SMM = "99999999-9999-4999-8999-999999999999";
const PROFILELESS = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ASSET_A = "55555555-5555-4555-8555-555555555555";

let db: PGlite;

async function asRole(role: "authenticated" | "anon" | "service_role", user = "") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec(`set role ${role}`);
}

async function ids(sql: string) {
  return (await db.query<{ client_id: string }>(sql)).rows.map((row) => row.client_id);
}

async function access(client: string) {
  return (await db.query<{ member: boolean; broad: boolean }>(
    "select public.is_client_user($1) member, public.can_access_client($1) broad", [client],
  )).rows[0]!;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role',true) $$;
    create function storage.foldername(p text) returns text[] language sql stable as
      $$ select string_to_array(p,'/') $$;
    create function public.try_uuid(p text) returns uuid language sql stable as
      $$ select nullif(p,'')::uuid $$;
    create type public.app_role as enum ('admin','employee','client');
    create table public.profiles(id uuid primary key,role public.app_role not null,
      full_name text,email text);
    create table public.clients(id uuid primary key);
    create table public.client_users(client_id uuid not null,user_id uuid not null,
      primary key(client_id,user_id));
    create table public.team_members(id uuid primary key,user_id uuid,active boolean,
      category text,name text);
    create table public.client_assignments(id uuid primary key,member_id uuid,
      client_id uuid,ended_at timestamptz,created_at timestamptz default now());
    create table public.job_assignments(id uuid primary key,member_id uuid,
      client_id uuid);
    create table public.client_media_assets(id uuid primary key,client_id uuid,
      member_id uuid,media_type text,edit_stage text,human_approved_at timestamptz,
      render_path text,storage_path text);
    create table public.client_onboarding_steps(client_id uuid,step_key text,
      status text,primary key(client_id,step_key));
    create table public.client_contracts(id uuid primary key,client_id uuid);
    create table public.client_billing(id uuid primary key,client_id uuid);
    create table public.client_leads(id uuid primary key,client_id uuid,contact text);
    create table storage.objects(id uuid primary key,bucket_id text,name text,owner uuid);
    create table public.content_approval_settings(singleton boolean primary key,
      owner_user_id uuid);
    create table public.video_client_approval_requests(asset_id uuid primary key,
      client_user_id uuid,requested_by uuid,requested_at timestamptz default now(),
      rejected_at timestamptz,rejection_reason text);
    create table public.video_approval_signoffs(asset_id uuid,approval_role text,
      user_id uuid,render_path text,signed_at timestamptz default now(),
      primary key(asset_id,approval_role));
    insert into public.profiles values
      ('${ADMIN}','admin','Admin',null),
      ('${CLIENT_A}','client','Client A',null),
      ('${CLIENT_B}','client','Client B',null),
      ('${DUAL_EMPLOYEE}','employee','Former client user',null),
      ('${ASSIGNED_EMPLOYEE}','employee','Editor',null),
      ('${SMM}','employee','SMM',null);
    insert into public.clients values ('${A}'),('${B}');
    insert into public.client_users values
      ('${A}','${CLIENT_A}'),('${B}','${CLIENT_B}'),('${A}','${DUAL_EMPLOYEE}');
  `);
  await db.exec(`
    insert into public.team_members values
      ('77777777-7777-4777-8777-777777777777','${ASSIGNED_EMPLOYEE}',true,'editors','Editor'),
      ('88888888-8888-4888-8888-888888888888','${SMM}',true,'smm','SMM');
    insert into public.job_assignments values
      ('66666666-6666-4666-8666-666666666666',
       '77777777-7777-4777-8777-777777777777','${A}');
    insert into public.client_assignments values
      ('44444444-4444-4444-8444-444444444444',
       '88888888-8888-4888-8888-888888888888','${A}',null,now());
    insert into public.client_media_assets values
      ('${ASSET_A}','${A}',null,'video','review_ready',null,'A/render.mp4',null),
      ('33333333-3333-4333-8333-333333333333','${B}',null,'image','review_ready',null,null,'B/image.png');
    insert into public.client_onboarding_steps values
      ('${A}','onboarding_form','pending'),('${B}','onboarding_form','pending');
    insert into public.client_contracts values
      ('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${A}'),
      ('22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${B}');
    insert into public.client_billing values
      ('11111111-cccc-4ccc-8ccc-cccccccccccc','${A}'),
      ('22222222-dddd-4ddd-8ddd-dddddddddddd','${B}');
    insert into public.client_leads values
      ('11111111-1111-4111-8111-aaaaaaaaaaaa','${A}','A contact'),
      ('22222222-2222-4222-8222-bbbbbbbbbbbb','${B}','B contact');
    insert into storage.objects values
      ('11111111-eeee-4eee-8eee-eeeeeeeeeeee','contracts','${A}/contract.pdf',null),
      ('22222222-ffff-4fff-8fff-ffffffffffff','contracts','${B}/contract.pdf',null),
      ('33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa','client-media','${A}/media.png',null),
      ('44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb','client-media','${B}/media.png',null);
    insert into public.content_approval_settings values (true,'${ADMIN}');
    insert into public.video_client_approval_requests(asset_id,client_user_id,requested_by)
      values ('${ASSET_A}','${DUAL_EMPLOYEE}','${SMM}');
    insert into public.video_approval_signoffs(asset_id,approval_role,user_id,render_path)
      values ('${ASSET_A}','client','${DUAL_EMPLOYEE}','A/render.mp4');
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
    create function public.may_manage_client_leads(target uuid) returns boolean
      language sql stable security definer set search_path='' as $$
        select coalesce(auth.role()='service_role',false)
          or public.is_admin() or public.is_client_user(target) $$;
    create function public.can_access_client(target uuid) returns boolean
      language sql stable security definer set search_path='' as $$
        select public.is_admin() or public.is_client_user(target) or exists(
          select 1 from public.job_assignments ja join public.team_members tm
            on tm.id=ja.member_id where ja.client_id=target and tm.user_id=auth.uid()
              and tm.active) or exists(
          select 1 from public.client_assignments ca join public.team_members tm
            on tm.id=ca.member_id where ca.client_id=target and tm.user_id=auth.uid()
              and tm.active and ca.ended_at is null) $$;
    create function public.accessible_client_ids() returns setof uuid
      language sql stable security definer set search_path='' as $$
        select cu.client_id from public.client_users cu where cu.user_id=auth.uid()
        union select ja.client_id from public.job_assignments ja
          join public.team_members tm on tm.id=ja.member_id
         where tm.user_id=auth.uid() and tm.active $$;
    create function public.active_video_approval_manager(p_client_id uuid) returns uuid
      language sql stable security definer set search_path='' as $$
        select tm.user_id from public.client_assignments ca
          join public.team_members tm on tm.id=ca.member_id
         where ca.client_id=p_client_id and ca.ended_at is null
           and tm.active and tm.category='smm' limit 1 $$;
    create function public.active_creative_director(uuid) returns uuid
      language sql stable as $$select null::uuid$$;
    create function public.my_account_team() returns table(name text,category text)
      language sql stable security definer set search_path='' as $$
        select tm.name,tm.category from public.client_assignments ca
          join public.team_members tm on tm.id=ca.member_id
         where ca.client_id in (select cu.client_id from public.client_users cu
                                where cu.user_id=auth.uid())
           and ca.ended_at is null and tm.active $$;
    alter table public.client_users enable row level security;
    alter table public.client_media_assets enable row level security;
    alter table public.client_onboarding_steps enable row level security;
    alter table public.client_contracts enable row level security;
    alter table public.client_billing enable row level security;
    alter table public.client_leads enable row level security;
    alter table storage.objects enable row level security;
    create policy client_users_self_read on public.client_users
      for select to authenticated using(user_id=auth.uid());
    create policy client_users_admin_all on public.client_users
      for all to authenticated using(public.is_admin()) with check(public.is_admin());
    create policy cma_client_read on public.client_media_assets
      for select to authenticated using(exists(select 1 from public.client_users cu
        where cu.user_id=auth.uid() and cu.client_id=client_media_assets.client_id));
    create policy cma_admin_read on public.client_media_assets
      for select to authenticated using(public.is_admin());
    create policy cos_client_update on public.client_onboarding_steps
      for update to authenticated using(exists(select 1 from public.client_users cu
        where cu.user_id=auth.uid() and cu.client_id=client_id)) with check(true);
    create policy cos_fixture_read on public.client_onboarding_steps
      for select to authenticated using(true);
    create policy cc_client_read on public.client_contracts
      for select to authenticated using(exists(select 1 from public.client_users cu
        where cu.user_id=auth.uid() and cu.client_id=client_contracts.client_id));
    create policy cc_admin_read on public.client_contracts
      for select to authenticated using(public.is_admin());
    create policy cbill_client_read on public.client_billing
      for select to authenticated using(exists(select 1 from public.client_users cu
        where cu.user_id=auth.uid() and cu.client_id=client_billing.client_id));
    create policy cbill_admin_read on public.client_billing
      for select to authenticated using(public.is_admin());
    create policy leads_client_read on public.client_leads
      for select to authenticated using(public.is_client_user(client_id));
    create policy contracts_obj_client_read on storage.objects
      for select to authenticated using(bucket_id='contracts'
        and exists(select 1 from public.client_users cu where cu.user_id=auth.uid()
          and cu.client_id=public.try_uuid((storage.foldername(name))[1])));
    create policy media_obj_client_read on storage.objects
      for select to authenticated using(bucket_id='client-media'
        and exists(select 1 from public.client_users cu where cu.user_id=auth.uid()
          and cu.client_id=public.try_uuid((storage.foldername(name))[1])));
    create policy objects_admin_read on storage.objects
      for select to authenticated using(public.is_admin());
    grant select on public.client_users,public.client_media_assets,
      public.client_onboarding_steps,public.client_contracts,public.client_billing,public.client_leads,
      storage.objects to authenticated;
    grant update(status) on public.client_onboarding_steps to authenticated;
    grant select on public.client_users,public.client_media_assets,
      public.client_onboarding_steps,public.client_contracts,public.client_billing,public.client_leads,
      storage.objects to service_role;
  `);

  // First prove the old dual-role path reaches commercial and Storage data.
  await asRole("authenticated", DUAL_EMPLOYEE);
  expect(await access(A)).toEqual({ member: true, broad: true });
  expect(await ids("select client_id from public.client_contracts")).toEqual([A]);
  expect(await ids("select client_id from public.client_leads")).toEqual([A]);
  expect((await db.query<{ ok: boolean }>("select public.may_manage_client_leads($1) ok", [A])).rows[0]?.ok).toBe(true);
  expect((await db.query("select name from storage.objects")).rows).toHaveLength(2);
  expect((await db.query("select * from public.my_account_team()")).rows).toHaveLength(1);

  await db.exec("reset role");
  await db.exec(await readFile(new URL(
    "../../../supabase/migrations/20261101130000_299_current_client_role_entitlement.sql",
    import.meta.url,
  ), "utf8"));
}, 60000);

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec(`reset role;
    update public.profiles set role='client' where id in ('${CLIENT_A}','${CLIENT_B}');
    update public.profiles set role='employee' where id in ('${DUAL_EMPLOYEE}','${ASSIGNED_EMPLOYEE}','${SMM}');
    update public.client_onboarding_steps set status='pending';
  `);
});

describe("conditional migration 296 client-profile entitlement", () => {
  it("removes every raw membership read/write route from a dual-role employee", async () => {
    await asRole("authenticated", DUAL_EMPLOYEE);
    expect(await access(A)).toEqual({ member: false, broad: false });
    expect((await db.query("select * from public.accessible_client_ids()")).rows).toHaveLength(0);
    for (const table of ["client_users", "client_media_assets", "client_contracts", "client_billing"]) {
      expect((await db.query(`select * from public.${table}`)).rows, table).toHaveLength(0);
    }
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(0);
    expect((await db.query("select * from public.client_leads")).rows).toHaveLength(0);
    expect((await db.query<{ ok: boolean }>("select public.may_manage_client_leads($1) ok", [A])).rows[0]?.ok).toBe(false);
    expect((await db.query("select * from public.my_account_team()")).rows).toHaveLength(0);
    expect((await db.query("update public.client_onboarding_steps set status='complete' where client_id=$1 returning status", [A])).rows).toHaveLength(0);
    expect((await db.query<{ seat: string }>("select public.creative_seat_of($1,$2) seat", [A, DUAL_EMPLOYEE])).rows[0]?.seat).toBe("other");
  });

  it("preserves a current same-client account across both tables and Storage", async () => {
    await asRole("authenticated", CLIENT_A);
    expect(await access(A)).toEqual({ member: true, broad: true });
    expect(await access(B)).toEqual({ member: false, broad: false });
    expect((await db.query<{ accessible_client_ids: string }>("select * from public.accessible_client_ids()")).rows.map((r) => r.accessible_client_ids)).toEqual([A]);
    expect(await ids("select client_id from public.client_media_assets")).toEqual([A]);
    expect(await ids("select client_id from public.client_contracts")).toEqual([A]);
    expect(await ids("select client_id from public.client_billing")).toEqual([A]);
    expect(await ids("select client_id from public.client_leads")).toEqual([A]);
    expect((await db.query<{ ok: boolean }>("select public.may_manage_client_leads($1) ok", [A])).rows[0]?.ok).toBe(true);
    expect((await db.query("select * from public.client_users")).rows).toHaveLength(1);
    expect((await db.query("select name from storage.objects")).rows).toHaveLength(2);
    expect((await db.query("select * from public.my_account_team()")).rows).toHaveLength(1);
    expect((await db.query("update public.client_onboarding_steps set status='complete' where client_id=$1 returning status", [A])).rows).toHaveLength(1);
    expect((await db.query("update public.client_onboarding_steps set status='complete' where client_id=$1 returning status", [B])).rows).toHaveLength(0);
  });

  it("preserves active employee assignment access without reviving stale client membership", async () => {
    await asRole("authenticated", ASSIGNED_EMPLOYEE);
    expect(await access(A)).toEqual({ member: false, broad: true });
    expect((await db.query<{ accessible_client_ids: string }>("select * from public.accessible_client_ids()")).rows.map((r) => r.accessible_client_ids)).toEqual([A]);
    expect((await db.query("select * from public.client_contracts")).rows).toHaveLength(0);
    await db.exec(`reset role; update public.team_members set active=false where user_id='${ASSIGNED_EMPLOYEE}'`);
    await asRole("authenticated", ASSIGNED_EMPLOYEE);
    expect(await access(A)).toEqual({ member: false, broad: false });
    await db.exec(`reset role; update public.team_members set active=true where user_id='${ASSIGNED_EMPLOYEE}'`);
  });

  it("rechecks profile role at read time without deleting historical membership", async () => {
    await asRole("authenticated", CLIENT_A);
    expect((await db.query("select * from public.client_billing")).rows).toHaveLength(1);
    await db.exec(`reset role; update public.profiles set role='employee' where id='${CLIENT_A}'`);
    await asRole("authenticated", CLIENT_A);
    expect(await access(A)).toEqual({ member: false, broad: false });
    expect((await db.query("select * from public.client_billing")).rows).toHaveLength(0);
    await db.exec(`reset role; update public.profiles set role='client' where id='${CLIENT_A}'`);
    await asRole("authenticated", CLIENT_A);
    expect(await access(A)).toEqual({ member: true, broad: true });
  });

  it("keeps admin and service paths but denies profileless and anon", async () => {
    await asRole("authenticated", ADMIN);
    expect((await db.query("select * from public.client_contracts")).rows).toHaveLength(2);
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(4);
    await asRole("service_role");
    expect((await db.query("select * from public.client_contracts")).rows).toHaveLength(2);
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(4);
    await asRole("authenticated", PROFILELESS);
    expect(await access(A)).toEqual({ member: false, broad: false });
    expect((await db.query("select * from public.client_contracts")).rows).toHaveLength(0);
    await asRole("anon");
    await expect(db.query("select * from public.client_contracts")).rejects.toThrow(/permission denied/i);
  });

  it("invalidates old client signoff and rejects stale account nomination or action", async () => {
    await asRole("authenticated", ADMIN);
    const old = (await db.query<{ state: { client_approved: boolean } }>(
      "select public.video_approval_state($1) state", [ASSET_A],
    )).rows[0]!.state;
    expect(old.client_approved).toBe(false);
    await asRole("authenticated", SMM);
    const accounts = (await db.query<{ state: { client_accounts: Array<{ id: string }> } }>(
      "select public.video_approval_state($1) state", [ASSET_A],
    )).rows[0]!.state.client_accounts.map((account) => account.id);
    expect(accounts).toEqual([CLIENT_A]);
    await expect(db.query("select public.request_video_client_approval($1,$2)", [ASSET_A, DUAL_EMPLOYEE])).rejects.toThrow(/current client account/i);
    await db.query("select public.request_video_client_approval($1,$2)", [ASSET_A, CLIENT_A]);
    await asRole("authenticated", CLIENT_A);
    await db.query("select public.sign_video_approval($1,'client')", [ASSET_A]);
    expect((await db.query<{ state: { client_approved: boolean } }>(
      "select public.video_approval_state($1) state", [ASSET_A],
    )).rows[0]!.state.client_approved).toBe(true);
    await db.exec(`reset role; update public.profiles set role='employee' where id='${CLIENT_A}'`);
    await asRole("authenticated", CLIENT_A);
    await expect(db.query("select public.sign_video_approval($1,'client')", [ASSET_A])).rejects.toThrow(/current client account/i);
    await expect(db.query("select public.decline_video_client_approval($1,'no')", [ASSET_A])).rejects.toThrow(/current client account/i);
    await asRole("authenticated", ADMIN);
    expect((await db.query<{ state: { client_approved: boolean } }>(
      "select public.video_approval_state($1) state", [ASSET_A],
    )).rows[0]!.state.client_approved).toBe(false);
    await db.exec("reset role");
    await expect(db.query(
      "update public.client_media_assets set human_approved_at=now() where id=$1", [ASSET_A],
    )).rejects.toThrow(/nominated client account is no longer current/i);
    await db.exec(`update public.profiles set role='client' where id='${CLIENT_A}'`);
    await db.query("update public.client_media_assets set human_approved_at=now() where id=$1", [ASSET_A]);
  });
});
