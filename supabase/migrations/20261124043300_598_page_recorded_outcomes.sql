-- First-party conversion evidence for landing and offer pages. The source
-- page is the lead's recorded first source; it is not a page-view count or a
-- claim that this page caused a later sale. Retain archived page rows.
create function public.page_recorded_outcomes_v8(
  p_client_id uuid,p_page_type text,p_days integer default 30)
returns table(
  page_id uuid,page_title text,archived_at timestamptz,
  recorded_leads integer,consented_leads integer,recorded_sales integer,
  recorded_cash numeric,latest_lead_at timestamptz
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
  select p.id,p.title,p.archived_at,
    count(l.id)::integer,
    count(l.id) filter(where l.consent_given_at is not null
      and nullif(btrim(l.consent_wording),'') is not null)::integer,
    count(l.id) filter(where l.stage in ('shown','sale','cash'))::integer,
    coalesce(sum(l.cash_collected),0)::numeric,max(l.created_at)
  from public.client_pages p
  left join public.client_leads l on l.client_id=p.client_id
    and l.source_page_id=p.id and not coalesce(l.is_probe,false)
    and l.created_at>=now()-make_interval(days=>v_days)
  where p.client_id=p_client_id and p.page_type::text=p_page_type
  group by p.id,p.title,p.archived_at
  order by count(l.id) desc,p.title,p.id;
end $$;
revoke all on function public.page_recorded_outcomes_v8(uuid,text,integer)
  from public,anon,authenticated;
grant execute on function public.page_recorded_outcomes_v8(uuid,text,integer)
  to authenticated,service_role;
comment on function public.page_recorded_outcomes_v8(uuid,text,integer) is
  'Recorded first-source page lead, consent, stage and cash associations for a bounded window. Excludes probes; never supplies page visits or causal attribution.';
select public.lock_down_definer_functions();
