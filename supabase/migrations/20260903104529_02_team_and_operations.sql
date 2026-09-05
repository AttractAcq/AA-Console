-- ============================================================
-- AA Console · 02 · Team & Operations (agency-wide)
-- Avatars / Editors / SMM, their assignments, submissions, logs, pay.
-- Assignment tables are load-bearing: they define which clients an
-- employee may read and upload for, so the RLS helpers are extended
-- at the bottom of this migration to use them.
-- ============================================================

create table team_members (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid unique references profiles(id) on delete set null,
  category         team_category not null,
  name             text not null,
  initials         text not null,
  engagement       engagement_type not null default 'contractor',
  personal_info    text,
  contact_info     text,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger team_members_set_updated_at before update on team_members
  for each row execute function set_updated_at();
create index team_members_category_idx on team_members (category) where active;
create index team_members_user_idx on team_members (user_id);

-- ---------- Current Jobs (Avatars / Editors) ----------
create table job_assignments (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references team_members(id) on delete cascade,
  client_id     uuid references clients(id) on delete set null,
  title         text not null,
  due_date      date,
  compensation  numeric(12,2),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger job_assignments_set_updated_at before update on job_assignments
  for each row execute function set_updated_at();
create index job_assignments_member_idx on job_assignments (member_id);
create index job_assignments_client_idx on job_assignments (client_id);

-- ---------- Current Clients (SMM) ----------
create table client_assignments (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references team_members(id) on delete cascade,
  client_id     uuid not null references clients(id) on delete cascade,
  due_date      date,
  compensation  numeric(12,2),
  ended_at      timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (member_id, client_id)
);
create trigger client_assignments_set_updated_at before update on client_assignments
  for each row execute function set_updated_at();
create index client_assignments_client_idx on client_assignments (client_id);

-- ---------- Logged Work (SMM) ----------
create table work_logs (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references team_members(id) on delete cascade,
  client_id    uuid references clients(id) on delete set null,
  work_done    text not null,
  logged_on    date not null default current_date,
  minutes      integer,
  created_at   timestamptz not null default now()
);
create index work_logs_member_idx on work_logs (member_id, logged_on desc);

-- ---------- Contract payments ----------
create table contract_payments (
  id                uuid primary key default gen_random_uuid(),
  member_id         uuid not null references team_members(id) on delete cascade,
  service_rendered  text not null,
  compensation      numeric(12,2) not null,
  due_date          date,
  payment_date      date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger contract_payments_set_updated_at before update on contract_payments
  for each row execute function set_updated_at();
create index contract_payments_member_idx on contract_payments (member_id);

-- ============================================================
-- Extend client access to employees via their assignments.
-- An employee reaches a client through an SMM client_assignment
-- or through a job_assignment carrying that client_id.
-- ============================================================
create or replace function accessible_client_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id from clients c where is_admin()
  union
  select cu.client_id from client_users cu where cu.user_id = auth.uid()
  union
  select ca.client_id
    from client_assignments ca
    join team_members tm on tm.id = ca.member_id
   where tm.user_id = auth.uid() and ca.ended_at is null
  union
  select ja.client_id
    from job_assignments ja
    join team_members tm on tm.id = ja.member_id
   where tm.user_id = auth.uid() and ja.client_id is not null;
$$;

create or replace function can_access_client(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_admin()
      or exists (select 1 from client_users cu
                  where cu.user_id = auth.uid() and cu.client_id = target)
      or exists (select 1 from client_assignments ca join team_members tm on tm.id = ca.member_id
                  where tm.user_id = auth.uid() and ca.client_id = target and ca.ended_at is null)
      or exists (select 1 from job_assignments ja join team_members tm on tm.id = ja.member_id
                  where tm.user_id = auth.uid() and ja.client_id = target);
$$;

-- True when the calling user *is* this team member.
create or replace function is_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from team_members tm where tm.id = target and tm.user_id = auth.uid()
  );
$$;

-- The calling user's own team_members.id, if any.
create or replace function current_member_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from team_members where user_id = auth.uid() limit 1;
$$;

-- ============================================================
-- RLS · admins manage everything; employees see only their own rows
-- ============================================================
alter table team_members       enable row level security;
alter table job_assignments    enable row level security;
alter table client_assignments enable row level security;
alter table work_logs          enable row level security;
alter table contract_payments  enable row level security;

create policy team_members_admin_all on team_members
  for all to authenticated using (is_admin()) with check (is_admin());
create policy team_members_self_read on team_members
  for select to authenticated using (user_id = auth.uid());
create policy team_members_self_update on team_members
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy job_assignments_admin_all on job_assignments
  for all to authenticated using (is_admin()) with check (is_admin());
create policy job_assignments_self_read on job_assignments
  for select to authenticated using (is_member(member_id));
create policy job_assignments_self_complete on job_assignments
  for update to authenticated using (is_member(member_id)) with check (is_member(member_id));

create policy client_assignments_admin_all on client_assignments
  for all to authenticated using (is_admin()) with check (is_admin());
create policy client_assignments_self_read on client_assignments
  for select to authenticated using (is_member(member_id));

-- Employees write their own work logs; admins see all.
create policy work_logs_admin_all on work_logs
  for all to authenticated using (is_admin()) with check (is_admin());
create policy work_logs_self_read on work_logs
  for select to authenticated using (is_member(member_id));
create policy work_logs_self_insert on work_logs
  for insert to authenticated with check (is_member(member_id));

-- Pay is admin-written, employee-readable.
create policy contract_payments_admin_all on contract_payments
  for all to authenticated using (is_admin()) with check (is_admin());
create policy contract_payments_self_read on contract_payments
  for select to authenticated using (is_member(member_id));;
