-- Replace the Economics and Finance Controller currency-free return calculations.
create or replace function client_economics(
  p_client_id uuid,
  p_since     date,
  p_until     date
)
returns table (
  spend            numeric,
  leads            integer,
  qualified_leads  integer,
  appointments     integer,
  customers        integer,
  revenue          numeric,
  cash_collected   numeric,
  cpl              numeric,
  cpql             numeric,
  cpa              numeric,
  cac              numeric,
  roas             numeric,
  cash_roas        numeric,
  revenue_per_lead numeric,
  avg_customer_value numeric,
  currency         text,
  mixed_currency   boolean,
  profile_visits integer, followers integer, qualified integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_spend    numeric;
  v_cur      text;
  v_mixed    boolean;
  v_leads    integer;
  v_followers integer;
  v_qual     integer;
  v_appts    integer;
  v_custs    integer;
  v_rev      numeric;
  v_cash     numeric;
  v_sale_missing integer;
  v_sale_currencies integer;
  v_sale_currency text;
  v_cash_missing integer;
  v_cash_currencies integer;
  v_cash_currency text;
begin
  if not may_manage_client_leads(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if p_since is null or p_until is null then
    raise exception 'Economics needs both a start and an end date.';
  end if;
  if p_until <= p_since then
    raise exception 'The end of the window must come after its start.';
  end if;

  -- Spend in the acquisition window. until is exclusive.
  select coalesce(sum(s.amount), 0),
         case when count(distinct s.currency) = 1 then min(s.currency) end,
         count(distinct s.currency) > 1
    into v_spend, v_cur, v_mixed
  from client_marketing_spend s
  where s.client_id = p_client_id
    and s.spent_on >= p_since
    and s.spent_on <  p_until;

  -- The cohort: leads acquired in the same window, counted by how far they
  -- ever got rather than where they happen to sit now.
  select count(*)::int,
         count(*) filter (where p.furthest_rank >= 2)::int,
         count(*) filter (where p.furthest_rank >= 3)::int,
         count(*) filter (where p.furthest_rank >= 6)::int,
         count(*) filter (where p.stage in ('sale','cash') or p.sale_value>0 or p.cash_collected>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=p.lead_id and sale_event.client_id=p.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash')))::int,
         coalesce(sum(p.sale_value), 0),
         coalesce(sum(p.cash_collected), 0),
         count(*) filter (where coalesce(p.sale_value,0)>0 and source_lead.sale_currency is null)::int,
         count(distinct source_lead.sale_currency) filter (where coalesce(p.sale_value,0)>0)::int,
         min(source_lead.sale_currency) filter (where coalesce(p.sale_value,0)>0),
         count(*) filter (where coalesce(p.cash_collected,0)>0 and source_lead.cash_currency is null)::int,
         count(distinct source_lead.cash_currency) filter (where coalesce(p.cash_collected,0)>0)::int,
         min(source_lead.cash_currency) filter (where coalesce(p.cash_collected,0)>0)
    into v_leads, v_followers, v_qual, v_appts, v_custs, v_rev, v_cash,
         v_sale_missing,v_sale_currencies,v_sale_currency,
         v_cash_missing,v_cash_currencies,v_cash_currency
  from lead_progress p
  join public.client_leads source_lead on source_lead.id=p.lead_id
    and source_lead.client_id=p.client_id and not coalesce(source_lead.is_probe,false)
  where p.client_id = p_client_id
    and p.created_at >= p_since::timestamptz
    and p.created_at <  p_until::timestamptz;

  return query select
    case when v_mixed then null else v_spend end,
    v_leads, v_qual, v_appts, v_custs,
    case when v_rev=0 then 0
         when v_sale_missing=0 and v_sale_currencies=1 then v_rev end,
    case when v_cash=0 then 0
         when v_cash_missing=0 and v_cash_currencies=1 then v_cash end,
    -- Every ratio is null when its denominator is zero, and null when the
    -- window mixes currencies — a ratio across two currencies is not a number,
    -- and printing one would be worse than printing nothing. A spend of zero
    -- is a real fact and still shows as 0.
    case when v_mixed then null when v_leads  > 0 and v_spend > 0 then round(v_spend / v_leads, 2) end,
    case when v_mixed then null when v_qual   > 0 and v_spend > 0 then round(v_spend / v_qual, 2) end,
    case when v_mixed then null when v_appts  > 0 and v_spend > 0 then round(v_spend / v_appts, 2) end,
    case when v_mixed then null when v_custs  > 0 and v_spend > 0 then round(v_spend / v_custs, 2) end,
    case when not v_mixed and v_spend>0 and v_rev>0 and v_sale_missing=0
                   and v_sale_currencies=1 and v_sale_currency=v_cur
         then round(v_rev / v_spend, 2) end,
    case when not v_mixed and v_spend>0 and v_cash>0 and v_cash_missing=0
                   and v_cash_currencies=1 and v_cash_currency=v_cur
         then round(v_cash / v_spend, 2) end,
    case when v_leads>0 and v_rev>0 and v_sale_missing=0 and v_sale_currencies=1
         then round(v_rev / v_leads, 2) end,
    case when v_custs>0 and v_rev>0 and v_sale_missing=0 and v_sale_currencies=1
         then round(v_rev / v_custs, 2) end,
    v_cur,
    v_mixed,
    v_leads, v_followers, v_qual;
end;
$$;

revoke execute on function client_economics(uuid, date, date) from public, anon;
grant execute on function client_economics(uuid, date, date) to authenticated, service_role;

create or replace function client_economics_by_channel(
  p_client_id uuid,
  p_since     date,
  p_until     date
)
returns table (
  channel          text,
  spend            numeric,
  leads            integer,
  customers        integer,
  revenue          numeric,
  cash_collected   numeric,
  cpl              numeric,
  cac              numeric,
  roas             numeric,
  profile_visits integer, followers integer, qualified integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  -- Raised, not filtered. A WHERE on the permission check would return zero
  -- rows to an unauthorized caller, which is indistinguishable from "this
  -- client has no spend" — the same dishonest empty this tool exists to avoid.
  if not may_manage_client_leads(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  return query
  with s as (
    select coalesce(nullif(trim(sp.channel), ''), '(unattributed)') as k,
           sum(sp.amount) as spend,
           count(distinct sp.currency) as currency_count,
           min(sp.currency) as currency
    from client_marketing_spend sp
    where sp.client_id = p_client_id and sp.spent_on >= p_since and sp.spent_on < p_until
    group by 1
  ),
  l as (
    select coalesce(nullif(trim(p.source_channel), ''), '(unattributed)') as k,
           count(*)::int as leads,
           count(*) filter (where p.stage in ('sale','cash') or p.sale_value>0 or p.cash_collected>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=p.lead_id and sale_event.client_id=p.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash')))::int as customers,
           count(*) filter (where p.furthest_rank >= 2)::int as followers,
           count(*) filter (where p.furthest_rank >= 3)::int as qualified,
           sum(p.sale_value) as revenue,
           sum(p.cash_collected) as cash,
           count(*) filter (where p.sale_value>0 and source_lead.sale_currency is null) as sale_missing,
           count(distinct source_lead.sale_currency) filter (where p.sale_value>0) as sale_currency_count,
           min(source_lead.sale_currency) filter (where p.sale_value>0) as sale_currency,
           count(*) filter (where p.cash_collected>0 and source_lead.cash_currency is null) as cash_missing,
           count(distinct source_lead.cash_currency) filter (where p.cash_collected>0) as cash_currency_count
    from lead_progress p
    join public.client_leads source_lead on source_lead.id=p.lead_id
      and source_lead.client_id=p.client_id and not coalesce(source_lead.is_probe,false)
    where p.client_id = p_client_id
      and p.created_at >= p_since::timestamptz and p.created_at < p_until::timestamptz
    group by 1
  )
  select coalesce(s.k, l.k),
         case when s.currency_count>1 then null else coalesce(s.spend, 0) end,
         coalesce(l.leads, 0),
         coalesce(l.customers, 0),
         case when coalesce(l.revenue,0)=0 then 0
              when l.sale_missing=0 and l.sale_currency_count=1 then l.revenue end,
         case when coalesce(l.cash,0)=0 then 0
              when l.cash_missing=0 and l.cash_currency_count=1 then l.cash end,
         case when s.currency_count=1 and coalesce(l.leads,0) > 0 and coalesce(s.spend,0) > 0
                then round(s.spend / l.leads, 2) end,
         case when s.currency_count=1 and coalesce(l.customers,0) > 0 and coalesce(s.spend,0) > 0
                then round(s.spend / l.customers, 2) end,
         case when s.currency_count=1 and coalesce(s.spend,0)>0
                   and coalesce(l.revenue,0)>0 and l.sale_missing=0
                   and l.sale_currency_count=1 and l.sale_currency=s.currency
                then round(l.revenue / s.spend, 2) end,
         coalesce(l.leads,0), coalesce(l.followers,0), coalesce(l.qualified,0)
  from s full outer join l on l.k = s.k
  order by coalesce(s.spend, 0) desc, coalesce(s.k, l.k);
end;
$$;

revoke execute on function client_economics_by_channel(uuid, date, date) from public, anon;
grant execute on function client_economics_by_channel(uuid, date, date) to authenticated, service_role;

create or replace function client_economics_by_campaign(
  p_client_id uuid,
  p_since     date,
  p_until     date
)
returns table (
  campaign_id    uuid,
  campaign_ref   text,
  spend          numeric,
  leads          integer,
  customers      integer,
  revenue        numeric,
  cash_collected numeric,
  cpl            numeric,
  cac            numeric,
  roas           numeric,
  profile_visits integer, followers integer, qualified integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not may_manage_client_leads(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  return query
  with s as (
    select sp.campaign_id as k, sum(sp.amount) as spend,
           count(distinct sp.currency) as currency_count,
           min(sp.currency) as currency
    from client_marketing_spend sp
    where sp.client_id = p_client_id and sp.spent_on >= p_since and sp.spent_on < p_until
    group by 1
  ),
  l as (
    select p.source_campaign_id as k,
           count(*)::int as leads,
           count(*) filter (where p.stage in ('sale','cash') or p.sale_value>0 or p.cash_collected>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=p.lead_id and sale_event.client_id=p.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash')))::int as customers,
           count(*) filter (where p.furthest_rank >= 2)::int as followers,
           count(*) filter (where p.furthest_rank >= 3)::int as qualified,
           sum(p.sale_value) as revenue,
           sum(p.cash_collected) as cash,
           count(*) filter (where p.sale_value>0 and source_lead.sale_currency is null) as sale_missing,
           count(distinct source_lead.sale_currency) filter (where p.sale_value>0) as sale_currency_count,
           min(source_lead.sale_currency) filter (where p.sale_value>0) as sale_currency,
           count(*) filter (where p.cash_collected>0 and source_lead.cash_currency is null) as cash_missing,
           count(distinct source_lead.cash_currency) filter (where p.cash_collected>0) as cash_currency_count
    from lead_progress p
    join public.client_leads source_lead on source_lead.id=p.lead_id
      and source_lead.client_id=p.client_id and not coalesce(source_lead.is_probe,false)
    where p.client_id = p_client_id
      and p.created_at >= p_since::timestamptz and p.created_at < p_until::timestamptz
    group by 1
  )
  select coalesce(s.k, l.k),
         coalesce(c.campaign_ref, '(unattributed)'),
         case when s.currency_count>1 then null else coalesce(s.spend, 0) end,
         coalesce(l.leads, 0),
         coalesce(l.customers, 0),
         case when coalesce(l.revenue,0)=0 then 0
              when l.sale_missing=0 and l.sale_currency_count=1 then l.revenue end,
         case when coalesce(l.cash,0)=0 then 0
              when l.cash_missing=0 and l.cash_currency_count=1 then l.cash end,
         case when s.currency_count=1 and coalesce(l.leads,0) > 0 and coalesce(s.spend,0) > 0
                then round(s.spend / l.leads, 2) end,
         case when s.currency_count=1 and coalesce(l.customers,0) > 0 and coalesce(s.spend,0) > 0
                then round(s.spend / l.customers, 2) end,
         case when s.currency_count=1 and coalesce(s.spend,0)>0
                   and coalesce(l.revenue,0)>0 and l.sale_missing=0
                   and l.sale_currency_count=1 and l.sale_currency=s.currency
                then round(l.revenue / s.spend, 2) end,
         coalesce(l.leads,0), coalesce(l.followers,0), coalesce(l.qualified,0)
  from s full outer join l on l.k = s.k
  left join campaigns c on c.id = coalesce(s.k, l.k)
  order by coalesce(s.spend, 0) desc, coalesce(c.campaign_ref, '(unattributed)');
end;
$$;

revoke execute on function client_economics_by_campaign(uuid, date, date) from public, anon;
grant execute on function client_economics_by_campaign(uuid, date, date) to authenticated, service_role;


create or replace function mcp_internal.cohort_economics(p_client_id uuid, p_start date, p_end date)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_spend numeric; v_cur text; v_mixed boolean;
  v_leads integer; v_qual integer; v_appts integer; v_custs integer;
  v_rev numeric; v_cash numeric;
  v_sale_missing integer; v_sale_currencies integer; v_sale_currency text;
  v_cash_missing integer; v_cash_currencies integer; v_cash_currency text;
begin
  select coalesce(sum(s.amount), 0),
         case when count(distinct s.currency) = 1 then min(s.currency) end,
         count(distinct s.currency) > 1
    into v_spend, v_cur, v_mixed
  from public.client_marketing_spend s
  where s.client_id = p_client_id and s.spent_on >= p_start and s.spent_on < p_end;

  select count(*)::int,
         count(*) filter (where p.furthest_rank >= 3)::int,
         count(*) filter (where p.furthest_rank >= 4)::int,
         count(*) filter (where p.sale_evidence)::int,
         coalesce(sum(p.sale_value), 0),
         coalesce(sum(p.cash_collected), 0),
         count(*) filter (where p.sale_value>0 and p.sale_currency is null)::int,
         count(distinct p.sale_currency) filter (where p.sale_value>0)::int,
         min(p.sale_currency) filter (where p.sale_value>0),
         count(*) filter (where p.cash_collected>0 and p.cash_currency is null)::int,
         count(distinct p.cash_currency) filter (where p.cash_collected>0)::int,
         min(p.cash_currency) filter (where p.cash_collected>0)
    into v_leads, v_qual, v_appts, v_custs, v_rev, v_cash,
         v_sale_missing,v_sale_currencies,v_sale_currency,
         v_cash_missing,v_cash_currencies,v_cash_currency
  from (
    select l.client_id,
           (l.stage in ('sale','cash') or coalesce(l.sale_value,0)>0 or coalesce(l.cash_collected,0)>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=l.id and sale_event.client_id=l.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash'))) as sale_evidence,
           coalesce(l.sale_value, 0) as sale_value,
           coalesce(l.cash_collected, 0) as cash_collected,
           l.sale_currency, l.cash_currency,
           greatest(
             public.lead_stage_rank(l.stage),
             coalesce((
               select max(public.lead_stage_rank(e.to_stage))
               from public.lead_events e
               where e.lead_id = l.id and e.kind = 'stage_change' and e.to_stage is not null
             ), 0)
           ) as furthest_rank
    from public.client_leads l
    where l.client_id = p_client_id
      and not coalesce(l.is_probe,false)
      and l.created_at >= p_start::timestamptz
      and l.created_at < p_end::timestamptz
  ) p;

  return jsonb_build_object(
    'spend', case when v_mixed then null else v_spend end,
    'leads', v_leads,
    'qualified_leads', v_qual,
    'appointments', v_appts,
    'customers', v_custs,
    'revenue', case when v_rev=0 then 0 when v_sale_missing=0 and v_sale_currencies=1 then v_rev end,
    'cash_collected', case when v_cash=0 then 0 when v_cash_missing=0 and v_cash_currencies=1 then v_cash end,
    'cpl', case when v_mixed then null when v_leads > 0 and v_spend > 0 then round(v_spend / v_leads, 2) end,
    'cpql', case when v_mixed then null when v_qual > 0 and v_spend > 0 then round(v_spend / v_qual, 2) end,
    'cpa', case when v_mixed then null when v_appts > 0 and v_spend > 0 then round(v_spend / v_appts, 2) end,
    'cac', case when v_mixed then null when v_custs > 0 and v_spend > 0 then round(v_spend / v_custs, 2) end,
    'roas', case when not v_mixed and v_spend>0 and v_rev>0
                       and v_sale_missing=0 and v_sale_currencies=1 and v_sale_currency=v_cur
                  then round(v_rev / v_spend, 2) end,
    'cash_roas', case when not v_mixed and v_spend>0 and v_cash>0
                            and v_cash_missing=0 and v_cash_currencies=1 and v_cash_currency=v_cur
                       then round(v_cash / v_spend, 2) end,
    'revenue_per_lead', case when v_leads>0 and v_rev>0 and v_sale_missing=0 and v_sale_currencies=1
                               then round(v_rev / v_leads, 2) end,
    'avg_customer_value', case when v_custs>0 and v_rev>0 and v_sale_missing=0 and v_sale_currencies=1
                                 then round(v_rev / v_custs, 2) end,
    'sale_currency', case when v_sale_missing=0 and v_sale_currencies=1 then v_sale_currency end,
    'cash_currency', case when v_cash_missing=0 and v_cash_currencies=1 then v_cash_currency end,
    'unverified_sale_leads', v_sale_missing,
    'unverified_cash_leads', v_cash_missing,
    'currency', to_jsonb(v_cur),
    'mixed_currency', v_mixed
  );
end $$;
revoke all on function mcp_internal.cohort_economics(uuid,date,date) from public,anon,authenticated,service_role;


create or replace function mcp_internal.cohort_economics_by_campaign(p_client_id uuid, p_start date, p_end date, p_campaign_id uuid, p_limit integer)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare items jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(x) order by x.spend desc, x.campaign_ref),'[]') into items from (
    select coalesce(s.k, l.k) as campaign_id,
           coalesce(c.campaign_ref, '(unattributed)') as campaign_ref,
           case when s.currency_count>1 then null else coalesce(s.spend, 0) end as spend,
           coalesce(l.leads, 0) as leads,
           coalesce(l.customers, 0) as customers,
           case when coalesce(l.revenue,0)=0 then 0
                when l.sale_missing=0 and l.sale_currency_count=1 then l.revenue end as revenue,
           case when coalesce(l.cash,0)=0 then 0
                when l.cash_missing=0 and l.cash_currency_count=1 then l.cash end as cash_collected,
           case when l.sale_missing=0 and l.sale_currency_count=1 then l.sale_currency end as sale_currency,
           case when l.cash_missing=0 and l.cash_currency_count=1 then l.cash_currency end as cash_currency,
           coalesce(l.sale_missing,0) as unverified_sale_leads,
           coalesce(l.cash_missing,0) as unverified_cash_leads,
           case when s.currency_count=1 and coalesce(l.leads,0) > 0 and coalesce(s.spend,0) > 0
                  then round(s.spend / l.leads, 2) end as cpl,
           case when s.currency_count=1 and coalesce(l.customers,0) > 0 and coalesce(s.spend,0) > 0
                  then round(s.spend / l.customers, 2) end as cac,
           case when s.currency_count=1 and coalesce(s.spend,0)>0
                     and coalesce(l.revenue,0)>0 and l.sale_missing=0
                     and l.sale_currency_count=1 and l.sale_currency=s.currency
                  then round(l.revenue / s.spend, 2) end as roas
    from (
      select sp.campaign_id as k, sum(sp.amount) as spend,
             count(distinct sp.currency) as currency_count,
             min(sp.currency) as currency
      from public.client_marketing_spend sp
      where sp.client_id = p_client_id and sp.spent_on >= p_start and sp.spent_on < p_end
        and (p_campaign_id is null or sp.campaign_id is not distinct from p_campaign_id)
      group by 1
    ) s
    full outer join (
      select lp.source_campaign_id as k,
             count(*)::int as leads,
             count(*) filter (where lp.sale_evidence)::int as customers,
             sum(lp.sale_value) as revenue,
             sum(lp.cash_collected) as cash,
             count(*) filter (where lp.sale_value>0 and lp.sale_currency is null) as sale_missing,
             count(distinct lp.sale_currency) filter (where lp.sale_value>0) as sale_currency_count,
             min(lp.sale_currency) filter (where lp.sale_value>0) as sale_currency,
             count(*) filter (where lp.cash_collected>0 and lp.cash_currency is null) as cash_missing,
             count(distinct lp.cash_currency) filter (where lp.cash_collected>0) as cash_currency_count,
             min(lp.cash_currency) filter (where lp.cash_collected>0) as cash_currency
      from (
        select l.source_campaign_id,
               (l.stage in ('sale','cash') or coalesce(l.sale_value,0)>0 or coalesce(l.cash_collected,0)>0 or exists (select 1 from public.lead_events sale_event where sale_event.lead_id=l.id and sale_event.client_id=l.client_id and sale_event.kind='stage_change' and sale_event.to_stage in ('sale','cash'))) as sale_evidence,
               coalesce(l.sale_value, 0) as sale_value,
               coalesce(l.cash_collected, 0) as cash_collected,
               l.sale_currency, l.cash_currency,
               greatest(
                 public.lead_stage_rank(l.stage),
                 coalesce((
                   select max(public.lead_stage_rank(e.to_stage))
                   from public.lead_events e
                   where e.lead_id = l.id and e.kind = 'stage_change' and e.to_stage is not null
                 ), 0)
               ) as furthest_rank
        from public.client_leads l
        where l.client_id = p_client_id
          and not coalesce(l.is_probe,false)
          and l.created_at >= p_start::timestamptz
          and l.created_at < p_end::timestamptz
          and (p_campaign_id is null or l.source_campaign_id is not distinct from p_campaign_id)
      ) lp
      group by 1
    -- Equality matches migration 79. NULL campaign keys stay unattributed
    -- on each side rather than merging; IS NOT DISTINCT FROM is not a
    -- merge/hash join condition in the isolation PGlite fixture.
    ) l on l.k = s.k
    left join public.campaigns c on c.id = coalesce(s.k, l.k)
    order by coalesce(s.spend, 0) desc, coalesce(c.campaign_ref, '(unattributed)')
    limit p_limit
  ) x;
  return items;
end $$;
revoke all on function mcp_internal.cohort_economics_by_campaign(uuid,date,date,uuid,integer) from public,anon,authenticated,service_role;
