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
