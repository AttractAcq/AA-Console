-- Refuse cross-currency opportunity and content-money aggregates.
create or replace view content_attribution
with (security_invoker = on) as
select
  a.client_id,
  a.id            as asset_id,
  a.ref_number    as asset_ref,
  a.title         as asset_title,
  a.media_type,
  a.review_status,
  a.created_at    as asset_created_at,

  -- what it was made from
  b.id                    as brief_id,
  b.brief_ref,
  b.hook,
  b.call_to_action,
  b.channel_intent,
  b.repurpose_format,
  b.derived_from_asset_id,
  b.proof_asset_id,
  i.id                    as idea_id,
  i.title                 as idea_title,
  i.content_territory,

  -- where it went
  d.posts,
  d.channels,
  d.first_published,

  -- what attention it got. Zero until metrics exist, never null, so a caller
  -- cannot mistake "not connected" for "performed badly".
  att.impressions,
  att.reach,
  att.clicks,
  att.spend,

  -- Conversation, appointment and lost counts use current stage. Sales use
  -- explicit stage, amount or historical sale/cash transition evidence, so a
  -- lead that later changes stage does not erase a recorded sale.
  rev.leads,
  rev.conversations,
  rev.appointments,
  rev.sales,
  rev.lost,
  rev.opportunity_value,
  rev.sale_value,
  rev.cash_collected,
  rev.profile_visits, rev.followers, rev.qualified
from client_media_assets a
left join client_briefs b on b.id = a.brief_id
left join client_ideas  i on i.id = b.source_idea_id
left join lateral (
  select count(*)::int                                as posts,
         string_agg(distinct sp.channel::text, ', ')  as channels,
         min(sp.published_at)                         as first_published
  from scheduled_posts sp
  where sp.asset_id = a.id
) d on true
left join lateral (
  select coalesce(sum(m.impressions), 0)::bigint as impressions,
         coalesce(sum(m.reach), 0)::bigint       as reach,
         coalesce(sum(m.clicks), 0)::bigint      as clicks,
         coalesce(sum(m.spend), 0)::numeric      as spend
  from metrics_daily m
  join scheduled_posts sp on sp.id = m.post_id
  where sp.asset_id = a.id
) att on true
left join lateral (
  select count(*)::int as leads,
         count(*) filter (where l.stage in ('conversation','qualified_conversation','appointment','qualified_appointment','shown','sale','cash'))::int as conversations,
         count(*) filter (where l.stage in ('appointment','qualified_appointment','shown','sale','cash'))::int as appointments,
         count(*) filter (where l.stage in ('sale','cash') or coalesce(l.sale_value,0)>0 or coalesce(l.cash_collected,0)>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=l.id and sale_event.client_id=l.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash')))::int as sales,
         count(*) filter (where l.stage = 'lost')::int           as lost,
         case when coalesce(sum(l.opportunity_value),0)=0 then 0
              when count(*) filter (where l.opportunity_value>0 and l.opportunity_currency is null)=0
                and count(distinct l.opportunity_currency) filter (where l.opportunity_value>0)=1
              then sum(l.opportunity_value) end::numeric as opportunity_value,
         case when coalesce(sum(l.sale_value),0)=0 then 0
              when count(*) filter (where l.sale_value>0 and l.sale_currency is null)=0
                and count(distinct l.sale_currency) filter (where l.sale_value>0)=1
              then sum(l.sale_value) end::numeric as sale_value,
         case when coalesce(sum(l.cash_collected),0)=0 then 0
              when count(*) filter (where l.cash_collected>0 and l.cash_currency is null)=0
                and count(distinct l.cash_currency) filter (where l.cash_collected>0)=1
              then sum(l.cash_collected) end::numeric as cash_collected,
         count(*) filter (where lead_stage_rank(l.stage) >= 1)::int as profile_visits,
         count(*) filter (where lead_stage_rank(l.stage) >= 2)::int as followers,
         count(*) filter (where lead_stage_rank(l.stage) >= 3)::int as qualified
  from client_leads l
  where not coalesce(l.is_probe,false) and (l.source_asset_id = a.id
     -- a lead may name the post rather than the asset; both mean this asset
     or l.source_post_id in (select sp.id from scheduled_posts sp where sp.asset_id = a.id))
) rev on true;

create or replace function top_content_by_revenue(p_client_id uuid, p_limit integer default 10)
returns table (
  asset_ref text,
  asset_title text,
  hook text,
  idea_title text,
  content_territory text,
  leads integer,
  sales integer,
  cash_collected numeric,
  spend numeric,
  impressions bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select ca.asset_ref, ca.asset_title, ca.hook, ca.idea_title, ca.content_territory,
         ca.leads, ca.sales, ca.cash_collected, ca.spend, ca.impressions
  from content_attribution ca
  where ca.client_id = p_client_id
    and may_manage_client_leads(p_client_id)
  order by ca.cash_collected desc nulls last, ca.sale_value desc nulls last,
           ca.leads desc, ca.asset_created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 100));
$$;

revoke execute on function top_content_by_revenue(uuid, integer) from public, anon;
grant  execute on function top_content_by_revenue(uuid, integer) to authenticated, service_role;


create or replace function acquisition_funnel(p_client_id uuid, p_days integer default 30)
returns table (
  leads integer,
  conversations integer,
  appointments integer,
  sales integer,
  lost integer,
  pipeline_value numeric,
  sale_value numeric,
  cash_collected numeric,
  spend numeric,
  lead_to_sale_pct numeric,
  cost_per_lead numeric,
  return_on_spend numeric,
  profile_visits integer, followers integer, qualified integer
)
language sql
stable
security definer
set search_path = public
as $$
  with window_leads as (
    select * from client_leads l
    where l.client_id = p_client_id
      and not coalesce(l.is_probe,false)
      and l.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 3650)))
  ),
  spend as (
    -- Canonical ledger, not metrics_daily. Same window as the leads above.
    select coalesce(sum(s.amount), 0)::numeric as total,
           count(distinct s.currency)::int as currency_count,
           min(s.currency) as currency
    from client_marketing_spend s
    where s.client_id = p_client_id
      and s.spent_on >= (current_date - greatest(1, least(coalesce(p_days, 30), 3650)))
  ),
  counted as (
    select count(*)::int as leads,
           count(*) filter (where stage in ('conversation','qualified_conversation','appointment','qualified_appointment','shown','sale','cash'))::int as conversations,
           count(*) filter (where stage in ('appointment','qualified_appointment','shown','sale','cash'))::int as appointments,
           count(*) filter (where wl.stage in ('sale','cash') or coalesce(wl.sale_value,0)>0 or coalesce(wl.cash_collected,0)>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=wl.id and sale_event.client_id=wl.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash')))::int as sales,
           count(*) filter (where stage = 'lost')::int as lost,
           coalesce(sum(opportunity_value), 0)::numeric as pipeline_value,
           count(*) filter (where coalesce(opportunity_value,0)>0 and opportunity_currency is null)::int as opportunity_unverified,
           count(distinct opportunity_currency) filter (where coalesce(opportunity_value,0)>0)::int as opportunity_currencies,
           coalesce(sum(sale_value), 0)::numeric as sale_value,
           coalesce(sum(cash_collected), 0)::numeric as cash_collected,
           count(*) filter (where coalesce(sale_value,0)>0 and sale_currency is null)::int as sale_unverified,
           count(distinct sale_currency) filter (where coalesce(sale_value,0)>0)::int as sale_currencies,
           min(sale_currency) filter (where coalesce(sale_value,0)>0) as sale_currency,
           count(*) filter (where coalesce(cash_collected,0)>0 and cash_currency is null)::int as cash_unverified,
           count(distinct cash_currency) filter (where coalesce(cash_collected,0)>0)::int as cash_currencies,
           min(cash_currency) filter (where coalesce(cash_collected,0)>0) as cash_currency,
           count(*) filter (where lead_stage_rank(stage) >= 1)::int as profile_visits,
           count(*) filter (where lead_stage_rank(stage) >= 2)::int as followers,
           count(*) filter (where lead_stage_rank(stage) >= 3)::int as qualified
    from window_leads wl
  )
  select c.leads, c.conversations, c.appointments, c.sales, c.lost,
         case when c.pipeline_value=0 then 0
              when c.opportunity_unverified=0 and c.opportunity_currencies=1
              then c.pipeline_value end,
         case when c.sale_value=0 then 0
              when c.sale_unverified=0 and c.sale_currencies=1 then c.sale_value end,
         case when c.cash_collected=0 then 0
              when c.cash_unverified=0 and c.cash_currencies=1 then c.cash_collected end,
         s.total,
         case when c.leads > 0 then round(100.0 * c.sales / c.leads, 1) end,
         case when c.leads > 0 and s.total > 0 and s.currency_count=1
              then round(s.total / c.leads, 2) end,
         case when s.total>0 and s.currency_count=1 and c.cash_collected>0
                   and c.cash_unverified=0 and c.cash_currencies=1
                   and c.cash_currency=s.currency
              then round(c.cash_collected / s.total, 2) end,
         c.profile_visits, c.followers, c.qualified
  from counted c cross join spend s
  where may_manage_client_leads(p_client_id);
$$;

revoke execute on function acquisition_funnel(uuid, integer) from public, anon;
grant execute on function acquisition_funnel(uuid, integer) to authenticated, service_role;


create or replace function mcp_internal.attribution_conversion_funnel(
  p_bot_id text,
  p_client_id uuid,
  p_days integer default 30
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_days integer;
  v_leads integer;
  v_conversations integer;
  v_appointments integer;
  v_sales integer;
  v_lost integer;
  v_pipeline numeric;
  v_opportunity_unverified integer;
  v_opportunity_currencies integer;
  v_opportunity_currency text;
  v_sale numeric;
  v_cash numeric;
  v_spend numeric;
  v_spend_currencies integer;
  v_spend_currency text;
  v_sale_unverified integer;
  v_sale_currencies integer;
  v_sale_currency text;
  v_cash_unverified integer;
  v_cash_currencies integer;
  v_cash_currency text;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if not mcp_internal.bot_has_permission(p_bot_id, 'attribution.get_conversion_funnel') then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  perform 1 from mcp_internal.mcp_bots where bot_id=p_bot_id and status='active' for share;
  if not found then raise exception using message='bot_not_active', errcode='P0001'; end if;
  v_days := coalesce(p_days, 30);
  if v_days < 1 or v_days > 3650 then
    raise exception using message='invalid_request', errcode='P0001';
  end if;

  select count(*)::int,
         count(*) filter (where stage in ('conversation','qualified_conversation','appointment','qualified_appointment','shown','sale','cash'))::int,
         count(*) filter (where stage in ('appointment','qualified_appointment','shown','sale','cash'))::int,
         count(*) filter (where l.stage in ('sale','cash') or coalesce(l.sale_value,0)>0 or coalesce(l.cash_collected,0)>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=l.id and sale_event.client_id=l.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash')))::int,
         count(*) filter (where stage = 'lost')::int,
         coalesce(sum(opportunity_value), 0),
         count(*) filter (where coalesce(opportunity_value,0)>0 and opportunity_currency is null)::int,
         count(distinct opportunity_currency) filter (where coalesce(opportunity_value,0)>0)::int,
         min(opportunity_currency) filter (where coalesce(opportunity_value,0)>0),
         coalesce(sum(sale_value), 0),
         coalesce(sum(cash_collected), 0),
         count(*) filter (where coalesce(sale_value,0)>0 and sale_currency is null)::int,
         count(distinct sale_currency) filter (where coalesce(sale_value,0)>0)::int,
         min(sale_currency) filter (where coalesce(sale_value,0)>0),
         count(*) filter (where coalesce(cash_collected,0)>0 and cash_currency is null)::int,
         count(distinct cash_currency) filter (where coalesce(cash_collected,0)>0)::int,
         min(cash_currency) filter (where coalesce(cash_collected,0)>0)
    into v_leads, v_conversations, v_appointments, v_sales, v_lost, v_pipeline,
         v_opportunity_unverified,v_opportunity_currencies,v_opportunity_currency,v_sale,v_cash,
         v_sale_unverified, v_sale_currencies, v_sale_currency,
         v_cash_unverified, v_cash_currencies, v_cash_currency
  from public.client_leads l
  where l.client_id = p_client_id
    and not coalesce(l.is_probe,false)
    and l.created_at >= now() - make_interval(days => v_days);

  select coalesce(sum(s.amount), 0), count(distinct s.currency)::int, min(s.currency)
    into v_spend, v_spend_currencies, v_spend_currency
  from public.client_marketing_spend s
  where s.client_id = p_client_id
    and s.spent_on >= (current_date - v_days);

  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'acquisition_funnel_v1',
    'days', v_days,
    'funnel', jsonb_build_object(
      'leads', v_leads,
      'conversations', v_conversations,
      'appointments', v_appointments,
      'sales', v_sales,
      'lost', v_lost,
      'pipeline_value', case when v_pipeline=0 then 0
                             when v_opportunity_unverified=0 and v_opportunity_currencies=1
                             then v_pipeline end,
      'opportunity_currency', case when v_opportunity_unverified=0 and v_opportunity_currencies=1
                                    then v_opportunity_currency end,
      'opportunity_currency_unverified_leads', v_opportunity_unverified,
      'sale_value', case when v_sale=0 then 0
                         when v_sale_unverified=0 and v_sale_currencies=1 then v_sale end,
      'sale_currency', case when v_sale_unverified=0 and v_sale_currencies=1 then v_sale_currency end,
      'sale_currency_unverified_leads', v_sale_unverified,
      'cash_collected', case when v_cash=0 then 0
                            when v_cash_unverified=0 and v_cash_currencies=1 then v_cash end,
      'cash_currency', case when v_cash_unverified=0 and v_cash_currencies=1 then v_cash_currency end,
      'cash_currency_unverified_leads', v_cash_unverified,
      'spend', v_spend,
      'spend_currency', case when v_spend_currencies=1 then v_spend_currency end,
      'lead_to_sale_pct', case when v_leads > 0 then round(100.0 * v_sales / v_leads, 1) end,
      'cost_per_lead', case when v_leads>0 and v_spend>0 and v_spend_currencies=1
                                 then round(v_spend / v_leads, 2) end,
      'return_on_spend', case when v_spend>0 and v_spend_currencies=1 and v_cash>0
                                  and v_cash_unverified=0 and v_cash_currencies=1
                                  and v_cash_currency=v_spend_currency
                                then round(v_cash / v_spend, 2) end
    )
  );
end $$;
revoke all on function mcp_internal.attribution_conversion_funnel(text,uuid,integer) from public,anon,authenticated,service_role;

create or replace function mcp_internal.get_pipeline_summary(
  p_bot_id text, p_client_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v_by_stage jsonb;
  v_totals record;
  v_stalled integer;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  select coalesce(jsonb_agg(jsonb_build_object(
      'stage', x.stage, 'count', x.n,
      'opportunity_value', case when x.value=0 then 0
                                 when x.unverified=0 and x.currency_count=1 then x.value end,
      'opportunity_currency', case when x.unverified=0 and x.currency_count=1 then x.currency end,
      'opportunity_currency_unverified_leads', x.unverified
    ) order by x.stage), '[]'::jsonb)
    into v_by_stage
    from (
      select l.stage::text as stage, count(*) as n,
             coalesce(sum(l.opportunity_value), 0) as value,
             count(*) filter (where coalesce(l.opportunity_value,0)>0 and l.opportunity_currency is null) as unverified,
             count(distinct l.opportunity_currency) filter (where coalesce(l.opportunity_value,0)>0) as currency_count,
             min(l.opportunity_currency) filter (where coalesce(l.opportunity_value,0)>0) as currency
        from client_leads l
       where l.client_id = p_client_id and not coalesce(l.is_probe,false)
       group by l.stage
    ) x;
  select count(*) as total_leads,
         coalesce(sum(opportunity_value), 0) as total_opportunity_value,
         count(*) filter (where coalesce(opportunity_value,0)>0 and opportunity_currency is null) as opportunity_unverified,
         count(distinct opportunity_currency) filter (where coalesce(opportunity_value,0)>0) as opportunity_currency_count,
         min(opportunity_currency) filter (where coalesce(opportunity_value,0)>0) as opportunity_currency,
         coalesce(sum(cash_collected), 0) as total_cash_collected,
         count(*) filter (where coalesce(cash_collected,0)>0 and cash_currency is null) as cash_unverified,
         count(distinct cash_currency) filter (where coalesce(cash_collected,0)>0) as cash_currency_count,
         min(cash_currency) filter (where coalesce(cash_collected,0)>0) as cash_currency
    into v_totals
    from client_leads
   where client_id = p_client_id and not coalesce(is_probe,false);
  select count(*) into v_stalled
    from public.stalled_leads(p_client_id, 7);
  return jsonb_build_object(
    'client_id', p_client_id,
    'by_stage', v_by_stage,
    'total_leads', v_totals.total_leads,
    'total_opportunity_value', case when v_totals.total_opportunity_value=0 then 0
                                    when v_totals.opportunity_unverified=0 and v_totals.opportunity_currency_count=1
                                    then v_totals.total_opportunity_value end,
    'opportunity_currency', case when v_totals.opportunity_unverified=0 and v_totals.opportunity_currency_count=1
                                   then v_totals.opportunity_currency end,
    'opportunity_currency_unverified_leads', v_totals.opportunity_unverified,
    'total_cash_collected', case when v_totals.total_cash_collected=0 then 0
                                 when v_totals.cash_unverified=0 and v_totals.cash_currency_count=1
                                 then v_totals.total_cash_collected end,
    'cash_currency', case when v_totals.cash_unverified=0 and v_totals.cash_currency_count=1
                            then v_totals.cash_currency end,
    'cash_currency_unverified_leads', v_totals.cash_unverified,
    'stalled_count', v_stalled
  );
end;
$$;

create or replace function mcp_internal.lead_json(p client_leads)
returns jsonb
language sql
stable
set search_path = mcp_internal, public
as $$
  select jsonb_build_object(
    'id', p.id,
    'client_id', p.client_id,
    'name', p.name,
    'email', p.email,
    'phone', p.phone,
    'stage', p.stage,
    'stage_at', p.stage_at,
    'lost_reason', p.lost_reason,
    'owner_member_id', p.owner_member_id,
    'next_action', p.next_action,
    'next_action_due', p.next_action_due,
    'opportunity_value', p.opportunity_value,
    'opportunity_currency', p.opportunity_currency,
    'sale_value', p.sale_value,
    'sale_currency', p.sale_currency,
    'cash_collected', p.cash_collected,
    'cash_currency', p.cash_currency,
    'appointment_at', p.appointment_at,
    'appointment_outcome', p.appointment_outcome,
    'source_channel', p.source_channel,
    'source_sales_agent_id', p.source_sales_agent_id,
    'notes', mcp_internal.clip_text(p.notes),
    'created_at', p.created_at,
    'updated_at', p.updated_at
  );
$$;
revoke all on function mcp_internal.lead_json(client_leads) from public, anon, authenticated;
grant execute on function mcp_internal.lead_json(client_leads) to service_role;
