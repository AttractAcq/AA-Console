-- B005: reporting RPCs expose the same lead, sales and cash facts as Sales OS.
-- Migration 265 defines the explicit service/admin/client-user entitlement.
-- A job or SMM client assignment alone must not authorize these definer reads.
-- Keep the migration-62/130 return shapes and calculations intact.
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
  order by ca.cash_collected desc, ca.sale_value desc, ca.leads desc, ca.asset_created_at desc
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
  where may_manage_client_leads(p_client_id);
$$;

revoke execute on function acquisition_funnel(uuid, integer) from public, anon;
grant execute on function acquisition_funnel(uuid, integer) to authenticated, service_role;


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
grant execute on function client_economics_by_campaign(uuid, date, date) to authenticated, service_role;

-- Migration 19 narrowed proof metadata reads to admin/client-user. Migration
-- 209 later reopened metadata INSERT to any assigned employee (while requiring
-- not_cleared rights). Restore the same client-user boundary for INSERT so the
-- Storage upload path and metadata row share one human entitlement. The admin
-- all policy remains separate; service-role capture uses its own trusted path.
drop policy if exists cpa_client_insert on public.client_proof_assets;
create policy cpa_client_insert on public.client_proof_assets
  for insert to authenticated
  with check (public.is_client_user(client_id) and usage_rights = 'not_cleared');

-- The proof bucket stores files at {client_id}/{proof_id}/... . The former
-- can_access_client predicates let any assigned editor read proof bytes,
-- although migration 19 denied the corresponding proof metadata.
drop policy if exists proof_obj_client_insert on storage.objects;
create policy proof_obj_client_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'proof'
    and public.is_client_user(public.try_uuid((storage.foldername(name))[1])));
drop policy if exists proof_obj_client_read on storage.objects;
create policy proof_obj_client_read on storage.objects
  for select to authenticated
  using (bucket_id = 'proof'
    and public.is_client_user(public.try_uuid((storage.foldername(name))[1])));

-- Retired employee profiles retain role='employee' for history, but lose
-- current_member_id() under migration 127. Admin access remains through the
-- bucket's separate admin-all policy.
drop policy if exists sops_obj_staff_read on storage.objects;
create policy sops_obj_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'sops' and (public.is_admin() or
    (public.current_role_of() = 'employee'::public.app_role
      and public.current_member_id() is not null)));
