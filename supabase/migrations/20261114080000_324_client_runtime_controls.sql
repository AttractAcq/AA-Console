-- Phase 2: client-scoped, read-only runtime dependency observation.
-- Heartbeats are admin-only; expose only non-secret control facts to a
-- person who can access this client. A missing/stale beat is never "off".
create or replace function public.client_runtime_controls_v6(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_beat public.agent_runtime_heartbeats%rowtype;
  v_cap numeric;
  v_conflict boolean;
begin
  if p_client_id is null or public.can_access_client(p_client_id) is not true then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;

  select * into v_beat
    from public.agent_runtime_heartbeats
   where worker_id like 'agent-runtime:%'
   order by reported_at desc, id desc
   limit 1;

  select b.cap_usd into v_cap
    from public.client_engine_budgets b
   where b.client_id = p_client_id
     and b.month = date_trunc('month', current_date)::date;

  select count(*) filter (where h.metadata -> 'controls' is null or h.metadata -> 'holds' is null) > 0
      or count(distinct coalesce(h.version, '')) > 1
      or count(distinct h.metadata -> 'controls') > 1
      or count(distinct h.metadata -> 'holds') > 1
    into v_conflict
    from (
      select distinct on (worker_id) version, metadata, reported_at
        from public.agent_runtime_heartbeats
       where worker_id like 'agent-runtime:%'
       order by worker_id, reported_at desc, id desc
    ) h
   where h.reported_at > now() - interval '90 seconds';

  if v_beat.id is null or v_beat.reported_at <= now() - interval '90 seconds' then
    return jsonb_build_object(
      'state', 'unknown',
      'budgetCap', v_cap,
      'reportedAt', v_beat.reported_at,
      'reason', 'No fresh agent runtime heartbeat; executor state cannot be verified.');
  end if;

  if v_conflict then
    return jsonb_build_object(
      'state', 'unknown',
      'budgetCap', v_cap,
      'reportedAt', v_beat.reported_at,
      'reason', 'Live runtime replicas disagree on build or execution controls.');
  end if;

  return jsonb_build_object(
    'state', 'observed',
    'reportedAt', v_beat.reported_at,
    'version', v_beat.version,
    'budgetCap', v_cap,
    'workerEnabled', v_beat.metadata -> 'enabled',
    'controls', coalesce(v_beat.metadata -> 'controls', '{}'::jsonb),
    'holds', coalesce(v_beat.metadata -> 'holds', '{}'::jsonb));
end;
$$;

revoke all on function public.client_runtime_controls_v6(uuid) from public, anon;
grant execute on function public.client_runtime_controls_v6(uuid) to authenticated;

-- The UI is not the authority. Until the atomic claim replaces the generic
-- worker hold, reject activation through any caller of this RPC as well.
-- The old unfiltered claim must not be callable even by another service-role
-- path while the runtime is held.
revoke execute on function public.claim_campaign_actions(integer) from service_role;

create or replace function public.set_campaign_actions_enabled(
  p_client_id uuid, p_enabled boolean)
returns public.client_engine_settings
language plpgsql
security definer
set search_path = ''
as $$
declare v_row public.client_engine_settings;
begin
  if p_client_id is null or public.can_access_client(p_client_id) is not true then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)) then
    raise exception 'Only an admin or the active client manager may change this.' using errcode = '42501';
  end if;
  if p_enabled then
    raise exception 'Campaign action executor is held until atomic handler-ownership claim is installed.' using errcode = 'P0001';
  end if;

  insert into public.client_engine_settings (client_id, campaign_actions_enabled)
  values (p_client_id, false)
  on conflict (client_id) do update set campaign_actions_enabled = false
  returning * into v_row;
  return v_row;
end;
$$;

select public.lock_down_definer_functions();
