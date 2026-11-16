-- Preserve the difference between a known failure and an external effect
-- whose final receipt could not be recorded or read back.
begin;

alter table public.campaign_action_executions
 drop constraint campaign_action_executions_status_check;
alter table public.campaign_action_executions
 add constraint campaign_action_executions_status_check
 check (status in ('executing','executed','failed','abandoned','uncertain'));
alter table public.campaign_action_attempts_v6
 drop constraint campaign_action_attempts_v6_status_check;
alter table public.campaign_action_attempts_v6
 add constraint campaign_action_attempts_v6_status_check
 check (status in ('executing','executed','failed','abandoned','uncertain'));
alter table public.campaign_action_events
 drop constraint campaign_action_events_event_check;
alter table public.campaign_action_events
 add constraint campaign_action_events_event_check
 check (event in ('claimed','executed','failed','abandoned','reaped','uncertain'));

create or replace function public.guard_campaign_action_execution()
returns trigger language plpgsql
set search_path=pg_catalog,public as $$
begin
 if new.approval_id is distinct from old.approval_id
  or new.client_id is distinct from old.client_id
  or new.campaign_id is distinct from old.campaign_id
  or new.action_key is distinct from old.action_key
  or new.manifest_id is distinct from old.manifest_id
  or new.artifact_version_hash is distinct from old.artifact_version_hash then
  raise exception 'An execution cannot change which approval, campaign, action or version it belongs to.';
 end if;
 if old.status in ('executed','abandoned','uncertain')
  and new.status is distinct from old.status then
  raise exception 'That execution is already %.',old.status;
 end if;
 if new.status is distinct from old.status
  and not (old.status,new.status) in
   (('executing','executed'),('executing','failed'),('executing','abandoned'),
    ('executing','uncertain'),('failed','executing'),('failed','abandoned')) then
  raise exception 'An execution cannot go from % to %.',old.status,new.status;
 end if;
 new.updated_at:=now();
 return new;
end $$;

create or replace function public.sync_campaign_action_attempt_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
begin
 if new.attempts<1 then
  raise exception 'An execution attempt needs a positive attempt number.' using errcode='23514'; end if;
 if new.status='executing' then
  if tg_op='INSERT' or old.status is distinct from 'executing'
   or old.attempts is distinct from new.attempts then
   insert into public.campaign_action_attempts_v6
    (execution_id,attempt_number,approval_id,client_id,action_key,
     artifact_version_hash,status,started_at)
   values (new.id,new.attempts,new.approval_id,new.client_id,new.action_key,
    new.artifact_version_hash,'executing',coalesce(new.claimed_at,now()));
  end if;
 elsif new.status in ('executed','failed','abandoned','uncertain') then
  if new.status='executed' and new.action_key in ('page_deploy','budget_change')
   and nullif(btrim(coalesce(new.external_id,'')),'') is null
   and nullif(btrim(coalesce(new.external_url,'')),'') is null then
   raise exception 'An external campaign action needs an observed provider reference.'
    using errcode='23514'; end if;
  update public.campaign_action_attempts_v6 a set
   status=new.status,finished_at=coalesce(a.finished_at,new.executed_at,now()),
   external_id=new.external_id,external_url=new.external_url,
   result=new.result,error=new.last_error
  where a.execution_id=new.id and a.attempt_number=new.attempts
   and a.status in ('executing','failed');
  if not found and (tg_op='INSERT' or old.status is distinct from new.status) then
   raise exception 'An outcome has no matching started attempt.' using errcode='23514'; end if;
 end if;
 return new;
end $$;

create function public.record_campaign_action_uncertain_v6(
 p_execution_id uuid,p_reason text,p_external_id text default null,
 p_external_url text default null,p_result jsonb default null)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare v public.campaign_action_executions%rowtype;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Only the trusted action worker may record uncertainty.'
   using errcode='42501'; end if;
 if nullif(btrim(coalesce(p_reason,'')),'') is null then
  raise exception 'An uncertain action needs an inspection reason.' using errcode='22023'; end if;
 update public.campaign_action_executions
  set status='uncertain',last_error=btrim(p_reason),lease_until=null,
   external_id=nullif(btrim(p_external_id),''),
   external_url=nullif(btrim(p_external_url),''),result=p_result
  where id=p_execution_id and status='executing'
  returning * into v;
 if v.id is null then
  raise exception 'Only a running action can record an uncertain outcome.'
   using errcode='23514'; end if;
 insert into public.campaign_action_events
  (execution_id,client_id,event,actor,detail,external_ref)
 values (v.id,v.client_id,'uncertain','agent',btrim(p_reason),
  coalesce(v.external_url,v.external_id));
end $$;
revoke all on function public.record_campaign_action_uncertain_v6(uuid,text,text,text,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function public.record_campaign_action_uncertain_v6(uuid,text,text,text,jsonb)
 to service_role;

create or replace view public.campaign_action_due with (security_invoker=true) as
select a.id as approval_id,a.client_id,a.campaign_id,a.action_key,a.destination,
 a.artifact_version_hash,a.manifest_id,a.scope,e.id as execution_id,
 coalesce(e.status,'not_attempted') as execution_status,
 coalesce(e.attempts,0) as attempts,e.external_id,e.external_url,e.last_error,
 x.executor_module,
 case
  when r.approval_id is not null and e.status='uncertain'
   then 'Approval revoked; provider effect may still have happened. Inspect the destination. '||coalesce(e.last_error,'Outcome unknown.')
  when r.approval_id is not null and e.status='executed'
   then 'Approval revoked after execution; an external effect may remain live. Reason: '||r.reason
  when r.approval_id is not null
   then 'Approval revoked; no further execution is authorized. Reason: '||r.reason
  when e.status='uncertain'
   then 'Provider effect may have happened; inspect the destination before any new approval. '||coalesce(e.last_error,'Outcome unknown.')
  when e.status='executed' then 'Already done.'
  when e.status='abandoned'
   then 'Abandoned after a failure that cannot be safely retried: '||coalesce(e.last_error,'no reason recorded')||'.'
  when exists(select 1 from public.campaign_manifest_versions v
   where v.campaign_id=a.campaign_id and v.version>m.version)
   then 'The campaign package was superseded after this was approved. Request approval against the current package.'
  when x.supported is not true
   then 'There is no executor for '||replace(a.action_key,'_',' ')||' yet.'
  when not coalesce(ces.campaign_actions_enabled,false)
   then 'External campaign actions are off for this client.'
  when e.status='executing' and e.lease_until>now() then 'Being executed now.'
  when coalesce(e.attempts,0)>=5
   then 'Failed '||e.attempts::text||' times. Last error: '||coalesce(e.last_error,'none recorded')||'.'
  else null end as blocker
from public.campaign_action_approvals a
join public.campaign_manifest_versions m on m.id=a.manifest_id
join public.campaign_action_executors x on x.action_key=a.action_key
left join public.campaign_action_executions e on e.approval_id=a.id
left join public.client_engine_settings ces on ces.client_id=a.client_id
left join public.campaign_action_revocations_v6 r on r.approval_id=a.id
where a.status='approved';
comment on view public.campaign_action_due is
 'Approved campaign actions, including uncertainty, revocations and observed outcomes.';

revoke all on function public.guard_campaign_action_execution()
 from public,anon,authenticated,service_role;
revoke all on function public.sync_campaign_action_attempt_v6()
 from public,anon,authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','274 exact action Inbox source; 325 atomic handler-owned claim',
 'verified','274 AAL2 decision; 331 revocation',
 'blocked','328 per-attempt receipt; 490 explicit uncertain terminal result',
 'Owned runtime release, live provider preflight/receipt and unknown-outcome reconciliation are outstanding.'
from public.approval_class_coverage_v6 c where c.class_id=6;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','463 exact budget source and old/proposed amount; 467 retires generic profile action',
 'verified','274 AAL2 action decision; 464 current budget invalidation',
 'blocked','466 reviewed credential gate; Meta preflight/readback; 490 uncertain effect receipt',
 'Verify a live Meta account and approved budget-write receipt; reconcile historical profile actions and uncertain writes.'
from public.approval_class_coverage_v6 c where c.class_id=24;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','274 exact HTML preview and page snapshot',
 'verified','274 AAL2 action decision; 330 prewrite recheck',
 'blocked','page-deploy GitHub commit and intake probe; 490 uncertain effect receipt',
 'Verify an authorized live publish and intake probe; reconcile historical page effects and uncertain commits.'
from public.approval_class_coverage_v6 c where c.class_id=27;

select public.lock_down_definer_functions();
commit;
