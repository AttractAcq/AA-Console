-- Reporting and Bot guards for the nine-stage funnel. Legacy rows stay untouched.

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

  -- what it produced. Counts are by CURRENT stage, not furthest reached: a
  -- lead that got to appointment and was then lost counts as lost here.
  -- lead_events records every stage change, so furthest-reached is derivable
  -- later; doing it now would cost a correlated scan per row for a number
  -- nobody has asked for yet.
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
         count(*) filter (where l.stage in ('shown','sale','cash'))::int as sales,
         count(*) filter (where l.stage = 'lost')::int           as lost,
         coalesce(sum(l.opportunity_value), 0)::numeric as opportunity_value,
         coalesce(sum(l.sale_value), 0)::numeric        as sale_value,
         coalesce(sum(l.cash_collected), 0)::numeric    as cash_collected,
         count(*) filter (where lead_stage_rank(l.stage) >= 1)::int as profile_visits,
         count(*) filter (where lead_stage_rank(l.stage) >= 2)::int as followers,
         count(*) filter (where lead_stage_rank(l.stage) >= 3)::int as qualified
  from client_leads l
  where l.source_asset_id = a.id
     -- a lead may name the post rather than the asset; both mean this asset
     or l.source_post_id in (select sp.id from scheduled_posts sp where sp.asset_id = a.id)
) rev on true;


drop function acquisition_funnel(uuid, integer);
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
      and l.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 3650)))
  ),
  spend as (
    -- Canonical ledger, not metrics_daily. Same window as the leads above.
    select coalesce(sum(s.amount), 0)::numeric as total
    from client_marketing_spend s
    where s.client_id = p_client_id
      and s.spent_on >= (current_date - greatest(1, least(coalesce(p_days, 30), 3650)))
  ),
  counted as (
    select count(*)::int as leads,
           count(*) filter (where stage in ('conversation','qualified_conversation','appointment','qualified_appointment','shown','sale','cash'))::int as conversations,
           count(*) filter (where stage in ('appointment','qualified_appointment','shown','sale','cash'))::int as appointments,
           count(*) filter (where stage in ('shown','sale','cash'))::int as sales,
           count(*) filter (where stage = 'lost')::int as lost,
           coalesce(sum(opportunity_value), 0)::numeric as pipeline_value,
           coalesce(sum(sale_value), 0)::numeric as sale_value,
           coalesce(sum(cash_collected), 0)::numeric as cash_collected,
           count(*) filter (where lead_stage_rank(stage) >= 1)::int as profile_visits,
           count(*) filter (where lead_stage_rank(stage) >= 2)::int as followers,
           count(*) filter (where lead_stage_rank(stage) >= 3)::int as qualified
    from window_leads
  )
  select c.leads, c.conversations, c.appointments, c.sales, c.lost,
         c.pipeline_value, c.sale_value, c.cash_collected, s.total,
         case when c.leads > 0 then round(100.0 * c.sales / c.leads, 1) end,
         case when c.leads > 0 and s.total > 0 then round(s.total / c.leads, 2) end,
         case when s.total > 0 then round(c.cash_collected / s.total, 2) end,
         c.profile_visits, c.followers, c.qualified
  from counted c cross join spend s
  where auth.role() = 'service_role' or can_access_client(p_client_id);
$$;

revoke execute on function acquisition_funnel(uuid, integer) from public, anon;
grant execute on function acquisition_funnel(uuid, integer) to authenticated, service_role;

drop function client_economics(uuid, date, date);
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
begin
  if not (auth.role() = 'service_role' or can_access_client(p_client_id)) then
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
         count(*) filter (where p.furthest_rank >= 8)::int,
         coalesce(sum(p.sale_value), 0),
         coalesce(sum(p.cash_collected), 0)
    into v_leads, v_followers, v_qual, v_appts, v_custs, v_rev, v_cash
  from lead_progress p
  where p.client_id = p_client_id
    and p.created_at >= p_since::timestamptz
    and p.created_at <  p_until::timestamptz;

  return query select
    v_spend,
    v_leads, v_qual, v_appts, v_custs,
    v_rev, v_cash,
    -- Every ratio is null when its denominator is zero, and null when the
    -- window mixes currencies — a ratio across two currencies is not a number,
    -- and printing one would be worse than printing nothing. A spend of zero
    -- is a real fact and still shows as 0.
    case when v_mixed then null when v_leads  > 0 and v_spend > 0 then round(v_spend / v_leads, 2) end,
    case when v_mixed then null when v_qual   > 0 and v_spend > 0 then round(v_spend / v_qual, 2) end,
    case when v_mixed then null when v_appts  > 0 and v_spend > 0 then round(v_spend / v_appts, 2) end,
    case when v_mixed then null when v_custs  > 0 and v_spend > 0 then round(v_spend / v_custs, 2) end,
    case when v_mixed then null when v_spend  > 0 then round(v_rev  / v_spend, 2) end,
    case when v_mixed then null when v_spend  > 0 then round(v_cash / v_spend, 2) end,
    case when v_leads > 0 then round(v_rev / v_leads, 2) end,
    case when v_custs > 0 then round(v_rev / v_custs, 2) end,
    v_cur,
    v_mixed,
    v_leads, v_followers, v_qual;
end;
$$;

revoke execute on function client_economics(uuid, date, date) from public, anon;
grant  execute on function client_economics(uuid, date, date) to authenticated, service_role;

revoke execute on function client_economics(uuid, date, date) from public, anon;
grant execute on function client_economics(uuid, date, date) to authenticated, service_role;

drop function client_economics_by_channel(uuid, date, date);
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
  if not (auth.role() = 'service_role' or can_access_client(p_client_id)) then
    raise exception 'Not permitted for this client';
  end if;

  return query
  with s as (
    select coalesce(nullif(trim(sp.channel), ''), '(unattributed)') as k,
           sum(sp.amount) as spend
    from client_marketing_spend sp
    where sp.client_id = p_client_id and sp.spent_on >= p_since and sp.spent_on < p_until
    group by 1
  ),
  l as (
    select coalesce(nullif(trim(p.source_channel), ''), '(unattributed)') as k,
           count(*)::int as leads,
           count(*) filter (where p.furthest_rank >= 8)::int as customers,
           count(*) filter (where p.furthest_rank >= 2)::int as followers,
           count(*) filter (where p.furthest_rank >= 3)::int as qualified,
           sum(p.sale_value) as revenue,
           sum(p.cash_collected) as cash
    from lead_progress p
    where p.client_id = p_client_id
      and p.created_at >= p_since::timestamptz and p.created_at < p_until::timestamptz
    group by 1
  )
  select coalesce(s.k, l.k),
         coalesce(s.spend, 0),
         coalesce(l.leads, 0),
         coalesce(l.customers, 0),
         coalesce(l.revenue, 0),
         coalesce(l.cash, 0),
         case when coalesce(l.leads,0) > 0 and coalesce(s.spend,0) > 0
                then round(s.spend / l.leads, 2) end,
         case when coalesce(l.customers,0) > 0 and coalesce(s.spend,0) > 0
                then round(s.spend / l.customers, 2) end,
         case when coalesce(s.spend,0) > 0 then round(coalesce(l.revenue,0) / s.spend, 2) end,
         coalesce(l.leads,0), coalesce(l.followers,0), coalesce(l.qualified,0)
  from s full outer join l on l.k = s.k
  order by coalesce(s.spend, 0) desc, coalesce(s.k, l.k);
end;
$$;

revoke execute on function client_economics_by_channel(uuid, date, date) from public, anon;
grant  execute on function client_economics_by_channel(uuid, date, date) to authenticated, service_role;

revoke execute on function client_economics_by_channel(uuid, date, date) from public, anon;
grant execute on function client_economics_by_channel(uuid, date, date) to authenticated, service_role;

drop function client_economics_by_campaign(uuid, date, date);
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
  if not (auth.role() = 'service_role' or can_access_client(p_client_id)) then
    raise exception 'Not permitted for this client';
  end if;

  return query
  with s as (
    select sp.campaign_id as k, sum(sp.amount) as spend
    from client_marketing_spend sp
    where sp.client_id = p_client_id and sp.spent_on >= p_since and sp.spent_on < p_until
    group by 1
  ),
  l as (
    select p.source_campaign_id as k,
           count(*)::int as leads,
           count(*) filter (where p.furthest_rank >= 8)::int as customers,
           count(*) filter (where p.furthest_rank >= 2)::int as followers,
           count(*) filter (where p.furthest_rank >= 3)::int as qualified,
           sum(p.sale_value) as revenue,
           sum(p.cash_collected) as cash
    from lead_progress p
    where p.client_id = p_client_id
      and p.created_at >= p_since::timestamptz and p.created_at < p_until::timestamptz
    group by 1
  )
  select coalesce(s.k, l.k),
         coalesce(c.campaign_ref, '(unattributed)'),
         coalesce(s.spend, 0),
         coalesce(l.leads, 0),
         coalesce(l.customers, 0),
         coalesce(l.revenue, 0),
         coalesce(l.cash, 0),
         case when coalesce(l.leads,0) > 0 and coalesce(s.spend,0) > 0
                then round(s.spend / l.leads, 2) end,
         case when coalesce(l.customers,0) > 0 and coalesce(s.spend,0) > 0
                then round(s.spend / l.customers, 2) end,
         case when coalesce(s.spend,0) > 0 then round(coalesce(l.revenue,0) / s.spend, 2) end,
         coalesce(l.leads,0), coalesce(l.followers,0), coalesce(l.qualified,0)
  from s full outer join l on l.k = s.k
  left join campaigns c on c.id = coalesce(s.k, l.k)
  order by coalesce(s.spend, 0) desc, coalesce(c.campaign_ref, '(unattributed)');
end;
$$;

revoke execute on function client_economics_by_campaign(uuid, date, date) from public, anon;
grant  execute on function client_economics_by_campaign(uuid, date, date) to authenticated, service_role;

revoke execute on function client_economics_by_campaign(uuid, date, date) from public, anon;
grant execute on function client_economics_by_campaign(uuid, date, date) to authenticated, service_role;

-- Keep Bot finance reads consistent with the human economics functions.
create or replace function mcp_internal.cohort_economics(p_client_id uuid, p_start date, p_end date)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_spend numeric; v_cur text; v_mixed boolean;
  v_leads integer; v_followers integer; v_qual integer; v_appts integer; v_custs integer;
  v_rev numeric; v_cash numeric;
begin
  select coalesce(sum(s.amount), 0),
         case when count(distinct s.currency) = 1 then min(s.currency) end,
         count(distinct s.currency) > 1
    into v_spend, v_cur, v_mixed
  from public.client_marketing_spend s
  where s.client_id = p_client_id and s.spent_on >= p_start and s.spent_on < p_end;

  select count(*)::int,
         count(*) filter (where p.furthest_rank >= 2)::int,
         count(*) filter (where p.furthest_rank >= 3)::int,
         count(*) filter (where p.furthest_rank >= 6)::int,
         count(*) filter (where p.furthest_rank >= 8)::int,
         coalesce(sum(p.sale_value), 0),
         coalesce(sum(p.cash_collected), 0)
    into v_leads, v_followers, v_qual, v_appts, v_custs, v_rev, v_cash
  from (
    select l.client_id,
           coalesce(l.sale_value, 0) as sale_value,
           coalesce(l.cash_collected, 0) as cash_collected,
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
      and l.created_at >= p_start::timestamptz
      and l.created_at < p_end::timestamptz
  ) p;

  return jsonb_build_object(
    'spend', v_spend,
    'leads', v_leads,
    'profile_visits', v_leads, 'followers', v_followers, 'qualified', v_qual,
    'qualified_leads', v_qual,
    'appointments', v_appts,
    'customers', v_custs,
    'revenue', v_rev,
    'cash_collected', v_cash,
    'cpl', case when v_mixed then null when v_leads > 0 and v_spend > 0 then round(v_spend / v_leads, 2) end,
    'cpql', case when v_mixed then null when v_qual > 0 and v_spend > 0 then round(v_spend / v_qual, 2) end,
    'cpa', case when v_mixed then null when v_appts > 0 and v_spend > 0 then round(v_spend / v_appts, 2) end,
    'cac', case when v_mixed then null when v_custs > 0 and v_spend > 0 then round(v_spend / v_custs, 2) end,
    'roas', case when v_mixed then null when v_spend > 0 then round(v_rev / v_spend, 2) end,
    'cash_roas', case when v_mixed then null when v_spend > 0 then round(v_cash / v_spend, 2) end,
    'revenue_per_lead', case when v_leads > 0 then round(v_rev / v_leads, 2) end,
    'avg_customer_value', case when v_custs > 0 then round(v_rev / v_custs, 2) end,
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
           coalesce(s.spend, 0) as spend,
           coalesce(l.leads, 0) as leads,
           coalesce(l.leads, 0) as profile_visits,
           coalesce(l.followers, 0) as followers,
           coalesce(l.qualified, 0) as qualified,
           coalesce(l.customers, 0) as customers,
           coalesce(l.revenue, 0) as revenue,
           coalesce(l.cash, 0) as cash_collected,
           case when coalesce(l.leads,0) > 0 and coalesce(s.spend,0) > 0
                  then round(s.spend / l.leads, 2) end as cpl,
           case when coalesce(l.customers,0) > 0 and coalesce(s.spend,0) > 0
                  then round(s.spend / l.customers, 2) end as cac,
           case when coalesce(s.spend,0) > 0 then round(coalesce(l.revenue,0) / s.spend, 2) end as roas
    from (
      select sp.campaign_id as k, sum(sp.amount) as spend
      from public.client_marketing_spend sp
      where sp.client_id = p_client_id and sp.spent_on >= p_start and sp.spent_on < p_end
        and (p_campaign_id is null or sp.campaign_id is not distinct from p_campaign_id)
      group by 1
    ) s
    full outer join (
      select lp.source_campaign_id as k,
             count(*)::int as leads,
             count(*) filter (where lp.furthest_rank >= 8)::int as customers,
             count(*) filter (where lp.furthest_rank >= 2)::int as followers,
             count(*) filter (where lp.furthest_rank >= 3)::int as qualified,
             sum(lp.sale_value) as revenue,
             sum(lp.cash_collected) as cash
      from (
        select l.source_campaign_id,
               coalesce(l.sale_value, 0) as sale_value,
               coalesce(l.cash_collected, 0) as cash_collected,
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
