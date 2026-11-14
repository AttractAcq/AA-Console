-- Phase 2 claim contract. This remains inert while the runtime advertises
-- its generic claim hold; the legacy unfiltered RPC was revoked in 324.
-- Registry locks, approval locks, and execution changes share one transaction.
create function public.claim_campaign_actions_owned_v6(
  p_worker_id text, p_build_sha text, p_handlers jsonb, p_limit integer default 3
) returns table (
  execution_id uuid, approval_id uuid, client_id uuid, campaign_id uuid,
  manifest_id uuid, action_key text, destination text,
  artifact_version_hash text, scope jsonb, attempt integer
)
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_heartbeat public.agent_runtime_heartbeats%rowtype;
  v_handler record;
  v_registry public.campaign_action_executors%rowtype;
  v_approval public.campaign_action_approvals%rowtype;
  v_request public.approval_requests_v6%rowtype;
  v_inbox record;
  v_decision public.approval_decision_events_v6%rowtype;
  v_execution public.campaign_action_executions%rowtype;
  v_count integer := 0;
  v_keys text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service may claim campaign actions.' using errcode = '42501';
  end if;
  if p_worker_id is null or p_worker_id !~ '^agent-runtime:[0-9]+:[0-9a-f-]{36}$'
     or p_build_sha is null or p_build_sha !~ '^[0-9a-f]{40}$'
     or p_handlers is null or jsonb_typeof(p_handlers) <> 'object'
     or p_handlers = '{}'::jsonb
     or (select count(*) from jsonb_each(p_handlers)) > 4
     or p_limit is null or p_limit not between 1 and 10 then
    raise exception 'A bounded, attested runtime handler set is required.' using errcode = '22023';
  end if;

  select * into v_heartbeat from public.agent_runtime_heartbeats
   where worker_id = p_worker_id order by reported_at desc, id desc limit 1;
  if v_heartbeat.id is null or v_heartbeat.reported_at <= now() - interval '90 seconds'
     or v_heartbeat.version is distinct from p_build_sha
     or v_heartbeat.metadata -> 'handlers' is distinct from p_handlers
     or v_heartbeat.metadata -> 'controls' ->> 'campaignActions' is distinct from 'true'
     or v_heartbeat.metadata ->> 'enabled' is distinct from 'true'
     or nullif(v_heartbeat.metadata -> 'holds' ->> 'campaignActions', '') is not null then
    raise exception 'Runtime build, handler ownership or live execution state is unverified.'
      using errcode = '23514';
  end if;

  -- Stable order avoids two claimers deadlocking if they send the same map
  -- in different JSON key order. FOR SHARE excludes a concurrent support
  -- promotion/revocation until this transaction commits.
  for v_handler in select key, value from jsonb_each_text(p_handlers) order by key loop
    if (v_handler.key, v_handler.value) not in (
      ('proof_publish','proof_distribution'), ('page_deploy','website_studio'),
      ('lead_message','sales_os'), ('budget_change','meta_ads_studio')) then
      raise exception 'Action handler is not registered in this claim contract.' using errcode = '23514';
    end if;
    select * into v_registry from public.campaign_action_executors
      where campaign_action_executors.action_key = v_handler.key for share;
    if v_registry.action_key is null or v_registry.supported is not true
       or v_registry.executor_module is distinct from v_handler.value
       or v_registry.handler_attested_sha is distinct from p_build_sha then
      raise exception 'Action handler support is not attested for this deployed build.'
        using errcode = '23514';
    end if;
  end loop;
  select array_agg(key order by key) into v_keys from jsonb_each(p_handlers);

  for v_approval in
    select a.* from public.campaign_action_approvals a
     where a.status = 'approved' and a.action_key = any(v_keys)
     order by a.decided_at, a.id
     for update skip locked
  loop
    exit when v_count >= p_limit;
    if not exists (select 1 from public.client_engine_settings s
      where s.client_id = v_approval.client_id and s.campaign_actions_enabled) then
      continue;
    end if;
    if exists (select 1 from public.campaign_manifest_versions m
      where m.campaign_id = v_approval.campaign_id
        and m.version > (select old.version from public.campaign_manifest_versions old
          where old.id = v_approval.manifest_id)) then
      continue;
    end if;

    select * into v_request from public.approval_requests_v6 r
      where r.source_system = 'aa_console' and r.source_kind = 'campaign_action'
        and r.source_id = v_approval.id::text
        and r.source_version = v_approval.request_hash
        and r.client_id = v_approval.client_id
      for share;
    if v_request.id is null or v_request.expires_at is null
       or v_request.expires_at <= now() then continue; end if;
    select status, preview_blocker, artifact_hash, destination, scope
      into v_inbox from public.approval_inbox_v6 where id = v_request.id;
    if v_inbox.status is distinct from 'approved'
       or v_inbox.preview_blocker is not null
       or v_inbox.artifact_hash is distinct from v_approval.artifact_version_hash
       or v_inbox.destination is distinct from v_approval.destination
       or v_inbox.scope is distinct from v_approval.scope then continue; end if;
    select * into v_decision from public.approval_decision_events_v6 d
      where d.request_id = v_request.id order by event_order desc limit 1;
    if v_decision.decision is distinct from 'approved'
       or v_decision.actor_aal is distinct from 'aal2'
       or v_decision.artifact_hash is distinct from v_approval.artifact_version_hash
       or v_decision.source_decision_ref is distinct from
          'campaign_action_approvals:' || v_approval.id::text then continue; end if;

    select * into v_execution from public.campaign_action_executions e
      where e.approval_id = v_approval.id for update;
    if v_execution.id is not null and (
       v_execution.status not in ('failed') or v_execution.attempts >= 5
       or v_execution.artifact_version_hash is distinct from v_approval.artifact_version_hash
       or v_execution.manifest_id is distinct from v_approval.manifest_id) then
      continue;
    end if;
    if v_execution.id is null then
      insert into public.campaign_action_executions (
        approval_id, client_id, campaign_id, action_key, artifact_version_hash,
        manifest_id, status, attempts, claimed_at, lease_until)
      values (v_approval.id, v_approval.client_id, v_approval.campaign_id,
        v_approval.action_key, v_approval.artifact_version_hash,
        v_approval.manifest_id, 'executing', 1, now(), now() + interval '15 minutes')
      returning * into v_execution;
    else
      update public.campaign_action_executions e set
        status = 'executing', attempts = e.attempts + 1,
        claimed_at = now(), lease_until = now() + interval '15 minutes', last_error = null
      where e.id = v_execution.id returning * into v_execution;
    end if;
    insert into public.campaign_action_events (execution_id, client_id, event, actor, detail)
    values (v_execution.id, v_execution.client_id, 'claimed', 'agent',
      'Attested build ' || p_build_sha || ', attempt ' || v_execution.attempts::text);

    execution_id := v_execution.id;
    approval_id := v_approval.id;
    client_id := v_approval.client_id;
    campaign_id := v_approval.campaign_id;
    manifest_id := v_approval.manifest_id;
    action_key := v_approval.action_key;
    destination := v_approval.destination;
    artifact_version_hash := v_approval.artifact_version_hash;
    scope := v_approval.scope;
    attempt := v_execution.attempts;
    v_count := v_count + 1;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_campaign_actions_owned_v6(text,text,jsonb,integer)
  from public, anon, authenticated;
grant execute on function public.claim_campaign_actions_owned_v6(text,text,jsonb,integer)
  to service_role;
select public.lock_down_definer_functions();
