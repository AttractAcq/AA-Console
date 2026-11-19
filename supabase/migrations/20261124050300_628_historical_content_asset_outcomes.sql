-- Restore historical content outcomes without exposing full archived leads to
-- the security-invoker attribution view. Callers who cannot read client leads
-- receive the same zero outcome aggregates that underlying RLS produced.
begin;
create function public.content_asset_outcomes_v10(p_client_id uuid,p_asset_id uuid)
returns table (
  leads integer, conversations integer, appointments integer, sales integer,
  lost integer, opportunity_value numeric, sale_value numeric,
  cash_collected numeric, profile_visits integer, followers integer,
  qualified integer
)
language plpgsql stable security definer
set search_path=pg_catalog,public as $$
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    return query select 0::integer,0::integer,0::integer,0::integer,
      0::integer,0::numeric,0::numeric,0::numeric,
      0::integer,0::integer,0::integer;
    return;
  end if;
  return query
  select count(*)::integer,
         count(*) filter (where l.stage in ('conversation','qualified_conversation',
           'appointment','qualified_appointment','shown','sale','cash'))::integer,
         count(*) filter (where l.stage in ('appointment','qualified_appointment',
           'shown','sale','cash'))::integer,
         count(*) filter (where p.sale_evidence)::integer,
         count(*) filter (where l.stage='lost')::integer,
         case when coalesce(sum(l.opportunity_value),0)=0 then 0
              when count(*) filter (where l.opportunity_value>0
                and l.opportunity_currency is null)=0
                and count(distinct l.opportunity_currency)
                  filter (where l.opportunity_value>0)=1
              then sum(l.opportunity_value) end::numeric,
         case when coalesce(sum(l.sale_value),0)=0 then 0
              when count(*) filter (where l.sale_value>0
                and l.sale_currency is null)=0
                and count(distinct l.sale_currency)
                  filter (where l.sale_value>0)=1
              then sum(l.sale_value) end::numeric,
         case when coalesce(sum(l.cash_collected),0)=0 then 0
              when count(*) filter (where l.cash_collected>0
                and l.cash_currency is null)=0
                and count(distinct l.cash_currency)
                  filter (where l.cash_collected>0)=1
              then sum(l.cash_collected) end::numeric,
         count(*) filter (where public.lead_stage_rank(l.stage)>=1)::integer,
         count(*) filter (where public.lead_stage_rank(l.stage)>=2)::integer,
         count(*) filter (where public.lead_stage_rank(l.stage)>=3)::integer
  from public.reporting_lead_rows_v10(p_client_id) l
  join public.reporting_lead_progress_v10(p_client_id) p
    on p.lead_id=l.id and p.client_id=l.client_id
  where l.client_id=p_client_id and
    (l.source_asset_id=p_asset_id or l.source_post_id in (
      select sp.id from public.scheduled_posts sp
      where sp.asset_id=p_asset_id and sp.client_id=p_client_id));
end $$;
revoke all on function public.content_asset_outcomes_v10(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.content_asset_outcomes_v10(uuid,uuid)
  to authenticated,service_role;
comment on function public.content_asset_outcomes_v10(uuid,uuid) is
  'Aggregate only, client-scoped content outcomes including archived snapshots. Non-sales viewers receive zero outcomes, matching the existing security-invoker view.';

-- The security-invoker content_attribution view is redefined below with the
-- same columns, joins, metrics and RLS behavior. Only its lead aggregation
-- lateral source changes to content_asset_outcomes_v10.
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

  -- What attention it got. Missing provider rows remain unknown, not zero.
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
  where sp.asset_id = a.id and sp.client_id = a.client_id
) d on true
left join lateral (
  select sum(m.impressions)::bigint as impressions,
         sum(m.reach)::bigint       as reach,
         sum(m.clicks)::bigint      as clicks,
         case when count(m.id) filter (where m.surface='paid' and m.basis='daily')=0 then null
              when count(*) filter (where m.surface='paid' and m.basis='daily' and m.spend is null)>0 then null
              when coalesce(sum(m.spend) filter (where m.surface='paid' and m.basis='daily'),0)=0 then 0
              when count(*) filter (where m.surface='paid' and m.basis='daily' and m.spend>0 and m.currency is null)=0
                and count(distinct m.currency) filter (where m.surface='paid' and m.basis='daily' and m.spend>0)=1
              then sum(m.spend) filter (where m.surface='paid' and m.basis='daily') end::numeric as spend
  from (
    select observed.* from (
      select m.*, row_number() over (
        partition by m.post_id,m.surface,m.entity_type,m.external_id
        order by m.metric_date desc,m.fetched_at desc,m.id desc
      ) as snapshot_rank
      from metrics_daily m
      join scheduled_posts sp on sp.id=m.post_id and sp.client_id=a.client_id
      where sp.asset_id=a.id and m.client_id=a.client_id
    ) observed
    where observed.basis='daily'
       or (observed.basis='cumulative' and observed.snapshot_rank=1)
  ) m
) att on true
left join lateral (
  select * from public.content_asset_outcomes_v10(a.client_id,a.id)
) rev on true;
select public.lock_down_definer_functions();
commit;
