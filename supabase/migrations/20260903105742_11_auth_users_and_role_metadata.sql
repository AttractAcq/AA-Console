-- ============================================================
-- AA Console · 11 · Auth users + metadata-driven roles
--
-- Role lives in auth.users.raw_user_meta_data and is mirrored onto
-- profiles by handle_new_user(). Employees carry a second metadata
-- key, employee_category, which decides which Employee console they
-- see (SMM / editor / avatar).
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
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role, employee_category)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    coalesce((new.raw_user_meta_data ->> 'role')::app_role, 'employee'),
    nullif(new.raw_user_meta_data ->> 'employee_category', '')::team_category
  )
  on conflict (id) do update
    set email             = excluded.email,
        full_name         = coalesce(excluded.full_name, profiles.full_name),
        role              = excluded.role,
        employee_category = excluded.employee_category;
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
set search_path = public, auth, extensions
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
  else
    -- keep an existing account's password and metadata in step
    update auth.users set
      encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      raw_user_meta_data = jsonb_build_object(
        'full_name', p_full_name,
        'role', p_role::text,
        'employee_category', coalesce(p_category::text, '')
      ),
      updated_at = now()
    where id = v_id;
  end if;

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
-- Passwords are NOT stored here. Each is read from a database setting so
-- this file can live in version control; without the settings a fresh
-- environment gets 'change-me' and you rotate from the console.
--
--   select set_config('app.seed_admin_password',    '<secret>', false);
--   select set_config('app.seed_client_password',   '<secret>', false);
--   select set_config('app.seed_employee_password', '<secret>', false);
--
-- The live project already has these accounts with their real passwords;
-- re-running this without the settings would reset them to 'change-me'.
-- ============================================================
do $$
declare
  v_admin   uuid;
  v_client  uuid;
  v_smm     uuid;
  v_editor  uuid;
  v_avatar  uuid;
  v_aa      uuid;
begin
  select id into v_aa from clients where initials = 'AA' limit 1;

  v_admin  := create_console_user('alex@attractacq.com',              coalesce(current_setting('app.seed_admin_password', true), 'change-me'), 'admin',    'Alex Thomas');
  v_client := create_console_user('attractacquisition@attractacq.com',coalesce(current_setting('app.seed_client_password', true), 'change-me'), 'client',   'Attract Acquisition');
  v_smm    := create_console_user('smm1@attractacq.com',              coalesce(current_setting('app.seed_employee_password', true), 'change-me'), 'employee', 'SMM 1',    'smm');
  v_editor := create_console_user('editor1@attractacq.com',           coalesce(current_setting('app.seed_employee_password', true), 'change-me'), 'employee', 'Editor 1', 'editors');
  v_avatar := create_console_user('avatar1@attractacq.com',           coalesce(current_setting('app.seed_employee_password', true), 'change-me'), 'employee', 'Avatar 1', 'avatars');

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
