-- ============================================================
-- AA Console · 05 · Proof → Ideas → Briefs → Media → Approvals
-- The delivery chain. Media is the cross-console hinge: written in
-- the Employee console, read in Admin and (once built) Client.
-- ============================================================

-- ---------- ref_number minting ----------
-- One shared, human-readable asset reference. It appears on media
-- assets and again on the calendar, so it is minted once, here,
-- rather than typed twice.
create table ref_counters (
  client_id  uuid primary key references clients(id) on delete cascade,
  last_value integer not null default 0
);

create or replace function next_ref_number(p_client_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  n       integer;
  prefix  text;
begin
  insert into ref_counters (client_id, last_value)
  values (p_client_id, 1)
  on conflict (client_id) do update set last_value = ref_counters.last_value + 1
  returning last_value into n;

  select upper(coalesce(initials, 'AA')) into prefix from clients where id = p_client_id;
  return prefix || '-' || lpad(n::text, 4, '0');
end;
$$;

-- ---------- Proof Bank ----------
-- Written by the Client console (their own testimonials and results)
-- or by Admin on their behalf. Text proof has a body and no file.
create table client_proof_assets (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  media_type    media_type not null,
  title         text,
  body          text,                    -- text proof lives here, not in Storage
  storage_path  text,                    -- image/video proof lives here
  source        text,
  uploaded_by   uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint proof_has_content check (body is not null or storage_path is not null)
);
create index cpa_client_idx on client_proof_assets (client_id, created_at desc);
create index cpa_type_idx on client_proof_assets (client_id, media_type);

-- ---------- Ideas ----------
-- Manual Idea, Auto Idea and Proof Idea all land here, separated by
-- `source`. That is what makes the single Idea/Type/Status table on
-- the Generation tab coherent.
create table client_ideas (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  title       text not null,
  body        text,
  media_type  media_type not null default 'image',
  source      idea_source not null,
  status      idea_status not null default 'draft',
  job_id      uuid references agent_jobs(id) on delete set null,
  proof_id    uuid references client_proof_assets(id) on delete set null,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger client_ideas_set_updated_at before update on client_ideas
  for each row execute function set_updated_at();
create index ci_client_idx on client_ideas (client_id, created_at desc);
create index ci_status_idx on client_ideas (client_id, status);

-- ---------- Briefs ----------
create table client_briefs (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  source_idea_id  uuid references client_ideas(id) on delete set null,
  title           text not null,
  body            text,
  media_type      media_type not null default 'image',
  status          brief_status not null default 'draft',
  job_id          uuid references agent_jobs(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger client_briefs_set_updated_at before update on client_briefs
  for each row execute function set_updated_at();
create index cb_client_idx on client_briefs (client_id, created_at desc);

-- Approve an idea and enqueue its brief in one call. This is the
-- trigger the mapping doc is missing — Briefs renders a table that
-- nothing currently writes.
create or replace function approve_idea_and_generate_brief(p_idea_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_job    uuid;
begin
  select client_id into v_client from client_ideas where id = p_idea_id;
  if v_client is null then
    raise exception 'Idea not found';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client';
  end if;

  update client_ideas set status = 'approved' where id = p_idea_id;
  v_job := enqueue_agent_job('brief', v_client, 'client_ideas', p_idea_id);
  update client_ideas set status = 'briefed' where id = p_idea_id;
  return v_job;
end;
$$;

-- ---------- Media assets ----------
-- ONE row serving three readers: the Employee's Finished Work card,
-- the Admin Media library tile, and the Approvals queue entry.
create table client_media_assets (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  brief_id       uuid references client_briefs(id) on delete set null,
  ref_number     text,
  media_type     media_type not null,
  title          text,
  storage_path   text not null,
  review_status  review_status not null default 'pending',
  uploaded_by    uuid references profiles(id) on delete set null,
  member_id      uuid references team_members(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger cma_set_updated_at before update on client_media_assets
  for each row execute function set_updated_at();
create index cma_client_idx on client_media_assets (client_id, created_at desc);
create index cma_review_idx on client_media_assets (client_id, review_status);
create unique index cma_ref_idx on client_media_assets (client_id, ref_number)
  where ref_number is not null;

-- Mint the ref_number on insert so nothing has to type it.
create or replace function assign_ref_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.ref_number is null then
    new.ref_number := next_ref_number(new.client_id);
  end if;
  return new;
end;
$$;
create trigger cma_assign_ref before insert on client_media_assets
  for each row execute function assign_ref_number();

-- ---------- Review decisions ----------
create table client_asset_reviews (
  id          uuid primary key default gen_random_uuid(),
  asset_id    uuid not null references client_media_assets(id) on delete cascade,
  decision    review_status not null,
  reason      text,
  reviewed_by uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index car_asset_idx on client_asset_reviews (asset_id, created_at desc);

-- The Approvals action the mapping doc is missing.
create or replace function review_media_asset(
  p_asset_id uuid,
  p_decision review_status,
  p_reason   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  select client_id into v_client from client_media_assets where id = p_asset_id;
  if v_client is null then
    raise exception 'Asset not found';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client';
  end if;
  if p_decision = 'pending' then
    raise exception 'Decision must be approved or rejected';
  end if;

  update client_media_assets set review_status = p_decision where id = p_asset_id;
  insert into client_asset_reviews (asset_id, decision, reason, reviewed_by)
  values (p_asset_id, p_decision, p_reason, auth.uid());
end;
$$;

-- ---------- derived views ----------
-- Approvals page: pending only.
create view approvals_queue as
select a.*, c.name as client_name, b.title as brief_title
from client_media_assets a
join clients c on c.id = a.client_id
left join client_briefs b on b.id = a.brief_id
where a.review_status = 'pending';

-- Employee "Finished Work": the same rows, seen from the member side.
create view work_submissions as
select a.id, a.member_id, a.client_id, a.media_type, a.title,
       a.storage_path, a.ref_number, a.review_status, a.created_at
from client_media_assets a
where a.member_id is not null;

-- ============================================================
-- RLS
-- ============================================================
alter table client_proof_assets  enable row level security;
alter table client_ideas         enable row level security;
alter table client_briefs        enable row level security;
alter table client_media_assets  enable row level security;
alter table client_asset_reviews enable row level security;
alter table ref_counters         enable row level security;

create policy cpa_admin_all on client_proof_assets
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cpa_scoped_read on client_proof_assets
  for select to authenticated using (can_access_client(client_id));
-- the client uploads their own proof
create policy cpa_client_insert on client_proof_assets
  for insert to authenticated with check (can_access_client(client_id));

create policy ci_admin_all on client_ideas
  for all to authenticated using (is_admin()) with check (is_admin());
create policy ci_scoped_read on client_ideas
  for select to authenticated using (can_access_client(client_id));

create policy cb_admin_all on client_briefs
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cb_scoped_read on client_briefs
  for select to authenticated using (can_access_client(client_id));

-- Media: admins do anything; an employee may upload for a client they
-- are assigned to, and may read back only their own uploads. A client
-- user reads everything for their own client.
create policy cma_admin_all on client_media_assets
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cma_employee_insert on client_media_assets
  for insert to authenticated
  with check (can_access_client(client_id) and member_id = current_member_id());
create policy cma_employee_read on client_media_assets
  for select to authenticated
  using (member_id = current_member_id());
create policy cma_client_read on client_media_assets
  for select to authenticated
  using (exists (select 1 from client_users cu
                  where cu.user_id = auth.uid() and cu.client_id = client_media_assets.client_id));

create policy cars_admin_all on client_asset_reviews
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cars_scoped_read on client_asset_reviews
  for select to authenticated
  using (exists (select 1 from client_media_assets a
                  where a.id = asset_id and can_access_client(a.client_id)));

create policy ref_counters_admin_all on ref_counters
  for all to authenticated using (is_admin()) with check (is_admin());;
