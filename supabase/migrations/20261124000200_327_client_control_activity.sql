-- Phase 2: one client-scoped read of attempts and provider references for the
-- Dashboard control panel. An internal status without an external reference
-- is not presented as an external receipt.
create function public.client_control_activity_v6(p_client_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  if p_client_id is null or public.can_access_client(p_client_id) is not true then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;

  with activity as materialized (
    select 'engine'::text as control_key, s.created_at as run_at,
      s.stage::text as status, s.id::text as source_id,
      null::timestamptz as receipt_at, null::text as external_ref,
      null::text as external_url
    from public.content_slots s where s.client_id = p_client_id
    union all
    select case d.kind when 'idea_selected' then 'auto_approve_ideas'
      else 'auto_approve_briefs' end, d.decided_at, d.kind, d.id::text,
      null::timestamptz, null::text, null::text
    from public.engine_decisions d where d.client_id = p_client_id
    union all
    select 'publishing', p.updated_at,
      p.publication_status, p.id::text,
      case when p.published_at is not null
        and (p.external_id is not null or p.external_url is not null)
        then p.published_at end,
      p.external_id, p.external_url
    from public.scheduled_posts p
    where p.client_id = p_client_id and p.publish_attempts > 0
    union all
    select 'proof_publishing', p.updated_at,
      p.status, p.id::text,
      case when p.placed_at is not null
        and (p.external_id is not null or p.external_url is not null)
        then p.placed_at end,
      p.external_id, p.external_url
    from public.proof_placements p
    where p.client_id = p_client_id and p.attempts > 0
    union all
    select 'campaign_actions', e.updated_at,
      e.status, e.id::text,
      case when e.executed_at is not null
        and (e.external_id is not null or e.external_url is not null)
        then e.executed_at end,
      e.external_id, e.external_url
    from public.campaign_action_executions e
    where e.client_id = p_client_id and e.attempts > 0
    union all
    select 'outbound_messaging', m.updated_at,
      m.status, m.id::text,
      case when m.sent_at is not null and m.external_id is not null
        then m.sent_at end,
      m.external_id, null::text
    from public.outbound_messages m
    where m.client_id = p_client_id and m.attempts > 0
    union all
    select 'lead_magnet_delivery', d.updated_at,
      d.status, d.id::text,
      case when d.sent_at is not null and d.provider_ref is not null
        then d.sent_at end,
      d.provider_ref, null::text
    from public.lead_magnet_deliveries d
    where d.client_id = p_client_id and d.attempts > 0
    union all
    select 'booking', a.created_at, a.status, a.id::text,
      null::timestamptz, null::text, null::text
    from public.client_appointments a
    where a.client_id = p_client_id and a.booked_via in ('public_link','sales_agent')
  ), keys(control_key) as (
    values ('engine'), ('auto_approve_ideas'), ('auto_approve_briefs'),
      ('publishing'), ('proof_publishing'), ('campaign_actions'),
      ('outbound_messaging'), ('lead_magnet_delivery'), ('booking')
  )
  select jsonb_object_agg(k.control_key, jsonb_build_object(
    'lastRun', (
      select jsonb_build_object('at', a.run_at, 'status', a.status,
        'sourceId', a.source_id)
      from activity a where a.control_key = k.control_key
      order by a.run_at desc, a.source_id desc limit 1),
    'lastExternalReceipt', (
      select jsonb_build_object('at', a.receipt_at, 'externalRef', a.external_ref,
        'externalUrl', a.external_url, 'sourceId', a.source_id)
      from activity a where a.control_key = k.control_key
        and a.receipt_at is not null
      order by a.receipt_at desc, a.source_id desc limit 1)
  )) into v_result from keys k;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

revoke all on function public.client_control_activity_v6(uuid) from public, anon;
grant execute on function public.client_control_activity_v6(uuid) to authenticated;
select public.lock_down_definer_functions();
