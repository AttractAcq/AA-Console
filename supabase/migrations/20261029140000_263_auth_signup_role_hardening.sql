-- 263 · A new Auth user's editable metadata must not choose console privileges.
-- Migration 11 let raw_user_meta_data.role become profiles.role on signup.
-- Supabase users can set raw_user_meta_data themselves, so only a trusted
-- server-side provisioning path may promote or assign a client role.
-- create_console_user() explicitly upserts the intended role after its Auth
-- insert fires this trigger; its function grants remain restricted.
create or replace function public.handle_new_user()
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

-- CREATE OR REPLACE preserves the existing trigger and function privileges.
-- Reassert the intended function boundary for databases with grant drift.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Migration 11's provisioning helper also reset an existing account's Auth
-- password and user-editable metadata whenever a seed or admin form called
-- it again. Keep Auth creation for a genuinely new account, but treat an
-- existing account's credentials and metadata as owned by Supabase Auth.
-- Trusted provisioning still updates the authoritative profile fields.
create or replace function public.create_console_user(
  p_email     text,
  p_password  text,
  p_role      public.app_role,
  p_full_name text,
  p_category  public.team_category default null
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
      '00000000-0000-0000-0000-000000000000', v_id,
      'authenticated', 'authenticated', lower(p_email),
      extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
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

  insert into public.profiles (id, email, full_name, role, employee_category)
  values (v_id, lower(p_email), p_full_name, p_role, p_category)
  on conflict (id) do update
    set email             = excluded.email,
        full_name         = excluded.full_name,
        role              = excluded.role,
        employee_category = excluded.employee_category;

  return v_id;
end;
$$;

revoke execute on function public.create_console_user(
  text, text, public.app_role, text, public.team_category
) from public, anon, authenticated;
