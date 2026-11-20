-- Shared historical cohort progress for the public and MCP Economics reports.
-- An active lead wins during overlap; archived events restore stages that a
-- finished lead reached before its final stage. This does not release the
-- positive-cash archive guard or change any external action claim.
begin;
create function public.reporting_lead_progress_v10(p_client_id uuid)
returns table (
  lead_id uuid, client_id uuid, created_at timestamptz,
  stage public.lead_stage, source_channel text, source_campaign_id uuid,
  sale_value numeric, cash_collected numeric, opportunity_value numeric,
  sale_currency text, cash_currency text, furthest_rank integer,
  ever_lost boolean, sale_evidence boolean, archived boolean
)
language plpgsql stable security definer
set search_path=pg_catalog,public as $$
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  return query
  select l.id,l.client_id,l.created_at,l.stage,l.source_channel,
         l.source_campaign_id,coalesce(l.sale_value,0),
         coalesce(l.cash_collected,0),coalesce(l.opportunity_value,0),
         l.sale_currency,l.cash_currency,
         greatest(public.lead_stage_rank(l.stage),
                  coalesce(live_events.max_rank,0),
                  coalesce(archive_events.max_rank,0))::integer,
         (l.stage='lost' or coalesce(live_events.ever_lost,false)
           or coalesce(archive_events.ever_lost,false)),
         (l.stage in ('sale','cash') or coalesce(l.sale_value,0)>0
           or coalesce(l.cash_collected,0)>0
           or coalesce(live_events.sale_evidence,false)
           or coalesce(archive_events.sale_evidence,false)),
         (a.id is not null)
  from public.reporting_lead_rows_v10(p_client_id) l
  left join public.archived_leads a on a.id=l.id and a.client_id=l.client_id
    and not exists (select 1 from public.client_leads active where active.id=l.id)
  left join lateral (
    select max(public.lead_stage_rank(e.to_stage))::integer as max_rank,
           coalesce(bool_or(e.to_stage='lost'),false) as ever_lost,
           coalesce(bool_or(e.to_stage in ('sale','cash')),false) as sale_evidence
    from public.lead_events e
    where e.lead_id=l.id and e.client_id=l.client_id
      and e.kind='stage_change' and e.to_stage is not null
  ) live_events on true
  left join lateral (
    select max(public.lead_stage_rank((event->>'to_stage')::public.lead_stage))::integer as max_rank,
           coalesce(bool_or(event->>'to_stage'='lost'),false) as ever_lost,
           coalesce(bool_or(event->>'to_stage' in ('sale','cash')),false) as sale_evidence
    from jsonb_array_elements(case when jsonb_typeof(a.events)='array'
      then a.events else '[]'::jsonb end) archived_event(event)
    where event->>'kind'='stage_change' and event->>'to_stage' is not null
  ) archive_events on true
  where not coalesce(l.is_probe,false);
end $$;
revoke all on function public.reporting_lead_progress_v10(uuid)
  from public,anon,authenticated,service_role;
comment on function public.reporting_lead_progress_v10(uuid) is
  'Internal tenant-guarded active/archive cohort source. Includes preserved stage events and recorded money/currency; current rows win on overlap.';
select public.lock_down_definer_functions();
commit;
