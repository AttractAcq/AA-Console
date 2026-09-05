-- ============================================================
-- AA Console · 03 · Agent registry + job queue
-- ONE queue for every agent flow in the app. The browser never runs
-- an agent: a form inserts its inputs row, enqueues a job, and
-- subscribes to Realtime on that job row.
-- ============================================================

create table agents (
  id                 uuid primary key default gen_random_uuid(),
  agent_key          text not null unique,
  name               text not null,
  initials           text not null,
  domain             text,
  description        text,
  -- agent_keys that must have produced an approved record for this
  -- client before this agent may run. Enforced by can_run_agent().
  requires_upstream  text[] not null default '{}',
  config             jsonb not null default '{}'::jsonb,
  paused             boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger agents_set_updated_at before update on agents
  for each row execute function set_updated_at();

create table agent_jobs (
  id             uuid primary key default gen_random_uuid(),
  agent_key      text not null references agents(agent_key) on update cascade,
  client_id      uuid references clients(id) on delete cascade,
  -- where the operator's form input landed, so the worker can find it
  input_table    text,
  input_id       uuid,
  status         job_status not null default 'queued',
  attempts       integer not null default 0,
  max_attempts   integer not null default 3,
  lease_until    timestamptz,
  error          text,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  cost_usd       numeric(12,6) not null default 0,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  completed_at   timestamptz
);
create index agent_jobs_queue_idx  on agent_jobs (status, created_at) where status in ('queued','running');
create index agent_jobs_client_idx on agent_jobs (client_id, agent_key, created_at desc);
create index agent_jobs_agent_idx  on agent_jobs (agent_key, created_at desc);

-- The Logs section on an agent detail page.
create table agent_job_events (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references agent_jobs(id) on delete cascade,
  description  text not null,
  level        text not null default 'info',
  payload      jsonb,
  created_at   timestamptz not null default now()
);
create index agent_job_events_job_idx on agent_job_events (job_id, created_at);

-- ---------- derived: the Agent Overview stat cards ----------
create view agent_stats as
select
  a.agent_key,
  a.name,
  count(j.id)                                                   as runs,
  count(j.id) filter (where j.status = 'failed')                as failed_runs,
  case when count(j.id) = 0 then 0
       else round(count(j.id) filter (where j.status='failed')::numeric
                  / count(j.id)::numeric, 4) end                as failure_rate,
  coalesce(sum(j.cost_usd), 0)                                  as total_cost,
  coalesce(
    sum(j.cost_usd) / nullif(
      greatest(1, (date_part('epoch', now() - min(j.created_at)) / 2629746)::numeric), 0
    ), 0)                                                       as avg_monthly_cost
from agents a
left join agent_jobs j on j.agent_key = a.agent_key
group by a.agent_key, a.name;

-- ---------- upstream gate ----------
-- Blocks an agent from running before the intelligence it synthesises
-- exists. v5's ideation failed 13 times partly for want of this.
create or replace function can_run_agent(p_agent_key text, p_client_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  needed text[];
  dep    text;
begin
  select requires_upstream into needed from agents where agent_key = p_agent_key;
  if needed is null or array_length(needed, 1) is null then
    return true;
  end if;
  foreach dep in array needed loop
    if not exists (
      select 1 from agent_jobs j
       where j.agent_key = dep
         and j.client_id = p_client_id
         and j.status = 'completed'
    ) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------- enqueue ----------
-- The single entry point every "Run" button and every agent-backed
-- form calls. Refuses up front rather than failing halfway through.
create or replace function enqueue_agent_job(
  p_agent_key   text,
  p_client_id   uuid default null,
  p_input_table text default null,
  p_input_id    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  if not exists (select 1 from agents where agent_key = p_agent_key) then
    raise exception 'Unknown agent: %', p_agent_key;
  end if;
  if (select paused from agents where agent_key = p_agent_key) then
    raise exception 'Agent % is paused', p_agent_key;
  end if;
  if p_client_id is not null and not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if p_client_id is not null and not can_run_agent(p_agent_key, p_client_id) then
    raise exception 'Agent % is missing required upstream intelligence', p_agent_key;
  end if;

  insert into agent_jobs (agent_key, client_id, input_table, input_id, created_by)
  values (p_agent_key, p_client_id, p_input_table, p_input_id, auth.uid())
  returning id into new_id;

  insert into agent_job_events (job_id, description)
  values (new_id, 'Queued');

  return new_id;
end;
$$;

-- ============================================================
-- RLS
-- ============================================================
alter table agents           enable row level security;
alter table agent_jobs       enable row level security;
alter table agent_job_events enable row level security;

create policy agents_admin_all on agents
  for all to authenticated using (is_admin()) with check (is_admin());
create policy agents_read on agents
  for select to authenticated using (true);

-- Jobs are readable by anyone who can see the client they belong to.
create policy agent_jobs_admin_all on agent_jobs
  for all to authenticated using (is_admin()) with check (is_admin());
create policy agent_jobs_scoped_read on agent_jobs
  for select to authenticated
  using (client_id is null or can_access_client(client_id));

create policy agent_job_events_admin_all on agent_job_events
  for all to authenticated using (is_admin()) with check (is_admin());
create policy agent_job_events_scoped_read on agent_job_events
  for select to authenticated
  using (exists (
    select 1 from agent_jobs j
     where j.id = job_id and (j.client_id is null or can_access_client(j.client_id))
  ));

-- ---------- seed the registry ----------
insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('icp',            'ICP Agent',                 'IC', 'intelligence', 'Builds the 15 ICP records and the question universe from business context.', '{}'),
  ('competitor',     'Competitor Agent',          'CO', 'intelligence', 'Researches seeded competitors into six analysis sections.',                  '{}'),
  ('association',    'Association Agent',         'AS', 'intelligence', 'Maps positive/negative associations, trust signals and language cues.',      '{icp}'),
  ('market',         'Market Agent',              'MK', 'intelligence', 'Category, demand conditions and market language. No dedicated tab yet.',     '{}'),
  ('campaign_intel', 'Campaign Intelligence',     'CI', 'intelligence', 'Quarterly timing, seasonality and trigger mapping.',                        '{}'),
  ('brand_strategy', 'Brand Strategist',          'BS', 'strategy',     'Cross-OS synthesis, strategic recommendations, recommended portfolio.',     '{icp,competitor,association}'),
  ('offer_strategy', 'Offer Strategist',          'OF', 'strategy',     'Value equation, guarantee, bonuses, scarcity and urgency.',                 '{icp}'),
  ('money_model',    'Money Model Agent',         'MM', 'strategy',     'Attraction, continuity, upsell and downsell offer architecture.',           '{offer_strategy}'),
  ('ideation',       'Ideation Agent',            'ID', 'content',      'Turns intelligence and proof into a bank of ideas worth saying.',           '{icp,brand_strategy}'),
  ('brief',          'Brief Agent',               'BR', 'content',      'Converts an approved idea into a production brief.',                        '{}'),
  ('landing_page',   'Landing Page Agent',        'LP', 'conversion',   'Builds landing and offer page content from offer strategy and proof.',      '{offer_strategy}');;
