-- G05 and G07: the two decisions the system recorded and could not perform.
--
-- `google_profile_changes` and `meta_profile_changes` have carried `applied`
-- and `failed` statuses, an `applied_at` and a `last_error` since 240 and
-- 241. `campaign_action_executors.profile_update` has read "No Google
-- Business Profile or Meta profile management adapter exists yet", and
-- `budget_change` has read that changing spend is its own approval and its
-- own executor. Both schemas anticipated the executor; neither had one.
--
-- WHICH PROFILE FIELDS CAN ACTUALLY BE WRITTEN
--
-- Not all of them, and the difference is not ours to choose. A Facebook
-- page's `about` and `website` can be set through the Pages API; an
-- Instagram business profile's bio cannot be set by anybody but the account
-- holder in the app. So `profile_field_support` is a table rather than a
-- CASE: each surface, platform and field says whether it is writable and,
-- when it is not, what a person has to do instead. An unwritable field is a
-- visible instruction, not a change that silently never happens.
--
-- WHAT IS NOT PROVEN HERE
--
-- The Google transport follows the precedent 231 set for proof posts: the
-- call is the real Business Profile endpoint, and it has not been run
-- against a real profile because no client has a connected credential yet.
-- The acceptance gate is a field changing on a real profile with its
-- reference recorded, not this migration existing. The due view says so.
--
-- A BUDGET CHANGE IS MONEY, SO THE APPROVAL BINDS THE AMOUNT
--
-- The approval hash covers the ad set and the exact proposed figure, so an
-- amount edited after the yes has no approval. And the request records the
-- multiple of the current budget it represents, because the realistic
-- mistake is not a disagreement about strategy -- it is a typed 10000 where
-- 100 was meant, and "this is 100 times the current daily budget" is the
-- sentence that catches it while a bare number does not.

-- ---------------------------------------------------------------------------
-- Which fields a machine may write
-- ---------------------------------------------------------------------------

create table if not exists public.profile_field_support (
  surface text not null check (surface in ('google_business', 'meta')),
  platform text not null check (platform in ('google', 'instagram', 'facebook')),
  field text not null,
  writable boolean not null default false,
  -- When it is not writable, what a person does instead. Read aloud by the
  -- due view, so the instruction reaches whoever has to carry it out.
  note text not null,
  primary key (surface, platform, field)
);

comment on table public.profile_field_support is
  'Which profile fields an adapter may write, per surface and platform, and for the rest what a person must do instead. A table rather than a CASE, because the limits are the platforms'' and change without us.';

insert into public.profile_field_support (surface, platform, field, writable, note) values
  ('google_business', 'google', 'title', true,
   'Set through the Business Profile locations API. A name change can re-trigger verification.'),
  ('google_business', 'google', 'description', true, 'Set through the locations API.'),
  ('google_business', 'google', 'primary_phone', true, 'Set through the locations API.'),
  ('google_business', 'google', 'website_url', true, 'Set through the locations API.'),
  ('google_business', 'google', 'hours', true,
   'Set through the locations API as regularHours. Special hours are a separate call and are not written here.'),
  ('google_business', 'google', 'categories', false,
   'Categories are validated against Google''s own taxonomy and a wrong one suppresses the listing. A person picks them in the Business Profile manager.'),
  ('google_business', 'google', 'services', false,
   'Service items depend on the chosen primary category, so they cannot be set before a person has confirmed it.'),
  ('google_business', 'google', 'photos', false,
   'Photos upload through a separate media endpoint and are placed as proof rather than as a profile field. Use a proof placement.'),

  ('meta', 'facebook', 'about', true, 'Set through the Pages API.'),
  ('meta', 'facebook', 'website_url', true, 'Set through the Pages API.'),
  ('meta', 'facebook', 'display_name', false,
   'A page name change goes through Meta''s own review and cannot be applied by an API call.'),
  ('meta', 'facebook', 'category', false,
   'Page categories are chosen from Meta''s list in Page settings by a person.'),
  ('meta', 'facebook', 'bio', false,
   'Not a Facebook page field. Use about.'),
  ('meta', 'facebook', 'contact_button', false,
   'Call-to-action buttons are configured in Page settings.'),
  ('meta', 'facebook', 'services', false,
   'Services are configured in Page settings.'),

  ('meta', 'instagram', 'bio', false,
   'Instagram does not permit a business bio to be set through the API. A person edits it in the app; this records what it should say.'),
  ('meta', 'instagram', 'website_url', false,
   'Not writable through the Instagram Graph API. A person edits it in the app.'),
  ('meta', 'instagram', 'display_name', false,
   'A person edits it in the app.'),
  ('meta', 'instagram', 'category', false, 'A person edits it in the app.'),
  ('meta', 'instagram', 'contact_button', false, 'A person edits it in the app.'),
  ('meta', 'instagram', 'services', false, 'A person edits it in the app.'),
  ('meta', 'instagram', 'about', false, 'Not an Instagram field. Use bio.')
on conflict (surface, platform, field) do update
  set writable = excluded.writable, note = excluded.note;

alter table public.profile_field_support enable row level security;
drop policy if exists profile_field_support_read on public.profile_field_support;
create policy profile_field_support_read on public.profile_field_support
  for select to authenticated using (true);
grant select on public.profile_field_support to authenticated;
grant all on public.profile_field_support to service_role;

-- ---------------------------------------------------------------------------
-- G05: claiming and recording a profile change
-- ---------------------------------------------------------------------------

alter table public.google_profile_changes
  add column if not exists attempts integer not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists lease_until timestamptz,
  add column if not exists external_ref text;

alter table public.meta_profile_changes
  add column if not exists attempts integer not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists lease_until timestamptz;

create or replace function public.claim_profile_changes(p_limit integer default 5)
returns table (
  change_id uuid, client_id uuid, surface text, platform text, field text,
  proposed_value text, location_ref text, attempts integer)
language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may claim a profile change.';
  end if;

  return query
  with google_claimable as (
    select c.id from public.google_profile_changes c
     join public.profile_field_support f
       on f.surface = 'google_business' and f.platform = 'google' and f.field = c.field
     where c.status = 'approved' and f.writable
       and (c.lease_until is null or c.lease_until < now())
       and c.attempts < 5
     order by c.approved_at
     limit greatest(coalesce(p_limit, 5), 1)
     for update of c skip locked
  ), google_claimed as (
    update public.google_profile_changes c
       set attempts = c.attempts + 1, claimed_at = now(),
           lease_until = now() + interval '5 minutes'
     where c.id in (select id from google_claimable)
     returning c.id, c.client_id, 'google_business'::text as surface, 'google'::text as platform,
               c.field, c.proposed_value, c.location_id, c.attempts
  )
  select g.id, g.client_id, g.surface, g.platform, g.field, g.proposed_value,
         l.location_ref, g.attempts
    from google_claimed g
    left join public.client_google_locations l on l.id = g.location_id;
end $$;

comment on function public.claim_profile_changes(integer) is
  'Claims approved Google profile changes whose field an adapter may actually write. An unwritable field is never claimed, so it stays approved and visible as a job for a person rather than failing five times.';

revoke all on function public.claim_profile_changes(integer) from public, anon, authenticated;
grant execute on function public.claim_profile_changes(integer) to service_role;

create or replace function public.record_profile_change_applied(
  p_change_id uuid, p_external_ref text default null)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a profile change.';
  end if;
  update public.google_profile_changes
     set status = 'applied', applied_at = now(), external_ref = p_external_ref,
         lease_until = null, last_error = null
   where id = p_change_id;
  if found then return; end if;
  update public.meta_profile_changes
     set status = 'applied', applied_at = now(), external_ref = p_external_ref,
         lease_until = null, last_error = null
   where id = p_change_id;
  if not found then raise exception 'No such profile change.'; end if;
end $$;

revoke all on function public.record_profile_change_applied(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_profile_change_applied(uuid, text) to service_role;

create or replace function public.record_profile_change_failure(
  p_change_id uuid, p_reason text, p_retryable boolean default false)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_attempts integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a failure.';
  end if;
  select attempts into v_attempts from public.google_profile_changes where id = p_change_id;
  if v_attempts is not null then
    update public.google_profile_changes
       set status = case when coalesce(p_retryable, false) and v_attempts < 5
                         then 'approved' else 'failed' end,
           lease_until = null, last_error = p_reason
     where id = p_change_id;
    return;
  end if;
  update public.meta_profile_changes
     set status = 'failed', lease_until = null, last_error = p_reason
   where id = p_change_id;
  if not found then raise exception 'No such profile change.'; end if;
end $$;

revoke all on function public.record_profile_change_failure(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_profile_change_failure(uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- G07: a budget change, bound to its amount
-- ---------------------------------------------------------------------------

create table if not exists public.campaign_budget_changes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid not null references public.client_campaigns(id) on delete cascade,
  -- The object whose budget moves. Recorded rather than looked up at write
  -- time, so an approval cannot be redirected by a later edit.
  ad_set_external_id text not null,

  current_daily_budget numeric(12,2),
  proposed_daily_budget numeric(12,2) not null check (proposed_daily_budget > 0),
  currency text not null default 'GBP' check (length(currency) = 3),
  reason text not null check (length(btrim(reason)) between 1 and 1000),

  status text not null default 'awaiting_approval' check (status in (
    'awaiting_approval', 'approved', 'applied', 'failed', 'rejected')),
  approval_id uuid references public.campaign_action_approvals(id) on delete set null,

  attempts integer not null default 0,
  claimed_at timestamptz,
  lease_until timestamptz,
  applied_at timestamptz,
  external_ref text,
  last_error text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.campaign_budget_changes is
  'One proposed change to one ad set''s daily budget. The amount lives here and the approval hashes it, so a figure edited after the decision has no approval.';

create index if not exists campaign_budget_changes_claim_idx
  on public.campaign_budget_changes (status, lease_until);

alter table public.campaign_budget_changes enable row level security;
drop policy if exists campaign_budget_changes_read on public.campaign_budget_changes;
create policy campaign_budget_changes_read on public.campaign_budget_changes
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.campaign_budget_changes to authenticated;
grant all on public.campaign_budget_changes to service_role;

drop trigger if exists campaign_budget_changes_updated_at on public.campaign_budget_changes;
create trigger campaign_budget_changes_updated_at before update
  on public.campaign_budget_changes
  for each row execute function public.set_updated_at();

create or replace function public.request_campaign_budget_change_v6(
  p_campaign_id uuid, p_proposed_daily_budget numeric, p_reason text, p_actor uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_change public.campaign_budget_changes%rowtype;
  v_approval public.campaign_action_approvals%rowtype;
  v_multiple numeric;
  v_hash text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service can request a campaign action.';
  end if;
  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  if not found then raise exception 'No such campaign.'; end if;
  if v_campaign.meta_ad_set_id is null then
    raise exception 'This campaign has no built ad set, so there is no budget to change.';
  end if;
  if coalesce(p_proposed_daily_budget, 0) <= 0 then
    raise exception 'A daily budget has to be more than nothing. To stop spending, pause the ad set in Ads Manager.';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why the budget is changing.';
  end if;

  select * into v_manifest from public.campaign_manifest_versions
   where campaign_id = p_campaign_id order by version desc limit 1;
  if not found then raise exception 'This campaign has no package.'; end if;

  -- The sentence that catches a fat finger. A bare "£10,000" reads as a
  -- decision; "100 times the current daily budget" reads as a mistake.
  v_multiple := case
    when coalesce(v_campaign.daily_budget, 0) > 0
      then round(p_proposed_daily_budget / v_campaign.daily_budget, 2)
    else null end;

  insert into public.campaign_budget_changes (
    client_id, campaign_id, ad_set_external_id, current_daily_budget,
    proposed_daily_budget, reason, created_by)
  values (
    v_campaign.client_id, p_campaign_id, v_campaign.meta_ad_set_id,
    v_campaign.daily_budget, p_proposed_daily_budget, btrim(p_reason), p_actor)
  returning * into v_change;

  v_hash := encode(sha256(convert_to(
    v_change.ad_set_external_id || ':' || v_change.proposed_daily_budget::text, 'UTF8')), 'hex');

  select * into v_approval from public.request_campaign_action_approval_v6(
    v_manifest.id,
    'budget_change:' || v_change.id::text,
    'budget_change',
    'Meta ad set ' || v_change.ad_set_external_id,
    v_hash,
    jsonb_build_object(
      'budget_change_id', v_change.id,
      'ad_set_external_id', v_change.ad_set_external_id,
      'current_daily_budget', v_change.current_daily_budget,
      'proposed_daily_budget', v_change.proposed_daily_budget,
      'currency', v_change.currency,
      'multiple_of_current', v_multiple,
      'reason', v_change.reason));

  update public.campaign_budget_changes
     set approval_id = v_approval.id where id = v_change.id;
  return v_approval.id;
end $$;

comment on function public.request_campaign_budget_change_v6(uuid, numeric, text, uuid) is
  'Asks to change one ad set''s daily budget, recording the multiple of the current figure it represents. The approval hashes the ad set and the exact amount, so an edited figure has no approval.';

revoke all on function public.request_campaign_budget_change_v6(uuid, numeric, text, uuid)
  from public, anon, authenticated;
grant execute on function public.request_campaign_budget_change_v6(uuid, numeric, text, uuid)
  to service_role;

-- Re-checked immediately before the write, not trusted from the decision.
create or replace function public.assert_budget_change_allowed_v6(p_execution_id uuid)
returns public.campaign_budget_changes language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  x public.campaign_action_executions%rowtype;
  a public.campaign_action_approvals%rowtype;
  c public.campaign_budget_changes%rowtype;
  v_hash text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may change a budget.';
  end if;
  select * into x from public.campaign_action_executions where id = p_execution_id;
  if not found then raise exception 'No such execution.'; end if;
  select * into a from public.campaign_action_approvals where id = x.approval_id;
  if a.action_key <> 'budget_change' then
    raise exception 'That approval is a %, not a budget change.', a.action_key;
  end if;
  if a.status <> 'approved' then
    raise exception 'That budget change is %, not approved.', a.status;
  end if;

  select * into c from public.campaign_budget_changes
   where id = nullif(a.scope->>'budget_change_id', '')::uuid for update;
  if not found then raise exception 'That approval names no budget change.'; end if;
  if c.status not in ('approved', 'awaiting_approval') then
    raise exception 'That budget change is already %.', c.status;
  end if;

  -- The money check. An amount or an ad set edited after the yes produces a
  -- different hash, and this is where that is caught.
  v_hash := encode(sha256(convert_to(
    c.ad_set_external_id || ':' || c.proposed_daily_budget::text, 'UTF8')), 'hex');
  if v_hash <> a.artifact_version_hash then
    raise exception 'The budget or the ad set changed after this was approved. Ask again for the new figure.';
  end if;
  return c;
end $$;

revoke all on function public.assert_budget_change_allowed_v6(uuid)
  from public, anon, authenticated;
grant execute on function public.assert_budget_change_allowed_v6(uuid) to service_role;

create or replace function public.record_budget_change_applied(
  p_change_id uuid, p_external_ref text default null)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare c public.campaign_budget_changes%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a budget change.';
  end if;
  update public.campaign_budget_changes
     set status = 'applied', applied_at = now(), external_ref = p_external_ref,
         lease_until = null, last_error = null
   where id = p_change_id returning * into c;
  if not found then raise exception 'No such budget change.'; end if;

  -- The campaign's own figure follows what Meta now has, so the next request
  -- compares against reality rather than against the last plan.
  update public.client_campaigns
     set daily_budget = c.proposed_daily_budget
   where id = c.campaign_id;
end $$;

revoke all on function public.record_budget_change_applied(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_budget_change_applied(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- What is stopping each of them
-- ---------------------------------------------------------------------------

drop view if exists profile_change_due;

create view profile_change_due with (security_invoker = true) as
select
  c.id as change_id, c.client_id, 'google_business'::text as surface,
  'google'::text as platform, c.field, c.current_value, c.proposed_value,
  c.status, c.attempts, c.applied_at, c.last_error,
  f.writable,
  case
    when c.status = 'applied' then null
    when c.status = 'rejected' then coalesce('Rejected: ' || c.rejection_reason, 'Rejected.')
    when c.status in ('drafted', 'awaiting_approval') then 'Waiting for a person to approve it.'
    when f.writable is not true
      then 'No adapter may write this field. ' || coalesce(f.note, '')
    when not exists (select 1 from public.client_integrations i
                      where i.client_id = c.client_id and i.provider = 'google_business'
                        and i.status = 'connected')
      then 'No connected Google Business integration for this client, so nothing can be written. This adapter has never run against a real profile.'
    when c.status = 'failed'
      then 'Failed after ' || c.attempts::text || ' attempts: ' ||
           coalesce(c.last_error, 'no error recorded') || '.'
    else null
  end as blocker
from public.google_profile_changes c
left join public.profile_field_support f
  on f.surface = 'google_business' and f.platform = 'google' and f.field = c.field
union all
select
  m.id, m.client_id, 'meta', m.platform, m.field, m.current_value, m.proposed_value,
  m.status, m.attempts, m.applied_at, m.last_error,
  f.writable,
  case
    when m.status = 'applied' then null
    when m.status = 'rejected' then coalesce('Rejected: ' || m.rejection_reason, 'Rejected.')
    when m.status = 'drafted' then 'Waiting for a person to approve it.'
    when f.writable is not true
      then 'No adapter may write this field. ' || coalesce(f.note, '')
    when m.status = 'failed'
      then 'Failed: ' || coalesce(m.last_error, 'no error recorded') || '.'
    else null
  end as blocker
from public.meta_profile_changes m
left join public.profile_field_support f
  on f.surface = 'meta' and f.platform = m.platform and f.field = m.field;

comment on view profile_change_due is
  'Every proposed profile change and what stops it. A field no adapter may write says so with the instruction for the person who must do it by hand, rather than failing five times first.';

grant select on profile_change_due to authenticated;

drop view if exists budget_change_due;

create view budget_change_due with (security_invoker = true) as
select
  c.id as change_id, c.client_id, c.campaign_id, c.ad_set_external_id,
  c.current_daily_budget, c.proposed_daily_budget, c.currency, c.reason,
  c.status, c.attempts, c.applied_at, c.last_error,
  case when coalesce(c.current_daily_budget, 0) > 0
       then round(c.proposed_daily_budget / c.current_daily_budget, 2)
       else null end as multiple_of_current,
  a.status as approval_status,
  case
    when c.status = 'applied' then null
    when c.status = 'rejected' then 'Rejected.'
    when a.id is null then 'No approval has been requested for this change.'
    when a.status = 'rejected'
      then 'The request was rejected' || coalesce(': ' || a.rejection_reason, '') || '.'
    when a.status <> 'approved' then 'Waiting for a person to approve it.'
    when not coalesce(s.campaign_actions_enabled, false)
      then 'External campaign actions are off for this client.'
    when c.status = 'failed'
      then 'Failed after ' || c.attempts::text || ' attempts: ' ||
           coalesce(c.last_error, 'no error recorded') || '.'
    else null
  end as blocker
from public.campaign_budget_changes c
left join public.campaign_action_approvals a on a.id = c.approval_id
left join public.client_engine_settings s on s.client_id = c.client_id;

comment on view budget_change_due is
  'Every proposed budget change with the multiple of the current figure it represents, and what stops it. The multiple is shown because the realistic mistake is a typo, not a disagreement.';

grant select on budget_change_due to authenticated;

-- ---------------------------------------------------------------------------
-- Both actions become supported
-- ---------------------------------------------------------------------------

update public.campaign_action_executors
   set supported = true,
       note = 'Applies an approved profile change through the platform''s API, for the fields that platform permits an adapter to write. Fields it does not are never claimed: they stay approved and visible as a job for a person. The Google adapter has not yet run against a real profile, because no client has a connected credential.'
 where action_key = 'profile_update';

update public.campaign_action_executors
   set supported = true,
       note = 'Changes one ad set''s daily budget to the exact figure a person approved, re-hashing the ad set and the amount immediately before the write so an edited figure cannot ride on an old decision.'
 where action_key = 'budget_change';

-- ---------------------------------------------------------------------------
-- The worker, and when it runs
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_profile_update_sweep()
returns uuid language plpgsql security definer
set search_path to 'public' as $$
declare v_job uuid;
begin
  if exists (select 1 from agent_jobs
              where agent_key = 'profile_updater'
                and status in ('queued', 'claimed', 'running')) then
    return null;
  end if;
  -- Only an approved change on a writable field is worth a worker. An
  -- Instagram bio waiting for a person must not wake this up every hour.
  if not exists (
       select 1 from google_profile_changes c
        join profile_field_support f
          on f.surface = 'google_business' and f.platform = 'google' and f.field = c.field
        where c.status = 'approved' and f.writable and c.attempts < 5) then
    return null;
  end if;
  insert into agent_jobs (agent_key, params)
  values ('profile_updater', jsonb_build_object('limit', 5))
  returning id into v_job;
  return v_job;
end $$;

revoke all on function public.enqueue_profile_update_sweep() from public, anon;
grant execute on function public.enqueue_profile_update_sweep() to authenticated, service_role;

insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('profile_updater', 'Profile Updater', 'PU', null,
   'Applies approved profile changes for the fields a platform permits an adapter to write. Fields it does not are never claimed: they stay approved and visible as a job for a person.',
   array[]::text[])
on conflict (agent_key) do update
  set name = excluded.name, initials = excluded.initials,
      description = excluded.description, requires_upstream = excluded.requires_upstream;

-- Twice an hour. A profile field is never urgent, and a slower cadence keeps
-- a misconfigured change from being retried five times in a minute.
select cron.unschedule('profile-update-sweep')
 where exists (select 1 from cron.job where jobname = 'profile-update-sweep');
select cron.schedule('profile-update-sweep', '5,35 * * * *',
  $cron$ select public.enqueue_profile_update_sweep(); $cron$);

select lock_down_definer_functions();
