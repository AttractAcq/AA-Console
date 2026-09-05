-- Reporting ingest, step 1: somewhere to put the numbers, a way to join
-- them back to our own rows, and a scheduler that only ever enqueues.
--
-- pg_cron will call enqueue_metrics_ingest_jobs(), which is a pure local
-- INSERT. It makes no network call, so it cannot hang, time out, or hold a
-- transaction open on a slow upstream. The Railway worker does the network.

create type metric_surface as enum ('paid', 'organic', 'landing', 'offer');
create type metric_entity  as enum ('account', 'campaign', 'post', 'page');

create table metrics_daily (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  surface       metric_surface not null,
  entity_type   metric_entity not null,
  -- The upstream's id. NOT NULL on purpose: account-level rows carry the
  -- ad account id rather than null, so the unique key below has no
  -- nullable column and cannot repeat the UNIQUE NULLS DISTINCT trap that
  -- migration 22 had to undo.
  external_id   text not null,
  metric_date   date not null,

  -- Our own rows, when we can map them. Null means we hold numbers for
  -- something that was never created in the console.
  campaign_id   uuid references campaigns(id) on delete set null,
  post_id       uuid references scheduled_posts(id) on delete set null,

  impressions   bigint,
  reach         bigint,
  clicks        bigint,
  engagements   bigint,
  spend         numeric(12,2),
  conversions   bigint,

  -- The payload the numbers came from, so a mapping can be corrected
  -- without re-fetching. Prune this before it dominates the table.
  raw           jsonb,
  fetched_at    timestamptz not null default now(),

  constraint metrics_daily_identity
    unique (client_id, surface, entity_type, external_id, metric_date)
);

create index metrics_daily_client_surface_date_idx
  on metrics_daily (client_id, surface, metric_date desc);
create index metrics_daily_campaign_idx on metrics_daily (campaign_id) where campaign_id is not null;
create index metrics_daily_post_idx     on metrics_daily (post_id)     where post_id is not null;

alter table metrics_daily enable row level security;

create policy metrics_daily_admin_all on metrics_daily
  for all to authenticated using (is_admin()) with check (is_admin());

create policy metrics_daily_scoped_read on metrics_daily
  for select to authenticated using (can_access_client(client_id));

comment on table metrics_daily is
  'One row per client, surface, entity and day. Re-pulled on a trailing window and upserted on metrics_daily_identity, because upstream numbers keep moving for days after the fact.';

-- ---------------------------------------------------------------------------
-- The join back to our own rows. Without these there is nothing to attach
-- incoming metrics to: campaign_ref and ref_number are ours, not theirs.
-- ---------------------------------------------------------------------------

alter table campaigns       add column external_id text;
alter table scheduled_posts add column external_id text;

create unique index campaigns_external_id_key
  on campaigns (client_id, external_id) where external_id is not null;
create unique index scheduled_posts_external_id_key
  on scheduled_posts (client_id, external_id) where external_id is not null;

comment on column campaigns.external_id is
  'The ad platform''s own campaign id, used to attach metrics_daily rows.';
comment on column scheduled_posts.external_id is
  'The platform''s own media/post id, used to attach metrics_daily rows.';

-- ---------------------------------------------------------------------------
-- Job parameters. input_table/input_id address one row; an ingest job needs
-- a surface and a date window instead, and a backfill needs a different
-- window for the same agent.
-- ---------------------------------------------------------------------------

alter table agent_jobs add column params jsonb not null default '{}'::jsonb;

comment on column agent_jobs.params is
  'Free-form arguments for runners that are not addressed by input_table/input_id, e.g. {"surface":"paid","since":"2026-09-01","until":"2026-09-08"}.';

-- ---------------------------------------------------------------------------
-- Scheduled agents are not part of a master run. Without this, an ingest
-- agent registered in the agents table gets swept into every Run All Agents.
-- ---------------------------------------------------------------------------

alter table agents add column scheduled_only boolean not null default false;

comment on column agents.scheduled_only is
  'Driven by a schedule rather than by a person. Excluded from master runs; still runnable on demand.';

create or replace function start_master_run(p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_count  integer;
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  insert into agent_jobs (agent_key, client_id, run_id, created_by)
  select a.agent_key, p_client_id, v_run_id, auth.uid()
  from agents a
  where a.paused = false
    and a.archived_at is null
    and a.scheduled_only = false
    and a.agent_key <> 'brief'
    and not exists (
      select 1 from agent_jobs j
       where j.agent_key = a.agent_key
         and j.client_id = p_client_id
         and j.status in ('queued', 'claimed', 'running')
    );

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Nothing to run - every agent is already queued or running for this client.';
  end if;

  return v_run_id;
end;
$$;

create or replace function start_master_run_as(p_actor uuid, p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_count  integer;
begin
  if not exists (select 1 from profiles where id = p_actor and role = 'admin') then
    raise exception 'Only an admin can start a master run.';
  end if;

  insert into agent_jobs (agent_key, client_id, run_id, created_by)
  select a.agent_key, p_client_id, v_run_id, p_actor
  from agents a
  where a.paused = false
    and a.archived_at is null
    and a.scheduled_only = false
    and a.agent_key <> 'brief'
    and not exists (
      select 1 from agent_jobs j
       where j.agent_key = a.agent_key
         and j.client_id = p_client_id
         and j.status in ('queued', 'claimed', 'running')
    );

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Nothing to run - every agent is already queued or running for this client.';
  end if;

  return v_run_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The ingest agent itself.
-- ---------------------------------------------------------------------------

insert into agents (agent_key, name, initials, domain, description, requires_upstream, scheduled_only)
values (
  'metrics_ingest',
  'Metrics Ingest',
  'MI',
  'intelligence',
  'Pulls reporting numbers from the ad platform on a trailing window and upserts them into metrics_daily. Deterministic - no model involved.',
  '{}',
  true
)
on conflict (agent_key) do update
  set scheduled_only = true,
      description = excluded.description;

-- ---------------------------------------------------------------------------
-- The scheduler. Fans out one job per client per surface so a single
-- client's expired token cannot stall everyone else, and each retries on
-- its own. Only surfaces with a connector are enqueued: landing and offer
-- pages are not an ad-platform source and will need their own.
-- ---------------------------------------------------------------------------

create or replace function enqueue_metrics_ingest_jobs(p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
  v_since date := current_date - greatest(coalesce(p_days, 7), 1);
  v_until date := current_date;
begin
  insert into agent_jobs (agent_key, client_id, params)
  select 'metrics_ingest',
         ci.client_id,
         jsonb_build_object('surface', s.surface, 'since', v_since, 'until', v_until)
    from client_integrations ci
    cross join (values ('paid'), ('organic')) as s(surface)
   where ci.provider = 'meta'
     and ci.status = 'active'
     and ci.credential_secret_id is not null
     -- never stack a second pull for the same client and surface
     and not exists (
       select 1 from agent_jobs j
        where j.agent_key = 'metrics_ingest'
          and j.client_id = ci.client_id
          and j.params->>'surface' = s.surface
          and j.status in ('queued', 'claimed', 'running')
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function enqueue_metrics_ingest_jobs(integer) is
  'Enqueues a trailing-window metrics pull per client per surface. Pure INSERT - makes no network call. Intended to be driven by pg_cron.';

-- ---------------------------------------------------------------------------
-- Credential read for the worker. The secret never leaves the database
-- except to the runtime, and only service_role may call this.
-- ---------------------------------------------------------------------------

create or replace function integration_secret(p_client_id uuid, p_provider text)
returns text
language plpgsql
security definer
set search_path to public, vault
as $$
declare
  v_secret_id uuid;
  v_value     text;
begin
  select credential_secret_id into v_secret_id
    from client_integrations
   where client_id = p_client_id and provider = p_provider and status = 'active';

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_value
    from vault.decrypted_secrets
   where id = v_secret_id;

  return v_value;
end;
$$;

revoke all on function enqueue_metrics_ingest_jobs(integer) from public, anon, authenticated;
revoke all on function integration_secret(uuid, text) from public, anon, authenticated;
grant execute on function enqueue_metrics_ingest_jobs(integer) to service_role;
grant execute on function integration_secret(uuid, text) to service_role;

comment on function integration_secret(uuid, text) is
  'Decrypts a client integration credential from Vault. service_role only - never expose this to authenticated.';;
