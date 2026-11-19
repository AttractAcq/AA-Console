-- Keep an archived lead's recorded source and outcome path readable without
-- counting its snapshot again in the live acquisition funnel. The archive
-- stores a full lead row and event array; neither is a provider receipt.
begin;
create function public.lead_journey_trace_v10(
  p_client_id uuid,p_days integer default 30,p_limit integer default 50)
returns table(
  lead_id uuid,lead_created_at timestamptz,lead_stage text,
  source_channel text,campaign_id uuid,campaign_name text,campaign_mode text,
  opportunity_ids uuid[],offer_version_id uuid,asset_id uuid,asset_title text,
  page_id uuid,page_title text,sales_agent_id uuid,
  sale_value numeric,cash_collected numeric,outcome_events integer,
  route_package_ids uuid[],capture_submissions integer,unknown_route_submissions integer,
  archived_at timestamptz
) language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare v_days integer:=greatest(1,least(coalesce(p_days,30),3650));
  v_limit integer:=greatest(1,least(coalesce(p_limit,50),100));
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode='42501'; end if;
  return query
  with active_rows as (
    select j.*,null::timestamptz as archived_at
    from public.lead_journey_trace_v9(p_client_id,v_days,100) j
  ), archived_rows as (
    select l.id as lead_id,l.created_at as lead_created_at,l.stage::text as lead_stage,
      nullif(btrim(l.source_channel),'') as source_channel,
      coalesce(c.id,l.source_client_campaign_id) as campaign_id,
      c.name as campaign_name,c.acquisition_mode::text as campaign_mode,
      coalesce(opp.ids,array[]::uuid[]) as opportunity_ids,c.offer_version_id,
      coalesce(m.id,l.source_asset_id,sp.asset_id) as asset_id,m.title as asset_title,
      coalesce(p.id,l.source_page_id) as page_id,p.title as page_title,
      coalesce(sa.id,l.source_sales_agent_id) as sales_agent_id,
      l.sale_value,l.cash_collected,
      (select count(*)::integer from jsonb_array_elements(coalesce(a.events,'[]'::jsonb)) e
        where e->>'kind'='outcome') as outcome_events,
      coalesce(s.route_ids,array[]::uuid[]) as route_package_ids,
      coalesce(s.total,0) as capture_submissions,
      coalesce(s.unknown,0) as unknown_route_submissions,
      a.archived_at
    from public.archived_leads a
    cross join lateral jsonb_populate_record(null::public.client_leads,a.lead) l
    left join public.client_campaigns c on c.id=l.source_client_campaign_id
      and c.client_id=a.client_id
    left join lateral (
      select array_agg(distinct ol.opportunity_id) as ids
      from public.opportunity_links ol where ol.client_id=a.client_id
        and ol.campaign_id=l.source_client_campaign_id and ol.role='campaign'
    ) opp on true
    left join public.scheduled_posts sp on sp.id=l.source_post_id
      and sp.client_id=a.client_id
    left join public.client_media_assets m on m.id=coalesce(l.source_asset_id,sp.asset_id)
      and m.client_id=a.client_id
    left join public.client_pages p on p.id=l.source_page_id and p.client_id=a.client_id
    left join public.client_sales_agents sa on sa.id=l.source_sales_agent_id
      and sa.client_id=a.client_id
    left join lateral (
      select array_agg(distinct s0.route_package_id)
          filter (where s0.route_package_id is not null) as route_ids,
        count(*)::integer as total,
        count(*) filter (where s0.route_package_id is null)::integer as unknown
      from public.lead_submissions s0 where s0.client_id=a.client_id
        and s0.lead_id=a.id and s0.status='promoted'
    ) s on true
    where a.client_id=p_client_id and l.client_id=a.client_id and l.id=a.id
      and not coalesce(l.is_probe,false)
      and l.created_at>=now()-make_interval(days=>v_days)
    order by l.created_at desc,l.id limit 100
  )
  select * from active_rows
  union all
  select * from archived_rows
  order by lead_created_at desc,lead_id
  limit v_limit;
end $$;
revoke all on function public.lead_journey_trace_v10(uuid,integer,integer)
  from public,anon,authenticated;
grant execute on function public.lead_journey_trace_v10(uuid,integer,integer)
  to authenticated,service_role;
comment on function public.lead_journey_trace_v10(uuid,integer,integer) is
  'Client-scoped active and archived lead trace. Archived snapshots are historical rows, not live funnel totals or provider execution receipts.';
select public.lock_down_definer_functions();
commit;
