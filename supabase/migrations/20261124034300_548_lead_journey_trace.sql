-- A read-only, client-scoped trace of the source fields actually recorded on
-- each lead. A campaign's mode is context, not evidence of an exact route
-- package or provider execution. Archived sources remain visible here.
create function public.lead_journey_trace_v8(
  p_client_id uuid,p_days integer default 30,p_limit integer default 50)
returns table(
  lead_id uuid,lead_created_at timestamptz,lead_stage text,
  source_channel text,campaign_id uuid,campaign_name text,campaign_mode text,
  opportunity_ids uuid[],offer_version_id uuid,asset_id uuid,asset_title text,
  page_id uuid,page_title text,sales_agent_id uuid,
  sale_value numeric,cash_collected numeric,outcome_events integer
) language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare v_days integer:=greatest(1,least(coalesce(p_days,30),3650));
  v_limit integer:=greatest(1,least(coalesce(p_limit,50),100));
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode='42501'; end if;
  return query
  select l.id,l.created_at,l.stage::text,nullif(btrim(l.source_channel),''),
    c.id,c.name,c.acquisition_mode::text,
    coalesce(opp.ids,array[]::uuid[]),c.offer_version_id,
    a.id,a.title,p.id,p.title,sa.id,
    l.sale_value,l.cash_collected,coalesce(events.total,0)
  from public.client_leads l
  left join public.client_campaigns c on c.id=l.source_client_campaign_id
    and c.client_id=l.client_id
  left join lateral (
    select array_agg(distinct ol.opportunity_id) as ids
    from public.opportunity_links ol where ol.client_id=l.client_id
      and ol.campaign_id=c.id and ol.role='campaign'
  ) opp on true
  left join public.scheduled_posts sp on sp.id=l.source_post_id
    and sp.client_id=l.client_id
  left join public.client_media_assets a
    on a.id=coalesce(l.source_asset_id,sp.asset_id) and a.client_id=l.client_id
  left join public.client_pages p on p.id=l.source_page_id and p.client_id=l.client_id
  left join public.client_sales_agents sa on sa.id=l.source_sales_agent_id
    and sa.client_id=l.client_id
  left join lateral (
    select count(*)::integer as total from public.lead_events e
    where e.lead_id=l.id and e.client_id=l.client_id and e.kind='outcome'
  ) events on true
  where l.client_id=p_client_id and not coalesce(l.is_probe,false)
    and l.created_at>=now()-make_interval(days=>v_days)
  order by l.created_at desc,l.id
  limit v_limit;
end $$;
revoke all on function public.lead_journey_trace_v8(uuid,integer,integer)
  from public,anon,authenticated;
grant execute on function public.lead_journey_trace_v8(uuid,integer,integer)
  to authenticated,service_role;
comment on function public.lead_journey_trace_v8(uuid,integer,integer) is
  'Recorded lead source and outcome trace; null source IDs remain unknown, and campaign mode does not certify an exact route package.';
select public.lock_down_definer_functions();
