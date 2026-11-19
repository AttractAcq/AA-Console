-- Page outcomes remain first-source associations, including archived leads.
-- Collected cash is comparable only when every positive amount has one known
-- currency. Keep the v8 signature for existing callers but make it truthful;
-- v9 also exposes currency coverage for the Console.
begin;
create function public.page_recorded_outcomes_v9(
  p_client_id uuid,p_page_type text,p_days integer default 30)
returns table(
  page_id uuid,page_title text,archived_at timestamptz,
  recorded_leads integer,consented_leads integer,recorded_sales integer,
  recorded_cash numeric,cash_currency text,
  cash_currency_unverified_leads integer,cash_currency_count integer,
  latest_lead_at timestamptz
)
language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare v_days integer:=greatest(1,least(coalesce(p_days,30),3650));
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  if p_page_type not in ('landing','offer') then
    raise exception 'Unsupported page type.' using errcode='22023';
  end if;
  return query
  select page.id,page.title,page.archived_at,
    count(lead.id)::integer,
    count(lead.id) filter(where lead.consent_given_at is not null
      and nullif(btrim(lead.consent_wording),'') is not null)::integer,
    count(lead.id) filter(where progress.sale_evidence)::integer,
    case when coalesce(sum(lead.cash_collected),0)=0 then 0
         when count(*) filter (where coalesce(lead.cash_collected,0)>0
           and lead.cash_currency is null)=0
           and count(distinct lead.cash_currency)
             filter (where coalesce(lead.cash_collected,0)>0)=1
         then sum(lead.cash_collected) end::numeric,
    case when count(*) filter (where coalesce(lead.cash_collected,0)>0
           and lead.cash_currency is null)=0
           and count(distinct lead.cash_currency)
             filter (where coalesce(lead.cash_collected,0)>0)=1
         then min(lead.cash_currency)
           filter (where coalesce(lead.cash_collected,0)>0) end,
    count(*) filter (where coalesce(lead.cash_collected,0)>0
      and lead.cash_currency is null)::integer,
    count(distinct lead.cash_currency)
      filter (where coalesce(lead.cash_collected,0)>0)::integer,
    max(lead.created_at)
  from public.client_pages page
  left join public.reporting_lead_rows_v10(p_client_id) lead
    on lead.client_id=page.client_id and lead.source_page_id=page.id
      and not coalesce(lead.is_probe,false)
      and lead.created_at>=now()-make_interval(days=>v_days)
  left join public.reporting_lead_progress_v10(p_client_id) progress
    on progress.lead_id=lead.id and progress.client_id=lead.client_id
  where page.client_id=p_client_id and page.page_type::text=p_page_type
  group by page.id,page.title,page.archived_at
  order by count(lead.id) desc,page.title,page.id;
end $$;
revoke all on function public.page_recorded_outcomes_v9(uuid,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.page_recorded_outcomes_v9(uuid,text,integer)
  to authenticated,service_role;
comment on function public.page_recorded_outcomes_v9(uuid,text,integer) is
  'First-source page lead, consent, sale and cash associations, including archived leads. Cash is withheld when currencies are mixed or unknown; no page visits or causation inferred.';

create or replace function public.page_recorded_outcomes_v8(
  p_client_id uuid,p_page_type text,p_days integer default 30)
returns table(
  page_id uuid,page_title text,archived_at timestamptz,
  recorded_leads integer,consented_leads integer,recorded_sales integer,
  recorded_cash numeric,latest_lead_at timestamptz
)
language sql stable security definer
set search_path=pg_catalog,public as $$
  select r.page_id,r.page_title,r.archived_at,r.recorded_leads,
         r.consented_leads,r.recorded_sales,r.recorded_cash,r.latest_lead_at
  from public.page_recorded_outcomes_v9(p_client_id,p_page_type,p_days) r;
$$;
revoke all on function public.page_recorded_outcomes_v8(uuid,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.page_recorded_outcomes_v8(uuid,text,integer)
  to authenticated,service_role;
select public.lock_down_definer_functions();
commit;
