-- ============================================================
-- AA Console · 06 · Distribution, Conversion, Leads
--
-- ONE scheduled_posts table with a nullable client_id, resolving the
-- overlap between Operations → Add Event (agency-wide calendar) and
-- the client Distribution tabs. Same rows, two filters.
-- ============================================================

create table scheduled_posts (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid references clients(id) on delete cascade,
  asset_id       uuid references client_media_assets(id) on delete set null,
  ref_number     text,
  scheduled_for  date not null,
  channel        post_channel not null default 'organic',
  media_type     media_type not null default 'image',
  notes          text,
  published_at   timestamptz,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger sp_set_updated_at before update on scheduled_posts
  for each row execute function set_updated_at();
create index sp_date_idx   on scheduled_posts (scheduled_for);
create index sp_client_idx on scheduled_posts (client_id, scheduled_for);

-- Copy ref_number and media_type down from the asset when one is linked,
-- so the calendar never carries a reference that disagrees with the asset.
create or replace function sync_scheduled_post_from_asset()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.asset_id is not null then
    select a.ref_number, a.media_type, a.client_id
      into new.ref_number, new.media_type, new.client_id
      from client_media_assets a where a.id = new.asset_id;
  end if;
  return new;
end;
$$;
create trigger sp_sync_asset before insert or update on scheduled_posts
  for each row execute function sync_scheduled_post_from_asset();

-- Schedule an approved asset. Refuses anything not through the gate.
create or replace function schedule_asset(
  p_asset_id uuid,
  p_date     date,
  p_channel  post_channel default 'organic'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_status review_status;
  v_id     uuid;
begin
  select client_id, review_status into v_client, v_status
    from client_media_assets where id = p_asset_id;
  if v_client is null then
    raise exception 'Asset not found';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client';
  end if;
  if v_status <> 'approved' then
    raise exception 'Asset must be approved before it can be scheduled';
  end if;

  insert into scheduled_posts (asset_id, scheduled_for, channel, created_by)
  values (p_asset_id, p_date, p_channel, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------- Conversion ----------
-- Build Page is a generation verb: the operator supplies a short brief,
-- the agent produces the page body and preview.
create table client_pages (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  page_type      page_type not null,
  title          text not null,
  brief          text,                -- what the operator typed
  body           text,                -- what the agent produced
  thumbnail_path text,
  published_url  text,
  status         record_status not null default 'draft',
  job_id         uuid references agent_jobs(id) on delete set null,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger cp_set_updated_at before update on client_pages
  for each row execute function set_updated_at();
create index cp_client_idx on client_pages (client_id, page_type, created_at desc);

-- ---------- Prospects & Leads ----------
create table client_leads (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  name           text,
  contact        text,
  source         text,
  pipeline_stage pipeline_stage not null default 'first_touch',
  notes          text,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger cl_set_updated_at before update on client_leads
  for each row execute function set_updated_at();
create index cl_client_stage_idx on client_leads (client_id, pipeline_stage);

-- Column counts for the three pipeline columns.
create view lead_pipeline_counts as
select client_id, pipeline_stage, count(*) as lead_count
from client_leads
group by client_id, pipeline_stage;

-- ============================================================
-- RLS
-- ============================================================
alter table scheduled_posts enable row level security;
alter table client_pages    enable row level security;
alter table client_leads    enable row level security;

create policy sp_admin_all on scheduled_posts
  for all to authenticated using (is_admin()) with check (is_admin());
create policy sp_scoped_read on scheduled_posts
  for select to authenticated
  using (client_id is null or can_access_client(client_id));

create policy cp_admin_all on client_pages
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cp_scoped_read on client_pages
  for select to authenticated using (can_access_client(client_id));

create policy cl_admin_all on client_leads
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cl_scoped_read on client_leads
  for select to authenticated using (can_access_client(client_id));;
