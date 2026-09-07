-- Attribution & Reporting OS: what caused what.
--
-- Not a dashboard. The purpose is to make one chain queryable end to end:
--
--   idea -> brief -> asset -> post -> attention -> lead -> conversation
--        -> appointment -> sale -> cash
--
-- Every link already exists. client_media_assets carries brief_id, briefs
-- carry source_idea_id, metrics_daily carries post_id, and client_leads now
-- carries the page, asset, post and campaign it came from. Nothing has ever
-- walked the whole thing, so "which content produced revenue" has been
-- unanswerable while the answer sat in the schema.
--
-- The revenue half works today. The attention half is zero until Meta is
-- connected, and the view says so by returning zeroes rather than nulls that
-- would read as "no data yet" and "none" alike.

create view content_attribution
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
  rev.cash_collected
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
         count(*) filter (where l.stage in ('sale','cash'))::int as sales,
         count(*) filter (where l.stage = 'lost')::int           as lost,
         coalesce(sum(l.opportunity_value), 0)::numeric as opportunity_value,
         coalesce(sum(l.sale_value), 0)::numeric        as sale_value,
         coalesce(sum(l.cash_collected), 0)::numeric    as cash_collected
  from client_leads l
  where l.source_asset_id = a.id
     -- a lead may name the post rather than the asset; both mean this asset
     or l.source_post_id in (select sp.id from scheduled_posts sp where sp.asset_id = a.id)
) rev on true;

comment on view content_attribution is
  'One row per asset, walking idea -> brief -> asset -> post -> attention -> revenue. The revenue half works now; the attention half is zero until Meta is connected.';

-- "Which content produced the most revenue?" — the first question the tool
-- was built to answer, and the shape most of the others take.
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
    and (auth.role() = 'service_role' or can_access_client(p_client_id))
  order by ca.cash_collected desc, ca.sale_value desc, ca.leads desc, ca.asset_created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 100));
$$;

revoke execute on function top_content_by_revenue(uuid, integer) from public, anon;
grant  execute on function top_content_by_revenue(uuid, integer) to authenticated, service_role;

-- The funnel for a period, with the ratios that actually get discussed.
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
  return_on_spend numeric
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
    select coalesce(sum(m.spend), 0)::numeric as total
    from metrics_daily m
    where m.client_id = p_client_id
      and m.metric_date >= (current_date - greatest(1, least(coalesce(p_days, 30), 3650)))
  ),
  counted as (
    select count(*)::int as leads,
           count(*) filter (where stage in ('conversation','qualified_conversation','appointment','qualified_appointment','shown','sale','cash'))::int as conversations,
           count(*) filter (where stage in ('appointment','qualified_appointment','shown','sale','cash'))::int as appointments,
           count(*) filter (where stage in ('sale','cash'))::int as sales,
           count(*) filter (where stage = 'lost')::int as lost,
           coalesce(sum(opportunity_value), 0)::numeric as pipeline_value,
           coalesce(sum(sale_value), 0)::numeric as sale_value,
           coalesce(sum(cash_collected), 0)::numeric as cash_collected
    from window_leads
  )
  select c.leads, c.conversations, c.appointments, c.sales, c.lost,
         c.pipeline_value, c.sale_value, c.cash_collected, s.total,
         -- Ratios return null rather than zero when the denominator is zero.
         -- A zero conversion rate and an unknown one are different facts, and
         -- showing 0% for "no leads yet" would be a lie a client would read.
         case when c.leads > 0 then round(100.0 * c.sales / c.leads, 1) end,
         case when c.leads > 0 and s.total > 0 then round(s.total / c.leads, 2) end,
         case when s.total > 0 then round(c.cash_collected / s.total, 2) end
  from counted c cross join spend s
  where auth.role() = 'service_role' or can_access_client(p_client_id);
$$;

revoke execute on function acquisition_funnel(uuid, integer) from public, anon;
grant  execute on function acquisition_funnel(uuid, integer) to authenticated, service_role;

comment on function acquisition_funnel(uuid, integer) is
  'Counts and ratios for a period. Ratios are null rather than zero when the denominator is zero, because "no leads yet" and "nothing converted" are different facts.';
