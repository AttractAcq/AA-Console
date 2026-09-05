-- ============================================================
-- AA Console · 01 · Foundations
-- Enums, profiles/roles, clients, RLS helper functions.
-- Three consoles share one auth.users pool, separated by profiles.role.
-- ============================================================

-- ---------- enums ----------
create type app_role          as enum ('admin','employee','client');
create type team_category     as enum ('avatars','editors','smm');
create type engagement_type   as enum ('employee','contractor');
create type media_type        as enum ('image','text','video');
create type review_status     as enum ('pending','approved','rejected');
create type job_status        as enum ('queued','running','completed','failed','cancelled');
create type record_status     as enum ('draft','approved','superseded');
create type idea_source       as enum ('manual','auto','proof');
create type idea_status       as enum ('draft','approved','rejected','briefed');
create type brief_status      as enum ('draft','approved','rejected','in_production','complete');
create type pipeline_stage    as enum ('first_touch','second_touch','call_booked');
create type post_channel      as enum ('organic','paid');
create type page_type         as enum ('landing','offer');
create type step_status       as enum ('pending','in_progress','complete');

-- ---------- updated_at trigger ----------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- profiles ----------
-- One row per auth user. `role` decides which console they may enter.
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        app_role not null default 'employee',
  full_name   text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger profiles_set_updated_at before update on profiles
  for each row execute function set_updated_at();

-- ---------- clients ----------
create table clients (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  initials     text not null,
  sector       text,
  location     text,
  tier         text,
  is_internal  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger clients_set_updated_at before update on clients
  for each row execute function set_updated_at();
create index clients_name_idx on clients (name);

-- ---------- client_users ----------
-- Which auth users belong to which client (the Client console's scope).
create table client_users (
  client_id   uuid not null references clients(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (client_id, user_id)
);
create index client_users_user_idx on client_users (user_id);

-- ============================================================
-- RLS helper functions
-- SECURITY DEFINER so they can read profiles/assignments without
-- tripping the very policies they are used to evaluate.
-- ============================================================

create or replace function current_role_of()
returns app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from profiles where id = auth.uid()) = 'admin', false);
$$;

-- Clients the calling user may see.
--   admin    -> every client
--   client   -> the clients they are a member of
--   employee -> the clients they are assigned to (see migration 02)
create or replace function accessible_client_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id from clients c where is_admin()
  union
  select cu.client_id from client_users cu where cu.user_id = auth.uid();
$$;

create or replace function can_access_client(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_admin() or exists (
    select 1 from client_users cu
    where cu.user_id = auth.uid() and cu.client_id = target
  );
$$;

-- ============================================================
-- RLS
-- ============================================================
alter table profiles     enable row level security;
alter table clients      enable row level security;
alter table client_users enable row level security;

-- profiles: you can always read/update your own row; admins see all.
create policy profiles_self_read on profiles
  for select to authenticated using (id = auth.uid() or is_admin());
create policy profiles_self_update on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and role = current_role_of());
create policy profiles_admin_all on profiles
  for all to authenticated using (is_admin()) with check (is_admin());

-- clients: admins manage; everyone else reads only clients they can access.
create policy clients_admin_all on clients
  for all to authenticated using (is_admin()) with check (is_admin());
create policy clients_scoped_read on clients
  for select to authenticated using (can_access_client(id));

create policy client_users_admin_all on client_users
  for all to authenticated using (is_admin()) with check (is_admin());
create policy client_users_self_read on client_users
  for select to authenticated using (user_id = auth.uid());

-- ---------- new-user bootstrap ----------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();;
