-- An expired execution lease can hide an external effect after a worker crash.
-- Keep the row immutable for reconciliation, but project it as uncertain and
-- hold the owning queue before another approval or request.
begin;

create or replace view public.campaign_action_due with (security_invoker=true) as
select a.id as approval_id,a.client_id,a.campaign_id,a.action_key,a.destination,
 a.artifact_version_hash,a.manifest_id,a.scope,e.id as execution_id,
 case when e.status='executing' and (e.lease_until is null or e.lease_until<=now()) then 'uncertain'
  else coalesce(e.status,'not_attempted') end as execution_status,
 coalesce(e.attempts,0) as attempts,e.external_id,e.external_url,e.last_error,
 x.executor_module,
 case
  when r.approval_id is not null and e.status='executing' and (e.lease_until is null or e.lease_until<=now())
   then 'Approval revoked; execution lease expired and provider effect may still have happened. Inspect the destination.'
  when r.approval_id is not null and e.status='uncertain'
   then 'Approval revoked; provider effect may still have happened. Inspect the destination. '||coalesce(e.last_error,'Outcome unknown.')
  when r.approval_id is not null and e.status='executed'
   then 'Approval revoked after execution; an external effect may remain live. Reason: '||r.reason
  when r.approval_id is not null
   then 'Approval revoked; no further execution is authorized. Reason: '||r.reason
  when e.status='executing' and (e.lease_until is null or e.lease_until<=now())
   then 'Execution lease expired; provider effect may have happened. Inspect the destination before any new approval.'
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


create or replace view public.client_external_outcomes_v6
with (security_barrier=true) as
select e.id as outcome_id,e.client_id,'campaign_action'::text as source_kind,
 case when e.status='executing' and (e.lease_until is null or e.lease_until<=now())
  then 'uncertain' else e.status end as outcome,
 coalesce(e.executed_at,e.updated_at) as occurred_at,
 coalesce(e.external_url,e.external_id) as external_ref,
 '/clients/'||e.client_id::text||'/delivery/approval-inbox?tab=campaign-actions' as owning_path
from public.campaign_action_executions e
where (e.status in ('executed','failed','abandoned','uncertain')
  or (e.status='executing' and (e.lease_until is null or e.lease_until<=now())))
 and (e.status<>'executed' or e.external_url is not null or e.external_id is not null)
 and (public.is_admin() or auth.uid()=public.active_video_approval_manager(e.client_id))
union all
select a.id,a.client_id,'google_review_reply',
 case when c.result='matched' then 'confirmed'
  when c.result in ('pending','rejected','different','unverified') then c.result
  when a.status='confirmed' and a.provider_state is distinct from 'APPROVED'
   then 'unverified'
  else a.status end,
 coalesce(c.checked_at,a.finished_at),
 case when c.result='matched'
  or (a.status='confirmed' and a.provider_state='APPROVED') then
  case when a.review_ref like 'accounts/%' then a.review_ref
   else a.location_ref||'/reviews/'||a.review_ref end
  else null end,
 '/clients/'||a.client_id::text||'/google-profile?tab=reviews'
from public.google_reply_execution_attempts_v6 a
left join lateral (select result,checked_at
 from public.google_reply_reconciliation_checks_v6 c
 where c.attempt_id=a.id
 order by (result='matched') desc,checked_at desc,id desc limit 1) c on true
where a.status in ('confirmed','refused','uncertain')
 and public.can_access_client(a.client_id)
union all
select g.id,g.client_id,'google_review_reply','unverified',
 coalesce(g.posted_at,g.updated_at),null,
 '/clients/'||g.client_id::text||'/google-profile?tab=reviews'
from public.google_review_replies g
where g.status='posted'
 and not exists(select 1 from public.google_reply_execution_attempts_v6 a
  where a.reply_id=g.id)
 and public.can_access_client(g.client_id)
union all
select a.id,a.client_id,'google_profile_change',
 case when c.result='matched' then 'confirmed'
  when c.result='different' then 'different' else a.status end,
 coalesce(c.checked_at,a.finished_at),
 case when c.result='matched' then c.provider_ref
  when a.status='confirmed' then a.provider_ref else null end,
 '/clients/'||a.client_id::text||'/google-profile?tab=location'
from public.google_profile_execution_attempts_v6 a
left join lateral (select result,checked_at,provider_ref
 from public.google_profile_reconciliation_checks_v6 c
 where c.attempt_id=a.id
 order by (result='matched') desc,checked_at desc,id desc limit 1) c on true
where a.status in ('confirmed','refused','uncertain')
 and public.can_access_client(a.client_id)
union all
select a.id,a.client_id,'meta_profile_change',
 case when c.result='matched' then 'confirmed'
  when c.result='different' then 'different' else a.status end,
 coalesce(c.checked_at,a.finished_at),
 case when c.result='matched' then c.provider_ref
  when a.status='confirmed' then a.provider_ref else null end,
 '/clients/'||a.client_id::text||'/meta-profile?tab=profile'
from public.meta_profile_execution_attempts_v6 a
left join lateral (select result,checked_at,provider_ref
 from public.meta_profile_reconciliation_checks_v6 c
 where c.attempt_id=a.id
 order by (result='matched') desc,checked_at desc,id desc limit 1) c on true
where a.status in ('confirmed','refused','uncertain')
 and public.can_access_client(a.client_id);

revoke all on public.client_external_outcomes_v6 from public,anon,authenticated,service_role;
grant select on public.client_external_outcomes_v6 to authenticated,service_role;
comment on view public.client_external_outcomes_v6 is
 'Client-scoped external outcomes. Uncertain or lease-expired campaign effects and historical Google replies without verified receipts are not counted as success.';

select public.lock_down_definer_functions();
commit;
