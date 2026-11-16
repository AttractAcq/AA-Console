-- Phase 2: a claim is not permission to act forever. Recheck the current
-- decision, client switch, build and execution lease before each effect.
begin;
create function public.assert_campaign_action_prewrite_v6(
  p_execution_id uuid,p_worker_id text,p_build_sha text,p_action_key text)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_execution public.campaign_action_executions%rowtype;
  v_approval public.campaign_action_approvals%rowtype;
  v_request public.approval_requests_v6%rowtype;
  v_decision public.approval_decision_events_v6%rowtype;
  v_heartbeat public.agent_runtime_heartbeats%rowtype;
  v_registry public.campaign_action_executors%rowtype;
  v_inbox record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service may preflight a campaign action.'
      using errcode = '42501';
  end if;
  if p_worker_id is null or p_worker_id !~ '^agent-runtime:[0-9]+:[0-9a-f-]{36}$'
    or p_build_sha is null or p_build_sha !~ '^[0-9a-f]{40}$'
    or p_action_key not in ('proof_publish','page_deploy','lead_message','budget_change') then
    raise exception 'A bounded deployed handler identity is required.' using errcode = '22023';
  end if;
  select * into v_execution from public.campaign_action_executions
    where id = p_execution_id for share;
  if not found or v_execution.status <> 'executing'
    or v_execution.lease_until is null or v_execution.lease_until <= clock_timestamp()
    or v_execution.action_key is distinct from p_action_key then
    raise exception 'The action claim is absent, expired or changed.' using errcode = '23514';
  end if;
  select * into v_approval from public.campaign_action_approvals
    where id = v_execution.approval_id for share;
  if not found or v_approval.status <> 'approved'
    or v_approval.client_id is distinct from v_execution.client_id
    or v_approval.campaign_id is distinct from v_execution.campaign_id
    or v_approval.manifest_id is distinct from v_execution.manifest_id
    or v_approval.action_key is distinct from v_execution.action_key
    or v_approval.artifact_version_hash is distinct from v_execution.artifact_version_hash
    or exists (select 1 from public.campaign_manifest_versions later
      where later.campaign_id = v_approval.campaign_id and later.version >
        (select current_version.version from public.campaign_manifest_versions current_version
          where current_version.id = v_approval.manifest_id)) then
    raise exception 'The exact approved campaign package is no longer current.'
      using errcode = '23514';
  end if;
  if not exists (select 1 from public.client_engine_settings settings
    where settings.client_id = v_approval.client_id and settings.campaign_actions_enabled) then
    raise exception 'External campaign actions are off for this client.' using errcode = '23514';
  end if;
  select * into v_heartbeat from public.agent_runtime_heartbeats
    where worker_id = p_worker_id order by reported_at desc,id desc limit 1;
  if not found or v_heartbeat.reported_at <= now() - interval '90 seconds'
    or v_heartbeat.version is distinct from p_build_sha
    or v_heartbeat.metadata->>'enabled' is distinct from 'true'
    or v_heartbeat.metadata->'controls'->>'campaignActions' is distinct from 'true'
    or nullif(v_heartbeat.metadata->'holds'->>'campaignActions','') is not null
    or v_heartbeat.metadata->'handlers'->>p_action_key is null then
    raise exception 'The deployed action worker is not currently attested.' using errcode = '23514';
  end if;
  select * into v_registry from public.campaign_action_executors
    where action_key = p_action_key for share;
  if not found or not v_registry.supported
    or v_registry.handler_attested_sha is distinct from p_build_sha
    or v_registry.executor_module is distinct from
      v_heartbeat.metadata->'handlers'->>p_action_key then
    raise exception 'This action handler is no longer supported by the deployed build.'
      using errcode = '23514';
  end if;
  select * into v_request from public.approval_requests_v6 r
    where r.source_system = 'aa_console' and r.source_kind = 'campaign_action'
      and r.source_id = v_approval.id::text
      and r.source_version = v_approval.request_hash
      and r.client_id = v_approval.client_id for share;
  if not found or v_request.expires_at is null or v_request.expires_at <= now() then
    raise exception 'The exact Inbox approval is absent or expired.' using errcode = '23514';
  end if;
  select i.status,i.preview_blocker,i.artifact_hash,i.destination,i.scope
    into v_inbox from public.approval_inbox_v6 i where i.id = v_request.id;
  if v_inbox.status is distinct from 'approved'
    or v_inbox.preview_blocker is not null
    or v_inbox.artifact_hash is distinct from v_approval.artifact_version_hash
    or v_inbox.destination is distinct from v_approval.destination
    or v_inbox.scope is distinct from v_approval.scope then
    raise exception 'The Inbox decision no longer matches the exact action.'
      using errcode = '23514';
  end if;
  select * into v_decision from public.approval_decision_events_v6 d
    where d.request_id = v_request.id order by d.event_order desc limit 1;
  if v_decision.decision is distinct from 'approved'
    or v_decision.actor_aal is distinct from 'aal2'
    or v_decision.artifact_hash is distinct from v_approval.artifact_version_hash
    or v_decision.source_decision_ref is distinct from
      'campaign_action_approvals:' || v_approval.id::text then
    raise exception 'A current AAL2 human decision is required.' using errcode = '23514';
  end if;
end $$;
revoke all on function public.assert_campaign_action_prewrite_v6(uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.assert_campaign_action_prewrite_v6(uuid,text,text,text)
  to service_role;
select public.lock_down_definer_functions();
commit;
