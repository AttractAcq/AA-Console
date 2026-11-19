-- One source row per durable lead for future historical reporting. This does
-- not release cash-positive archiving: existing reports and action claims must
-- be moved and checked before archive_lead can delete a cash lead safely.
begin;
create function public.reporting_lead_rows_v10(p_client_id uuid)
returns setof public.client_leads language plpgsql stable security definer
set search_path=pg_catalog,public as $$
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode='42501'; end if;
  return query
  select l.* from public.client_leads l where l.client_id=p_client_id
  union all
  select snapshot.*
  from public.archived_leads a
  cross join lateral jsonb_populate_record(null::public.client_leads,a.lead) snapshot
  where a.client_id=p_client_id and snapshot.client_id=a.client_id
    and snapshot.id=a.id
    and not exists (select 1 from public.client_leads live where live.id=a.id);
end $$;
revoke all on function public.reporting_lead_rows_v10(uuid)
  from public,anon,authenticated,service_role;
comment on function public.reporting_lead_rows_v10(uuid) is
  'Internal one-row-per-lead source for historical reports. Current row wins during an archive transition; archived snapshot is otherwise used. No new money, source or currency is inferred.';
select public.lock_down_definer_functions();
commit;
