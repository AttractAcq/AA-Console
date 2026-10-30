-- ============================================================
-- AA Console · 11 · Auth users + trusted profile roles
--
-- A new user's editable Auth metadata must not choose their Console role.
-- Trusted account provisioning assigns the role on public.profiles after
-- Auth inserts the user. Employees carry a second trusted profile field,
-- employee_category, for their Employee console (SMM / editor / avatar).
--
-- Client and employee accounts sign in by USERNAME. Supabase auth is
-- email-based, so the frontend maps <username> -> <username>@attractacq.com.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- profiles carry the employee sub-role ----------
alter table profiles add column if not exists employee_category team_category;

-- ---------- role now comes from metadata ----------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, role, employee_category)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    'employee'::public.app_role,
    null
  )
  on conflict (id) do update
    set email     = excluded.email,
        full_name = coalesce(excluded.full_name, public.profiles.full_name);
  return new;
end;
$$;
revoke execute on function handle_new_user() from authenticated, anon, public;

-- ---------- account creation helper ----------
create or replace function create_console_user(
  p_email     text,
  p_password  text,
  p_role      app_role,
  p_full_name text,
  p_category  team_category default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from auth.users where email = lower(p_email);

  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      lower(p_email), extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object(
        'full_name', p_full_name,
        'role', p_role::text,
        'employee_category', coalesce(p_category::text, '')
      ),
      now(), now(), '', '', '', ''
    );

    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_id,
      jsonb_build_object('sub', v_id::text, 'email', lower(p_email), 'email_verified', true),
      'email', v_id::text, now(), now(), now()
    );
  end if;

  -- An existing account owns its Auth credentials and metadata. Repeated
  -- provisioning may reconcile its trusted profile, never its password.

  insert into public.profiles (id, email, full_name, role, employee_category)
  values (v_id, lower(p_email), p_full_name, p_role, p_category)
  on conflict (id) do update
    set email = excluded.email, full_name = excluded.full_name,
        role = excluded.role, employee_category = excluded.employee_category;

  return v_id;
end;
$$;
revoke execute on function create_console_user(text, text, app_role, text, team_category)
  from authenticated, anon, public;

-- ============================================================
-- The five accounts
--
-- Passwords are NOT stored here. Per-account database settings may supply
-- distinct strong one-time bootstrap secrets; without them each new account
-- receives a random 32-byte password. Recover access through the approved
-- Auth reset/invitation path; never rely on a committed or shared default.
--
--   select set_config('app.seed_admin_password',    '<secret>', false);
--   select set_config('app.seed_client_password',   '<secret>', false);
--   select set_config('app.seed_smm_password',      '<secret>', false);
--   select set_config('app.seed_editor_password',   '<secret>', false);
--   select set_config('app.seed_avatar_password',   '<secret>', false);
--
-- Migration 11 is already recorded in production. This source correction
-- affects fresh replays only; it does not re-run against that project.
-- ============================================================
do $$
declare
  v_admin   uuid;
  v_client  uuid;
  v_smm     uuid;
  v_editor  uuid;
  v_avatar  uuid;
  v_aa      uuid;
  v_seed_admin  text := nullif(current_setting('app.seed_admin_password', true), '');
  v_seed_client text := nullif(current_setting('app.seed_client_password', true), '');
  v_seed_smm    text := nullif(current_setting('app.seed_smm_password', true), '');
  v_seed_editor text := nullif(current_setting('app.seed_editor_password', true), '');
  v_seed_avatar text := nullif(current_setting('app.seed_avatar_password', true), '');
  v_seed       text;
  v_count      integer;
  v_unique     integer;
begin
  -- An email match is not proof that an account was created by this seed.
  -- A pre-registered or unconfirmed user must never inherit these roles.
  -- A repeat replay also stops before touching any existing Auth account.
  if exists (
    select 1 from auth.users
     where lower(email) in (
       'alex@attractacq.com', 'attractacquisition@attractacq.com',
       'smm1@attractacq.com', 'editor1@attractacq.com',
       'avatar1@attractacq.com'
     )
  ) then
    raise exception 'Seed email already exists; review Auth provenance before provisioning';
  end if;

  if nullif(current_setting('app.seed_employee_password', true), '') is not null then
    raise exception 'Shared employee seed password is unsupported; use per-account settings';
  end if;

  foreach v_seed in array array[
    v_seed_admin, v_seed_client, v_seed_smm, v_seed_editor, v_seed_avatar
  ] loop
    if v_seed is not null and length(v_seed) < 16 then
      raise exception 'Seed account passwords must be at least 16 characters';
    end if;
  end loop;

  select count(*), count(distinct configured_password)
    into v_count, v_unique
    from unnest(array[
      v_seed_admin, v_seed_client, v_seed_smm, v_seed_editor, v_seed_avatar
    ]) as configured(configured_password)
   where configured_password is not null;
  if v_count <> v_unique then
    raise exception 'Seed account passwords must be distinct per account';
  end if;

  select id into v_aa from clients where initials = 'AA' limit 1;

  v_admin  := create_console_user('alex@attractacq.com',              coalesce(v_seed_admin, encode(extensions.gen_random_bytes(32), 'hex')), 'admin',    'Alex Thomas');
  v_client := create_console_user('attractacquisition@attractacq.com',coalesce(v_seed_client, encode(extensions.gen_random_bytes(32), 'hex')), 'client',   'Attract Acquisition');
  v_smm    := create_console_user('smm1@attractacq.com',              coalesce(v_seed_smm, encode(extensions.gen_random_bytes(32), 'hex')), 'employee', 'SMM 1',    'smm');
  v_editor := create_console_user('editor1@attractacq.com',           coalesce(v_seed_editor, encode(extensions.gen_random_bytes(32), 'hex')), 'employee', 'Editor 1', 'editors');
  v_avatar := create_console_user('avatar1@attractacq.com',           coalesce(v_seed_avatar, encode(extensions.gen_random_bytes(32), 'hex')), 'employee', 'Avatar 1', 'avatars');

  -- the client account is scoped to Attract Acquisition
  if v_aa is not null then
    insert into client_users (client_id, user_id)
    values (v_aa, v_client)
    on conflict do nothing;
  end if;

  -- each employee gets a team_members row, linked by user_id
  insert into team_members (user_id, category, name, initials, engagement) values
    (v_smm,    'smm',     'SMM 1',    'S1', 'employee'),
    (v_editor, 'editors', 'Editor 1', 'E1', 'employee'),
    (v_avatar, 'avatars', 'Avatar 1', 'A1', 'employee')
  on conflict (user_id) do update
    set category = excluded.category,
        name     = excluded.name,
        initials = excluded.initials;

  -- give the employees something to be scoped to
  if v_aa is not null then
    insert into client_assignments (member_id, client_id)
    select tm.id, v_aa from team_members tm where tm.user_id = v_smm
    on conflict (member_id, client_id) do nothing;
  end if;
end;
$$;;
