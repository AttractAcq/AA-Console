-- Keep the owning queue and Dashboard truthful after an approved action is
-- withdrawn. A revocation cannot erase an already observed external effect.
begin;
create or replace view public.campaign_action_due with (security_invoker = true) as
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
    when r.approval_id is not null and e.status = 'executed'
      then 'Approval revoked after execution; an external effect may remain live. Reason: ' || r.reason
    when r.approval_id is not null
      then 'Approval revoked; no further execution is authorized. Reason: ' || r.reason
    when exists (select 1 from public.campaign_manifest_versions v
                  where v.campaign_id = a.campaign_id and v.version > m.version)
      then 'The campaign package was superseded after this was approved. Request approval against the current package.'
    when x.supported is not true
      then 'There is no executor for ' || replace(a.action_key, '_', ' ') || ' yet.'
    when not coalesce(ces.campaign_actions_enabled, false)
      then 'External campaign actions are off for this client.'
    when e.status = 'executed' then 'Already done.'
    when e.status = 'abandoned'
      then 'Abandoned after a failure that cannot be safely retried: ' || coalesce(e.last_error, 'no reason recorded') || '.'
    when e.status = 'executing' and e.lease_until > now()
      then 'Being executed now.'
    when coalesce(e.attempts, 0) >= 5
      then 'Failed ' || e.attempts::text || ' times. Last error: ' || coalesce(e.last_error, 'none recorded') || '.'
    else null
  end as blocker
from public.campaign_action_approvals a
join public.campaign_manifest_versions m on m.id = a.manifest_id
join public.campaign_action_executors x on x.action_key = a.action_key
left join public.campaign_action_executions e on e.approval_id = a.id
left join public.client_engine_settings ces on ces.client_id = a.client_id
left join public.campaign_action_revocations_v6 r on r.approval_id = a.id
where a.status = 'approved';
comment on view public.campaign_action_due is
  'Approved campaign actions, including later revocations and externally observed outcomes.';
commit;
