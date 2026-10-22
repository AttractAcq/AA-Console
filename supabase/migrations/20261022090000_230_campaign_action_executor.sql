-- The half of migration 206 that was missing: something that acts on a yes.
--
-- 206 built the ledger. A person can be shown one exact campaign package,
-- one action, one destination and one artifact version hash, and can approve
-- or reject it, and that decision is immutable. Then nothing happens. There
-- is no row anywhere recording that an approved action was performed, no
-- external id, no attempt count, and nothing in the runtime that reads the
-- table at all. Every v6 module that ends in an external effect -- a page
-- deployed, a Meta object built, proof placed on a profile, a lead messaged
-- -- is waiting on this one missing piece, which is why they are all
-- deliberately held rather than half-wired.
--
-- WHY A SECOND TABLE RATHER THAN COLUMNS ON THE APPROVAL
--
-- 206's identity guard refuses every update to a decided approval, which is
-- exactly right: a decision that can be edited is not a decision. So
-- execution state cannot live there. It also should not: "a person said yes
-- to this" and "a machine did it, on the third attempt, at 04:12" are two
-- facts with different authors and different lifetimes, and the day they
-- disagree is the day it matters that they were recorded separately.
--
-- An approval with no execution row has not been attempted. That is a state
-- worth being able to read off the absence of a row rather than off a column
-- that defaults to a word.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
-- It performs no external action and names no provider. It adds the claim,
-- the lease, the attempt count, the external id, the one sentence saying why
-- nothing has happened, and a registry of which actions have an executor at
-- all -- so that `google_ad_build` says "no executor" rather than sitting in
-- a queue nobody serves. Every action but `proof_publish` ships unsupported,
-- every client switch is off, and the runtime flag is off by default.
-- Applying this changes nothing about any client's external presence.
--
-- The four switches, in the order a person meets them:
--
--   1. CAMPAIGN_ACTIONS_ENABLED in the runtime      (off unless set)
--   2. client_engine_settings.campaign_actions_enabled (off per client)
--   3. campaign_action_executors.supported          (off per action)
--   4. the human decision on campaign_action_approvals
--
-- Any one of them being off means nothing is claimed, and the due view says
-- which one it was.

-- ---------------------------------------------------------------------------
-- The client switch
-- ---------------------------------------------------------------------------

-- Distinct from publishing_enabled (160) and proof_publishing_enabled (218)
-- for the reason 229 gives about those two: posting on a client's own feed,
-- putting a customer's words on a third party's profile, and letting a
-- machine create ad objects or deploy a page are three different promises to
-- have made, and a client can reasonably have agreed to one and not another.
alter table client_engine_settings
  add column if not exists campaign_actions_enabled boolean not null default false,
  add column if not exists campaign_actions_enabled_at timestamptz,
  add column if not exists campaign_actions_enabled_by uuid references public.profiles(id) on delete set null;

comment on column client_engine_settings.campaign_actions_enabled is
  'Whether approved campaign actions may be executed against external systems for this client. Off for every client until somebody turns it on, and distinct from publishing_enabled and proof_publishing_enabled: posting content, placing proof and building ads are different permissions.';

create or replace function public.set_campaign_actions_enabled(
  p_client_id uuid, p_enabled boolean)
returns client_engine_settings
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_row client_engine_settings;
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)) then
    raise exception 'Only an admin or the active client manager may change this.'
      using errcode = 'P0001';
  end if;

  insert into client_engine_settings (client_id, campaign_actions_enabled,
                                      campaign_actions_enabled_at, campaign_actions_enabled_by)
  values (p_client_id, p_enabled,
          case when p_enabled then now() end,
          case when p_enabled then auth.uid() end)
  on conflict (client_id) do update
    set campaign_actions_enabled = excluded.campaign_actions_enabled,
        -- Keep the stamp on the way off. Who turned this on is worth more
        -- than when it was last turned off, and 229's reasoning applies.
        campaign_actions_enabled_at = case when excluded.campaign_actions_enabled
          then now() else client_engine_settings.campaign_actions_enabled_at end,
        campaign_actions_enabled_by = case when excluded.campaign_actions_enabled
          then auth.uid() else client_engine_settings.campaign_actions_enabled_by end
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.set_campaign_actions_enabled(uuid, boolean) is
  'Turn external campaign action execution on or off for one client, and record who decided.';

revoke all on function public.set_campaign_actions_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_campaign_actions_enabled(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Which actions have an executor
-- ---------------------------------------------------------------------------

-- Data rather than a CASE, for the reason proof_destinations gives: an action
-- with no executor must be visibly unsupported rather than silently never
-- claimed. "Google Ads has no executor yet" and "approved Google Ads builds
-- quietly never happen" look identical from the outside until this row
-- exists.
create table public.campaign_action_executors (
  action_key text primary key check (action_key in (
    'campaign_launch', 'meta_ad_build', 'google_ad_build', 'organic_publish',
    'proof_publish', 'page_deploy', 'lead_message', 'profile_update', 'budget_change')),
  executor_module text not null,
  supported boolean not null default false,
  note text not null
);

comment on table public.campaign_action_executors is
  'Which approved campaign actions something can actually perform, and for the rest, what is missing. The same discipline as proof_destinations: unsupported is a visible state, not silence.';

insert into public.campaign_action_executors (action_key, executor_module, supported, note) values
  ('proof_publish', 'proof_distribution', true,
   'Releases this campaign''s approved proof placements to the proof distribution sweep, which owns the transport. The executor performs no external write of its own.'),
  ('page_deploy', 'website_studio', false,
   'Needs the exact-rendered-bytes publisher. Migration 212 blocks v6 campaign page publication until it exists; this row is what makes that block visible here.'),
  ('meta_ad_build', 'meta_ads_studio', false,
   'The build jobs exist and can create paused objects. Routing them through this gate, so a build cannot run on a stale approval, is its own slice.'),
  ('google_ad_build', 'google_ads_studio', false,
   'No Google Ads adapter exists in this repository at all.'),
  ('organic_publish', 'content_distribution', false,
   'Organic content already executes through its own approval and the publish sweep. It is listed here so a campaign-level organic approval is not mistaken for a second, competing publisher.'),
  ('campaign_launch', 'campaign_factory', false,
   'A launch is every other action having happened, not an action of its own. Supported once the actions a route needs are.'),
  ('lead_message', 'sales_os', false,
   'No governed outbound send path exists yet.'),
  ('profile_update', 'google_profile', false,
   'No Google Business Profile or Meta profile management adapter exists yet.'),
  ('budget_change', 'meta_ads_studio', false,
   'Changing spend is its own approval and its own executor, deliberately not folded into the build.')
on conflict (action_key) do update
  set executor_module = excluded.executor_module,
      supported = excluded.supported,
      note = excluded.note;

alter table public.campaign_action_executors enable row level security;
create policy campaign_action_executors_read on public.campaign_action_executors
  for select to authenticated using (true);
grant select on public.campaign_action_executors to authenticated;
grant all on public.campaign_action_executors to service_role;

-- ---------------------------------------------------------------------------
-- The execution
-- ---------------------------------------------------------------------------

create table public.campaign_action_executions (
  id uuid primary key default gen_random_uuid(),
  -- One lifecycle per approval. Not one per attempt: attempts are a counter
  -- on the lifecycle, and a second row for the same yes would be a second
  -- chance to perform a one-time external act.
  approval_id uuid not null unique references public.campaign_action_approvals(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid not null references public.client_campaigns(id) on delete cascade,
  action_key text not null references public.campaign_action_executors(action_key),

  -- Copied from the approval at claim time and never recomputed here. The
  -- claim already refused to proceed if the package moved; storing the hash
  -- the attempt was made under means a later argument about what went out
  -- can be settled from this row rather than from the current state of
  -- something that has since changed.
  artifact_version_hash text not null,
  manifest_id uuid not null,

  status text not null default 'executing' check (status in (
    'executing', 'executed', 'failed', 'abandoned')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  lease_until timestamptz,
  executed_at timestamptz,

  external_id text,
  external_url text,
  -- Whatever the executor wants on the record: the placements it released,
  -- the objects it created. Never a credential.
  result jsonb,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.campaign_action_executions is
  'What was done about one approved campaign action: attempts, the exact version it was attempted under, the external id it produced and the error if it produced none. Separate from the approval because a decision is not an outcome.';

create index campaign_action_executions_claim_idx
  on public.campaign_action_executions (status, lease_until);
create index campaign_action_executions_client_idx
  on public.campaign_action_executions (client_id, campaign_id, created_at desc);

create function public.guard_campaign_action_execution()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.approval_id is distinct from old.approval_id
     or new.client_id is distinct from old.client_id
     or new.campaign_id is distinct from old.campaign_id
     or new.action_key is distinct from old.action_key
     or new.manifest_id is distinct from old.manifest_id
     or new.artifact_version_hash is distinct from old.artifact_version_hash then
    raise exception 'An execution cannot change which approval, campaign, action or version it belongs to.';
  end if;
  -- Terminal means terminal. An executed action that can be moved back to
  -- executing is an external act with no record of having happened twice.
  if old.status in ('executed', 'abandoned') and new.status is distinct from old.status then
    raise exception 'That execution is already %.', old.status;
  end if;
  if new.status is distinct from old.status
     and not (old.status, new.status) in (
       ('executing', 'executed'), ('executing', 'failed'), ('executing', 'abandoned'),
       ('failed', 'executing'), ('failed', 'abandoned')) then
    raise exception 'An execution cannot go from % to %.', old.status, new.status;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger campaign_action_execution_guard before update on public.campaign_action_executions
  for each row execute function public.guard_campaign_action_execution();

alter table public.campaign_action_executions enable row level security;
create policy campaign_action_executions_read on public.campaign_action_executions
  for select to authenticated using (
    public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select on public.campaign_action_executions to authenticated;
grant all on public.campaign_action_executions to service_role;

-- ---------------------------------------------------------------------------
-- What happened, in order
-- ---------------------------------------------------------------------------

create table public.campaign_action_events (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references public.campaign_action_executions(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  event text not null check (event in (
    'claimed', 'executed', 'failed', 'abandoned', 'reaped')),
  actor text not null check (actor in ('agent', 'system')),
  detail text,
  external_ref text,
  occurred_at timestamptz not null default now()
);

create index campaign_action_events_idx
  on public.campaign_action_events (execution_id, occurred_at desc);

create function public.guard_campaign_action_event_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'Action events are a record of what happened. They are not edited.';
end $$;

create trigger campaign_action_events_append_only
  before update or delete on public.campaign_action_events
  for each row execute function public.guard_campaign_action_event_append_only();

alter table public.campaign_action_events enable row level security;
create policy campaign_action_events_read on public.campaign_action_events
  for select to authenticated using (
    public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select on public.campaign_action_events to authenticated;
grant all on public.campaign_action_events to service_role;

-- ---------------------------------------------------------------------------
-- Why nothing has happened
-- ---------------------------------------------------------------------------

-- publish_due and proof_placement_due, for campaign actions. One sentence
-- per approved action, and a null blocker means the sweep would take it
-- next. The order of the cases is the order a person should hear them:
-- the facts that make the action wrong come before the ones that merely
-- make it wait.
create or replace view campaign_action_due with (security_invoker = true) as
select
  a.id as approval_id,
  a.client_id,
  a.campaign_id,
  a.action_key,
  a.destination,
  a.artifact_version_hash,
  a.manifest_id,
  a.scope,
  e.id as execution_id,
  coalesce(e.status, 'not_attempted') as execution_status,
  coalesce(e.attempts, 0) as attempts,
  e.external_id,
  e.external_url,
  e.last_error,
  x.executor_module,
  case
    when a.status <> 'approved'
      then 'This action is ' || a.status || '.'
    when exists (select 1 from public.campaign_manifest_versions v
                  where v.campaign_id = a.campaign_id and v.version > m.version)
      then 'The campaign package was superseded after this was approved. Request approval against the current package.'
    when x.supported is not true
      then 'There is no executor for ' || replace(a.action_key, '_', ' ') || ' yet.'
    when not coalesce(ces.campaign_actions_enabled, false)
      then 'External campaign actions are off for this client.'
    when e.status = 'executed'
      then 'Already done.'
    when e.status = 'abandoned'
      then 'Abandoned after a failure that cannot be safely retried: ' || coalesce(e.last_error, 'no reason recorded') || '.'
    when e.status = 'executing' and e.lease_until > now()
      then 'Being executed now.'
    -- A ceiling, because a retryable failure that keeps recurring is a
    -- standing problem rather than bad luck, and five goes at an external
    -- system is enough to have found that out.
    when coalesce(e.attempts, 0) >= 5
      then 'Failed ' || e.attempts::text || ' times. Last error: ' || coalesce(e.last_error, 'none recorded') || '.'
    else null
  end as blocker
from public.campaign_action_approvals a
join public.campaign_manifest_versions m on m.id = a.manifest_id
join public.campaign_action_executors x on x.action_key = a.action_key
left join public.campaign_action_executions e on e.approval_id = a.id
left join public.client_engine_settings ces on ces.client_id = a.client_id
where a.status = 'approved';

comment on view campaign_action_due is
  'Every approved campaign action, and the one sentence saying why it has not been performed. A null blocker means the executor would take it next.';

grant select on campaign_action_due to authenticated;

-- ---------------------------------------------------------------------------
-- Claiming
-- ---------------------------------------------------------------------------

create function public.claim_campaign_actions(p_limit integer default 3)
returns table (
  execution_id uuid, approval_id uuid, client_id uuid, campaign_id uuid,
  manifest_id uuid, action_key text, destination text,
  artifact_version_hash text, scope jsonb, attempt integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may claim campaign actions.';
  end if;
  return query
  -- The lock is taken on the approvals rows rather than through the view,
  -- for the reason claim_proof_placements gives: a view is a join and cannot
  -- be locked, and the rows worth locking are the ones the view has already
  -- said are unblocked.
  with ready as (
    select a.id as approval_id
      from public.campaign_action_approvals a
     where a.status = 'approved'
       and a.id in (select d.approval_id from public.campaign_action_due d where d.blocker is null)
     order by a.decided_at
     limit greatest(coalesce(p_limit, 3), 1)
     for update skip locked
  ), existing as (
    update public.campaign_action_executions e
       set status = 'executing', claimed_at = now(),
           lease_until = now() + interval '15 minutes',
           attempts = e.attempts + 1, last_error = null
     where e.approval_id in (select r.approval_id from ready r)
     returning e.*
  ), created as (
    insert into public.campaign_action_executions (
      approval_id, client_id, campaign_id, action_key, artifact_version_hash,
      manifest_id, status, attempts, claimed_at, lease_until)
    select a.id, a.client_id, a.campaign_id, a.action_key, a.artifact_version_hash,
           a.manifest_id, 'executing', 1, now(), now() + interval '15 minutes'
      from public.campaign_action_approvals a
     where a.id in (select r.approval_id from ready r)
       and a.id not in (select x.approval_id from existing x)
    returning *
  ), claimed as (
    select * from existing union all select * from created
  ), logged as (
    -- A data-modifying CTE runs to completion whether or not the primary
    -- query reads it, so this logs every claim without being joined in.
    insert into public.campaign_action_events (execution_id, client_id, event, actor, detail)
    select c.id, c.client_id, 'claimed', 'agent',
           'Attempt ' || c.attempts::text || ' of ' || replace(c.action_key, '_', ' ') || '.'
      from claimed c
  )
  select c.id, c.approval_id, c.client_id, c.campaign_id, c.manifest_id,
         c.action_key, a.destination, c.artifact_version_hash, a.scope, c.attempts
    from claimed c
    join public.campaign_action_approvals a on a.id = c.approval_id;
end $$;

revoke all on function public.claim_campaign_actions(integer) from public, anon, authenticated;
grant execute on function public.claim_campaign_actions(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Recording the outcome
-- ---------------------------------------------------------------------------

create function public.record_campaign_action_executed(
  p_execution_id uuid, p_external_id text default null,
  p_external_url text default null, p_result jsonb default null)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v public.campaign_action_executions%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record an execution.';
  end if;
  update public.campaign_action_executions
     set status = 'executed', external_id = p_external_id, external_url = p_external_url,
         result = p_result, executed_at = now(), lease_until = null, last_error = null
   where id = p_execution_id and status = 'executing'
   returning * into v;
  if not found then raise exception 'That action is not being executed.'; end if;
  insert into public.campaign_action_events (execution_id, client_id, event, actor, external_ref)
  values (p_execution_id, v.client_id, 'executed', 'agent',
          coalesce(p_external_url, p_external_id));
end $$;

revoke all on function public.record_campaign_action_executed(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_campaign_action_executed(uuid, text, text, jsonb)
  to service_role;

-- A failure that did not obviously fail stays failed. 160's reasoning, and
-- with more force here: the actions behind this gate create ad objects and
-- deploy pages, and a retry of an attempt that may have half-succeeded is
-- how a client ends up with two of something.
create function public.record_campaign_action_failure(
  p_execution_id uuid, p_reason text, p_retryable boolean default false)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v public.campaign_action_executions%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a failure.';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say what failed.';
  end if;
  update public.campaign_action_executions
     set status = 'failed', last_error = btrim(p_reason), lease_until = null
   where id = p_execution_id and status = 'executing'
   returning * into v;
  if not found then raise exception 'That action is not being executed.'; end if;
  insert into public.campaign_action_events (execution_id, client_id, event, actor, detail)
  values (p_execution_id, v.client_id, 'failed', 'agent', btrim(p_reason));

  if not coalesce(p_retryable, false) then
    update public.campaign_action_executions
       set status = 'abandoned' where id = p_execution_id;
    insert into public.campaign_action_events (execution_id, client_id, event, actor, detail)
    values (p_execution_id, v.client_id, 'abandoned', 'system',
            'Not retryable. A person decides what happens next.');
  end if;
end $$;

revoke all on function public.record_campaign_action_failure(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_campaign_action_failure(uuid, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- The reaper
-- ---------------------------------------------------------------------------

-- A lease that ran out is not a failure anybody observed. The attempt may
-- have reached the destination and died before recording it, so this does
-- not put the work back: it abandons it and says to go and look. That is
-- deliberately the expensive-feeling choice, because the cheap one is a
-- duplicate ad campaign.
create function public.reap_stale_campaign_action_claims()
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may reap campaign actions.';
  end if;
  -- Straight to abandoned in one update rather than failed-then-abandoned
  -- in two CTEs: Postgres applies only one of two modifications to the same
  -- row in a single statement, so the two-step version would leave whichever
  -- status it felt like.
  with gone as (
    update public.campaign_action_executions
       set status = 'abandoned', lease_until = null,
           last_error = 'The attempt stopped without recording an outcome. Check the destination before approving another.'
     where status = 'executing' and lease_until is not null and lease_until < now()
     returning id, client_id)
  insert into public.campaign_action_events (execution_id, client_id, event, actor, detail)
  select g.id, g.client_id, 'reaped', 'system',
         'The lease expired with no outcome recorded, so it was abandoned rather than retried.'
    from gone g;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.reap_stale_campaign_action_claims() from public, anon, authenticated;
grant execute on function public.reap_stale_campaign_action_claims() to service_role;

-- ---------------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------------

create function public.enqueue_campaign_action_sweep()
returns uuid language plpgsql security definer
set search_path to 'public' as $$
declare v_job uuid;
begin
  -- One sweep at a time, and nothing to do is nothing to queue. Both for the
  -- reasons enqueue_publish_sweep gives.
  if exists (select 1 from agent_jobs
              where agent_key = 'campaign_action_executor'
                and status in ('queued', 'claimed', 'running')) then
    return null;
  end if;
  if not exists (select 1 from campaign_action_due where blocker is null) then
    return null;
  end if;
  insert into agent_jobs (agent_key, params)
  values ('campaign_action_executor', jsonb_build_object('limit', 3))
  returning id into v_job;
  return v_job;
end $$;

comment on function public.enqueue_campaign_action_sweep() is
  'Queues one campaign action sweep, if an approved action is actually unblocked and no sweep is already in flight.';

revoke all on function public.enqueue_campaign_action_sweep() from public, anon;
grant execute on function public.enqueue_campaign_action_sweep() to authenticated, service_role;

insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('campaign_action_executor', 'Campaign Action Executor', 'AX', null,
   'Performs campaign actions a person has approved, against the exact package and artifact version they approved, and records the external result. Executes nothing that is not approved, and nothing whose package has since changed.',
   array[]::text[])
on conflict (agent_key) do update
  set name = excluded.name,
      initials = excluded.initials,
      description = excluded.description,
      requires_upstream = excluded.requires_upstream;

-- Every ten minutes, like the publish sweep. An approval is a person
-- clicking; ten minutes of drift between the click and the act is inside
-- what anybody expects, and a tighter schedule buys nothing.
select cron.unschedule('campaign-action-sweep')
 where exists (select 1 from cron.job where jobname = 'campaign-action-sweep');
select cron.schedule('campaign-action-sweep', '*/10 * * * *',
  $cron$ select public.enqueue_campaign_action_sweep(); $cron$);

select cron.unschedule('reap-stale-campaign-actions')
 where exists (select 1 from cron.job where jobname = 'reap-stale-campaign-actions');
select cron.schedule('reap-stale-campaign-actions', '25 * * * *',
  $cron$ select public.reap_stale_campaign_action_claims(); $cron$);

-- `revoke all ... from public` leaves Supabase's own grants to anon and
-- authenticated exactly where they were. Migration 161 exists because of
-- that, and every migration adding a SECURITY DEFINER function ends here.
select lock_down_definer_functions();
