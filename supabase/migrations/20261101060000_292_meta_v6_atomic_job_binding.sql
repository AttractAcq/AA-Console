-- B012: bind one approved Meta action execution to one durable build job.
--
-- This is a producer and identity guard, not a dispatcher. The runtime still
-- has no meta_ad_build HANDLER, and no client/global external switch changes
-- here. Paused Meta objects are external writes; the B010 pre-write gate and
-- legacy request_meta_build bypass remain separate release blockers.

-- Migration 239 includes human_approved_at::text in its build hash. A
-- timestamptz-to-text cast varies by the caller's TimeZone. A request made
-- in one timezone could be refused by a worker using UTC despite unchanged
-- creative. Preserve any existing exact decisions by stopping for review
-- instead of silently changing the meaning of their stored hash.
do $$
begin
  if exists (select 1 from public.campaign_action_approvals
              where action_key = 'meta_ad_build') then
    raise exception 'Review existing Meta build approvals before installing canonical UTC hashing.';
  end if;
end $$;
alter function public.meta_build_payload_hash_v6(uuid) set timezone = 'UTC';
comment on function public.meta_build_payload_hash_v6(uuid) is
  'Exact Meta build payload hash from migration 239, with its approved creative timestamps rendered in UTC regardless of the caller timezone.';

alter table public.campaign_action_executions
  add column meta_build_job_id uuid references public.agent_jobs(id) on delete restrict,
  add constraint campaign_action_meta_build_job_only
    check (meta_build_job_id is null or action_key = 'meta_ad_build');

create unique index campaign_action_meta_build_job_id_uniq
  on public.campaign_action_executions (meta_build_job_id)
  where meta_build_job_id is not null;

-- One operational campaign gets one Meta build, even when two distinct
-- version-bound approvals were decided for that campaign. A failed or
-- ambiguous attempt must be reconciled, not turned into a second job.
create unique index campaign_action_one_meta_build_per_campaign
  on public.campaign_action_executions (campaign_id)
  where action_key = 'meta_ad_build' and meta_build_job_id is not null;

comment on column public.campaign_action_executions.meta_build_job_id is
  'The one durable Meta job atomically queued for this approved execution. Immutable once set; one bound Meta build per operational campaign.';

create function public.guard_meta_build_execution_binding()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare v_job public.agent_jobs%rowtype;
begin
  if tg_op = 'UPDATE' and old.meta_build_job_id is not null
     and new.meta_build_job_id is distinct from old.meta_build_job_id then
    raise exception 'A Meta execution cannot change or release its bound job.';
  end if;
  if new.meta_build_job_id is null then
    if tg_op = 'UPDATE' and old.meta_build_job_id is not null then
      raise exception 'A Meta execution cannot lose its bound job.';
    end if;
    return new;
  end if;
  if new.action_key <> 'meta_ad_build' then
    raise exception 'Only a Meta build execution may bind a Meta job.';
  end if;
  if jsonb_typeof(new.result) is distinct from 'object'
     or new.result->>'meta_build_job_id' is distinct from new.meta_build_job_id::text then
    raise exception 'The Meta execution result must retain its exact job binding.';
  end if;
  select * into v_job from public.agent_jobs where id = new.meta_build_job_id;
  if not found or v_job.agent_key <> 'meta_build'
     or v_job.client_id is distinct from new.client_id
     or v_job.input_table is distinct from 'client_campaigns'
     or v_job.input_id is distinct from new.campaign_id
     or v_job.params->>'campaign_action_execution_id' is distinct from new.id::text
     or v_job.params->>'campaign_action_approval_id' is distinct from new.approval_id::text then
    raise exception 'The bound Meta job does not match this exact execution.';
  end if;
  return new;
end $$;

create trigger guard_meta_build_execution_binding
  before insert or update on public.campaign_action_executions
  for each row execute function public.guard_meta_build_execution_binding();

create function public.guard_bound_meta_build_job_identity()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if exists (select 1 from public.campaign_action_executions x
              where x.meta_build_job_id = old.id)
     and (new.agent_key is distinct from old.agent_key
       or new.client_id is distinct from old.client_id
       or new.input_table is distinct from old.input_table
       or new.input_id is distinct from old.input_id
       or new.params is distinct from old.params) then
    raise exception 'A bound Meta job cannot change its action identity or parameters.';
  end if;
  return new;
end $$;

create trigger guard_bound_meta_build_job_identity
  before update on public.agent_jobs
  for each row execute function public.guard_bound_meta_build_job_identity();

-- Called only by a future meta_ad_build action handler. The function owns the
-- transaction: enqueue_agent_job_internal and the typed execution binding
-- either both commit or both roll back. The row lock and campaign-wide unique
-- index prevent two approvals/claims from creating two Meta builds.
create function public.enqueue_approved_meta_build_v6(p_execution_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public
set timezone = 'UTC' as $$
declare
  v_execution public.campaign_action_executions%rowtype;
  v_approval public.campaign_action_approvals%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_account text;
  v_allowed_approval uuid;
  v_job uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service may queue an approved Meta build.';
  end if;
  select * into v_execution from public.campaign_action_executions
   where id = p_execution_id for update;
  if not found then raise exception 'Meta build execution not found.'; end if;
  select * into v_campaign from public.client_campaigns
   where id = v_execution.campaign_id for update;
  if not found then raise exception 'Meta build campaign not found.'; end if;
  select * into v_approval from public.campaign_action_approvals
   where id = v_execution.approval_id;
  if not found then raise exception 'Meta build approval not found.'; end if;

  if v_campaign.acquisition_mode is distinct from 'paid'
     or v_campaign.paid_platform is distinct from 'meta'
     or v_campaign.client_id is distinct from v_execution.client_id
     or v_execution.action_key <> 'meta_ad_build'
     or v_execution.status <> 'executing'
     or v_execution.lease_until is null or v_execution.lease_until <= now()
     or v_approval.status <> 'approved'
     or v_approval.client_id is distinct from v_execution.client_id
     or v_approval.campaign_id is distinct from v_execution.campaign_id
     or v_approval.action_key <> v_execution.action_key
     or v_approval.manifest_id is distinct from v_execution.manifest_id
     or v_approval.artifact_version_hash is distinct from v_execution.artifact_version_hash then
    raise exception 'The Meta build execution is not a current exact approved claim.';
  end if;

  select ad_account_id into v_account from public.client_integrations
   where client_id = v_campaign.client_id and provider = 'meta';
  if nullif(btrim(coalesce(v_account, '')), '') is null
     or v_approval.destination is distinct from 'meta:' || v_account
     or v_approval.scope->>'ad_account' is distinct from v_account then
    raise exception 'The Meta account is not the exact approved destination.';
  end if;

  -- Migration 239 checks the current package/hash, client switch and whether
  -- Meta objects already exist. Its "latest approval" must be this claim.
  v_allowed_approval := public.assert_meta_build_allowed_v6(v_campaign.id);
  if v_allowed_approval is distinct from v_execution.approval_id then
    raise exception 'A different Meta build approval is now current.';
  end if;

  if v_execution.meta_build_job_id is not null then
    -- A second call returns the original job, even after it failed. The
    -- caller must inspect that job; it may not make another one.
    return v_execution.meta_build_job_id;
  end if;
  if exists (select 1 from public.campaign_action_executions x
              where x.campaign_id = v_campaign.id and x.action_key = 'meta_ad_build'
                and x.meta_build_job_id is not null) then
    raise exception 'This campaign already has a bound Meta build job. Reconcile that outcome before another build.';
  end if;
  if exists (select 1 from public.agent_jobs j
              where j.agent_key = 'meta_build'
                and j.input_table = 'client_campaigns' and j.input_id = v_campaign.id) then
    raise exception 'This campaign already has a Meta build job. Reconcile that outcome before another build.';
  end if;

  v_job := public.enqueue_agent_job_internal(
    'meta_build', v_campaign.client_id, 'client_campaigns', v_campaign.id,
    auth.uid(),
    jsonb_build_object(
      'campaign_action_execution_id', v_execution.id,
      'campaign_action_approval_id', v_execution.approval_id),
    'Queued: exact approved Meta build, paused');
  update public.campaign_action_executions
     set meta_build_job_id = v_job,
         result = coalesce(v_execution.result, '{}'::jsonb)
           || jsonb_build_object('meta_build_job_id', v_job)
   where id = v_execution.id and status = 'executing'
     and lease_until > now() and meta_build_job_id is null;
  if not found then
    raise exception 'The Meta build claim changed before its job could be bound.';
  end if;
  return v_job;
end $$;

revoke all on function public.enqueue_approved_meta_build_v6(uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_approved_meta_build_v6(uuid)
  to service_role;

comment on function public.enqueue_approved_meta_build_v6(uuid) is
  'Atomically binds one exact approved Meta action execution to one paused-build job; does not dispatch or mark the action executed.';

select lock_down_definer_functions();
