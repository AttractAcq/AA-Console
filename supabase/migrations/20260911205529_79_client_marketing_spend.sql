-- Client Economics OS: the cost side, and the economics that fall out of it.
--
-- Four tables in this database look like client spend and none of them is.
-- finance_entries and finance_periods are AA's OWN profit and loss — that CAC
-- is what it costs AA to win a client, not what it costs a client to win a
-- customer. client_billing is what a client pays AA. contract_payments is what
-- AA pays contractors. Keeping those separate from this is the whole point:
-- conflating them produces a number nobody can act on.
--
-- campaigns.total_spend is the closest existing thing and still unusable here,
-- because it is a lump sum with no date inside it. "Spend in the last 30 days"
-- is unanswerable from a column that covers a two-month campaign.
--
-- So this is the canonical ledger. Manual entry works today; Meta, Google and
-- file imports become adapters that write into THIS table rather than systems
-- of their own. The economics engine never learns where a row came from.

create table client_marketing_spend (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients (id) on delete cascade,
  spent_on           date not null,
  amount             numeric not null check (amount >= 0),
  currency           text not null default 'ZAR',
  source             text not null default 'manual'
                       check (source in ('manual', 'meta', 'google', 'import')),
  channel            text,
  campaign_id        uuid references campaigns (id) on delete set null,
  client_campaign_id uuid references client_campaigns (id) on delete set null,
  external_ref       text,
  description        text,
  created_by         uuid references profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index client_marketing_spend_client_date_idx
  on client_marketing_spend (client_id, spent_on desc);
create index client_marketing_spend_campaign_idx
  on client_marketing_spend (campaign_id) where campaign_id is not null;

-- Duplicate protection for imports, scoped to (client, source, external_ref).
--
-- Deliberately NOT globally unique on external_ref: two ad accounts, or Meta
-- and Google, can legitimately emit the same id, and a global constraint would
-- reject the second one as a duplicate of something unrelated. Scoping to the
-- client and the source is the narrowest rule that still makes re-running an
-- import safe. Manual rows carry no external_ref and are never blocked — a
-- person entering the same amount twice is a judgement call, not a collision.
create unique index client_marketing_spend_external_uniq
  on client_marketing_spend (client_id, source, external_ref)
  where external_ref is not null;

comment on table client_marketing_spend is
  'The canonical ledger of client acquisition spend. Manual entry today; Meta/Google/import become adapters writing into this same table. Distinct from finance_entries, which is AA''s own P&L.';
comment on column client_marketing_spend.spent_on is
  'The day the money was spent. This is the date economics windows on — campaigns.total_spend has no date inside it, which is why it cannot answer "spend in the last 30 days".';
comment on column client_marketing_spend.source is
  'Where the row came from. The economics engine never branches on this: manual and integrated spend are the same kind of fact.';
comment on column client_marketing_spend.currency is
  'v1 assumes one currency per client. client_leads carries no currency at all, so every ratio here already assumes spend and revenue share one. Mixed currencies in a window are reported rather than silently summed into a wrong ratio.';
comment on column client_marketing_spend.external_ref is
  'The provider''s id for this spend row. Unique per (client, source) so re-running an import is safe without rejecting a different provider that reuses ids.';

alter table client_marketing_spend enable row level security;

create policy cms_admin_all on client_marketing_spend
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cms_client_read on client_marketing_spend
  for select to authenticated using (is_client_user(client_id));

-- How deep into the funnel a stage is.
--
-- `lost` is not a depth — it is a way of stopping — so it ranks as 1: a lost
-- lead was at least a lead, and how far it actually got before dying is only
-- knowable from its events.
create or replace function lead_stage_rank(s lead_stage)
returns integer
language sql
immutable
as $$
  select case s
    when 'lead' then 1
    when 'conversation' then 2
    when 'qualified_conversation' then 3
    when 'appointment' then 4
    when 'qualified_appointment' then 5
    when 'shown' then 6
    when 'sale' then 7
    when 'cash' then 8
    when 'lost' then 1
  end;
$$;

comment on function lead_stage_rank(lead_stage) is
  'Funnel depth of a stage. lost ranks 1 because it is a way of stopping rather than a depth — a lost lead was at least a lead.';

-- Each lead with the furthest point it ever reached.
--
-- Counting by CURRENT stage is the trap: a lead sitting at `cash` would not be
-- counted as having had an appointment, so cost-per-appointment would be
-- wildly overstated. lead_events records every transition, so furthest-reached
-- is recoverable.
--
-- `greatest(current, max(events))` also solves the legacy case without a
-- branch: a lead with no events falls back to its current stage, which is
-- exactly the right answer and is half the leads in production today.
create or replace view lead_progress with (security_invoker = on) as
select
  l.id                as lead_id,
  l.client_id,
  l.created_at,
  l.stage,
  l.source_channel,
  l.source_campaign_id,
  coalesce(l.sale_value, 0)      as sale_value,
  coalesce(l.cash_collected, 0)  as cash_collected,
  coalesce(l.opportunity_value, 0) as opportunity_value,
  greatest(
    lead_stage_rank(l.stage),
    coalesce((
      select max(lead_stage_rank(e.to_stage))
      from lead_events e
      where e.lead_id = l.id and e.kind = 'stage_change' and e.to_stage is not null
    ), 0)
  ) as furthest_rank,
  (l.stage = 'lost' or exists (
    select 1 from lead_events e where e.lead_id = l.id and e.to_stage = 'lost'
  )) as ever_lost
from client_leads l;

comment on view lead_progress is
  'Every lead with the furthest funnel depth it ever reached, from lead_events, falling back to current stage for leads with no events.';

-- Client economics for an acquisition cohort.
--
-- THE WINDOW IS THE COHORT, NOT THE REVENUE PERIOD. "Last 30 days" means:
-- spend recorded in those 30 days, leads acquired in those 30 days, and the
-- outcome of THOSE leads as it stands today. It does not mean revenue events
-- that landed in the last 30 days.
--
-- That is a deliberate choice forced by the schema: client_leads has no sale
-- date and no cash date, and sale_value / cash_collected are running totals.
-- Pairing "the date the sale transition happened" with "the amount as it
-- stands now" would let a closed month change when an old deal is topped up,
-- and cash collected in instalments has no history at all to split. Cohort
-- economics pairs spend with the revenue that spend actually bought, which is
-- also what makes CAC mean anything.
--
-- The cost: a young cohort understates. September's ROAS is a FLOOR that rises
-- as those leads close, and the UI says so rather than presenting it as final.
--
-- Event-period reporting needs a dated revenue ledger (lead_revenue_events
-- with amount and occurred_at). That belongs in the Revenue Pipeline /
-- Attribution sweep, not here.
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
  mixed_currency   boolean
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
         count(*) filter (where p.furthest_rank >= 3)::int,
         count(*) filter (where p.furthest_rank >= 4)::int,
         count(*) filter (where p.furthest_rank >= 7)::int,
         coalesce(sum(p.sale_value), 0),
         coalesce(sum(p.cash_collected), 0)
    into v_leads, v_qual, v_appts, v_custs, v_rev, v_cash
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
    v_mixed;
end;
$$;

revoke execute on function client_economics(uuid, date, date) from public, anon;
grant  execute on function client_economics(uuid, date, date) to authenticated, service_role;

comment on function client_economics(uuid, date, date) is
  'Acquisition-cohort economics: spend in the window, leads acquired in the window, and the outcome of those leads to date. Ratios are null when the denominator is zero or the window mixes currencies. until is exclusive.';

-- Economics split by channel.
--
-- Spend carries its own `channel`; a lead carries `source_channel`. They are
-- matched on exact string equality and nothing is invented: spend with no
-- channel and leads with no source_channel both land in '(unattributed)', and
-- a channel that has spend but no leads still appears. Bucket totals therefore
-- reconcile to the totals from client_economics.
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
  roas             numeric
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
           count(*) filter (where p.furthest_rank >= 7)::int as customers,
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
         case when coalesce(s.spend,0) > 0 then round(coalesce(l.revenue,0) / s.spend, 2) end
  from s full outer join l on l.k = s.k
  order by coalesce(s.spend, 0) desc, coalesce(s.k, l.k);
end;
$$;

revoke execute on function client_economics_by_channel(uuid, date, date) from public, anon;
grant  execute on function client_economics_by_channel(uuid, date, date) to authenticated, service_role;

comment on function client_economics_by_channel(uuid, date, date) is
  'Cohort economics per channel. Spend.channel is matched to lead.source_channel on exact equality; unmatched spend and unmatched leads both land in (unattributed), so buckets reconcile to the totals.';

-- Economics split by ad campaign.
--
-- Both sides reference `campaigns`: spend via campaign_id, leads via
-- source_campaign_id. Nothing is guessed — a lead with no campaign link is
-- unattributed and says so.
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
  roas           numeric
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
           count(*) filter (where p.furthest_rank >= 7)::int as customers,
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
         case when coalesce(s.spend,0) > 0 then round(coalesce(l.revenue,0) / s.spend, 2) end
  from s full outer join l on l.k = s.k
  left join campaigns c on c.id = coalesce(s.k, l.k)
  order by coalesce(s.spend, 0) desc, coalesce(c.campaign_ref, '(unattributed)');
end;
$$;

revoke execute on function client_economics_by_campaign(uuid, date, date) from public, anon;
grant  execute on function client_economics_by_campaign(uuid, date, date) to authenticated, service_role;

comment on function client_economics_by_campaign(uuid, date, date) is
  'Cohort economics per ad campaign. Leads with no source_campaign_id are reported as (unattributed) rather than dropped.';

-- One source of truth for spend.
--
-- acquisition_funnel read metrics_daily.spend, which has no rows and will not
-- have any until Meta is connected — so its cost_per_lead and return_on_spend
-- have always been null in production. Pointing it at the canonical ledger
-- makes tool 7 and Client Economics agree about money.
--
-- Recreated with exactly one changed CTE. The signature, the column names and
-- the null-on-zero-denominator behaviour are untouched.
--
-- NOTE ON THE LEGACY NAME: `return_on_spend` computes cash_collected / spend,
-- which is Cash ROAS, not ROAS. That name is kept for compatibility in this
-- phase. Client Economics exposes `roas` and `cash_roas` separately and
-- correctly; renaming this one belongs in the tool 7 completion sweep.
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
           count(*) filter (where stage in ('sale','cash'))::int as sales,
           count(*) filter (where stage = 'lost')::int as lost,
           coalesce(sum(opportunity_value), 0)::numeric as pipeline_value,
           coalesce(sum(sale_value), 0)::numeric as sale_value,
           coalesce(sum(cash_collected), 0)::numeric as cash_collected
    from window_leads
  )
  select c.leads, c.conversations, c.appointments, c.sales, c.lost,
         c.pipeline_value, c.sale_value, c.cash_collected, s.total,
         case when c.leads > 0 then round(100.0 * c.sales / c.leads, 1) end,
         case when c.leads > 0 and s.total > 0 then round(s.total / c.leads, 2) end,
         case when s.total > 0 then round(c.cash_collected / s.total, 2) end
  from counted c cross join spend s
  where auth.role() = 'service_role' or can_access_client(p_client_id);
$$;

comment on function acquisition_funnel(uuid, integer) is
  'Counts and ratios for a period. Spend comes from client_marketing_spend, the canonical ledger shared with Client Economics. Ratios are null rather than zero when the denominator is zero. NOTE: return_on_spend is cash_collected/spend — Cash ROAS — and keeps that name for compatibility; Client Economics exposes roas and cash_roas correctly.';
