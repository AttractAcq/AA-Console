-- An owner-requested Meta GET can inspect an uncertain budget write. A value
-- match is an observation, not proof that this action caused the change.
begin;

create table public.campaign_budget_readbacks_v6 (
 id uuid primary key default gen_random_uuid(),
 execution_id uuid not null references public.campaign_action_executions(id) on delete restrict,
 client_id uuid not null references public.clients(id) on delete restrict,
 ad_set_external_id text not null,
 account_id text not null,
 observed_currency text not null,
 observed_daily_budget_minor bigint not null check (observed_daily_budget_minor>=0),
 result text not null check (result in ('matches_proposed','matches_prior','different')),
 checked_at timestamptz not null default clock_timestamp()
);
create index campaign_budget_readbacks_execution_idx
 on public.campaign_budget_readbacks_v6(execution_id,checked_at desc,id desc);
alter table public.campaign_budget_readbacks_v6 enable row level security;
revoke all on public.campaign_budget_readbacks_v6 from public,anon,authenticated,service_role;

insert into public.agents
 (agent_key,name,initials,domain,description,requires_upstream,config,paused)
values ('campaign_budget_reconciler','Meta Budget Readback','BR','meta',
 'Reads the ad set after an uncertain campaign budget action without repeating the write.',
 '{}','{}',false)
on conflict (agent_key) do nothing;

create unique index campaign_budget_one_active_readback_job_v6
 on public.agent_jobs(input_id)
 where agent_key='campaign_budget_reconciler'
  and input_table='campaign_action_executions'
  and input_id is not null and status in ('queued','claimed','running','paused');

create function public.request_campaign_budget_readback_v6(p_execution_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare e public.campaign_action_executions%rowtype;
 a public.campaign_action_approvals%rowtype;
 v_job uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null
  or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 owner must request this Meta budget readback.'
   using errcode='42501'; end if;
 select * into e from public.campaign_action_executions where id=p_execution_id for update;
 if e.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(e.client_id),false)) then
  raise exception 'Only the client approval owner may request budget readback.'
   using errcode='42501'; end if;
 select * into a from public.campaign_action_approvals
  where id=e.approval_id and client_id=e.client_id;
 if a.id is null or a.action_key<>'budget_change'
  or not (e.status='uncertain' or
   (e.status='executing' and (e.lease_until is null or e.lease_until<=now())))
  or coalesce(a.scope->>'ad_set_external_id','') !~ '^[0-9]+$'
  or nullif(a.scope->>'budget_change_id','') is null then
  raise exception 'An uncertain exact Meta budget action is required.'
   using errcode='23514'; end if;
 select id into v_job from public.agent_jobs
  where agent_key='campaign_budget_reconciler'
   and input_table='campaign_action_executions' and input_id=e.id
   and status in ('queued','claimed','running','paused')
  order by created_at desc limit 1;
 if v_job is not null then return v_job; end if;
 insert into public.agent_jobs
  (agent_key,client_id,input_table,input_id,params,created_by)
 values ('campaign_budget_reconciler',e.client_id,'campaign_action_executions',e.id,
  jsonb_build_object('execution_id',e.id,'approval_id',a.id),auth.uid())
 returning id into v_job;
 return v_job;
end $$;

create function public.campaign_budget_readback_target_v6(
 p_execution_id uuid,p_client_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare e public.campaign_action_executions%rowtype;
 a public.campaign_action_approvals%rowtype;
begin
 if auth.role() is distinct from 'service_role' then return null; end if;
 select * into e from public.campaign_action_executions
  where id=p_execution_id and client_id=p_client_id;
 select * into a from public.campaign_action_approvals
  where id=e.approval_id and client_id=e.client_id;
 if e.id is null or a.id is null or a.action_key<>'budget_change'
  or not (e.status='uncertain' or
   (e.status='executing' and (e.lease_until is null or e.lease_until<=now())))
  or coalesce(a.scope->>'ad_set_external_id','') !~ '^[0-9]+$'
  or nullif(a.scope->>'currency','') is null
  or not public.meta_budget_credential_eligible_v6(e.client_id) then
  return null; end if;
 return jsonb_build_object('execution_id',e.id,'client_id',e.client_id,
  'ad_set_external_id',a.scope->>'ad_set_external_id',
  'currency',a.scope->>'currency',
  'prior_daily_budget',a.scope->>'current_daily_budget',
  'proposed_daily_budget',a.scope->>'proposed_daily_budget');
end $$;

create function public.record_campaign_budget_readback_v6(
 p_execution_id uuid,p_client_id uuid,p_ad_set_external_id text,
 p_account_id text,p_observed_currency text,p_observed_daily_budget_minor bigint)
returns text language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare e public.campaign_action_executions%rowtype;
 a public.campaign_action_approvals%rowtype;
 v_result text;
 v_proposed numeric;
 v_prior numeric;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Only the trusted Meta reader may record budget readback.'
   using errcode='42501'; end if;
 select * into e from public.campaign_action_executions
  where id=p_execution_id and client_id=p_client_id for update;
 select * into a from public.campaign_action_approvals
  where id=e.approval_id and client_id=e.client_id;
 if e.id is null or a.id is null or a.action_key<>'budget_change'
  or not (e.status='uncertain' or
   (e.status='executing' and (e.lease_until is null or e.lease_until<=now())))
  or p_ad_set_external_id is distinct from a.scope->>'ad_set_external_id'
  or coalesce(p_account_id,'') !~ '^act_[0-9]+$'
  or not exists(select 1 from public.client_integrations i
   where i.client_id=e.client_id and i.provider='meta'
    and i.ad_account_id=p_account_id)
  or p_observed_daily_budget_minor is null or p_observed_daily_budget_minor<0
  or not public.meta_budget_credential_eligible_v6(e.client_id) then
  raise exception 'The uncertain budget action, target or credential changed.'
   using errcode='23514'; end if;
 v_proposed:=nullif(a.scope->>'proposed_daily_budget','')::numeric;
 v_prior:=nullif(a.scope->>'current_daily_budget','')::numeric;
 v_result:=case
  when p_observed_currency=a.scope->>'currency'
   and p_observed_daily_budget_minor=round(v_proposed*100)::bigint
   then 'matches_proposed'
  when p_observed_currency=a.scope->>'currency'
   and p_observed_daily_budget_minor=round(v_prior*100)::bigint
   then 'matches_prior'
  else 'different' end;
 insert into public.campaign_budget_readbacks_v6
  (execution_id,client_id,ad_set_external_id,account_id,
   observed_currency,observed_daily_budget_minor,result)
 values (e.id,e.client_id,p_ad_set_external_id,p_account_id,
  p_observed_currency,p_observed_daily_budget_minor,v_result);
 return v_result;
end $$;

create view public.campaign_budget_readback_overview_v6
with (security_barrier=true) as
select r.id,r.execution_id,r.client_id,r.ad_set_external_id,r.account_id,
 r.observed_currency,r.observed_daily_budget_minor,r.result,r.checked_at
from public.campaign_budget_readbacks_v6 r
where public.can_access_client(r.client_id);

revoke all on function public.request_campaign_budget_readback_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.request_campaign_budget_readback_v6(uuid) to authenticated;
revoke all on function public.campaign_budget_readback_target_v6(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.campaign_budget_readback_target_v6(uuid,uuid) to service_role;
revoke all on function public.record_campaign_budget_readback_v6(uuid,uuid,text,text,text,bigint)
 from public,anon,authenticated,service_role;
grant execute on function public.record_campaign_budget_readback_v6(uuid,uuid,text,text,text,bigint)
 to service_role;
revoke all on public.campaign_budget_readback_overview_v6
 from public,anon,authenticated,service_role;
grant select on public.campaign_budget_readback_overview_v6 to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','463 exact budget source and old/proposed amount; 467 retires generic profile action',
 'verified','274 AAL2 action decision; 464 current budget invalidation',
 'blocked','466 reviewed credential gate; Meta preflight/readback; 490 uncertainty; 493 owner-requested read-only observation',
 'Verify a live Meta account and approved budget-write receipt; inspect any uncertain readback and historical profile actions.'
from public.approval_class_coverage_v6 c where c.class_id=24;

select public.lock_down_definer_functions();
commit;
