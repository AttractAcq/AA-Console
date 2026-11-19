-- Keep direct Archive recovery from bypassing a pending return review.
begin;
create or replace function public.recover_lead(p_lead_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_archive public.archived_leads%rowtype;
  v_columns text;
  v_values text;
begin
  select * into v_archive from public.archived_leads where id = p_lead_id for update;
  if not found then raise exception 'That archived lead no longer exists.'; end if;
  if not public.may_manage_client_leads(v_archive.client_id) then
    raise exception 'Not permitted for this client'; end if;
  -- A consented return held against this archive must have a current exact
  -- AAL2 resolution before the old identity can re-enter the pipeline.
  if exists (
    select 1 from public.lead_submissions s
    where s.archive_match_lead_id=p_lead_id and s.status='received'
      and not exists (
        select 1 from public.lead_return_resolutions_v11 r
        where r.submission_id=s.id and r.client_id=s.client_id
          and r.archived_lead_id=p_lead_id and r.action='recover'
          and r.reviewer_aal='aal2')
  ) then
    raise exception 'A returning submission needs exact AAL2 review before recovery.'
      using errcode='23514';
  end if;
  if v_archive.stage_at_archive in ('lead','sale') then
    raise exception 'This legacy lead cannot be recovered into an old stage.';
  end if;
  select string_agg(format('%I', a.attname), ', ' order by a.attnum),
         string_agg(format('r.%I', a.attname), ', ' order by a.attnum)
    into v_columns,v_values
    from pg_catalog.pg_attribute a
    where a.attrelid='public.client_leads'::regclass
      and a.attnum>0 and not a.attisdropped and a.attgenerated='';
  if v_columns is null or v_values is null then
    raise exception 'Client lead restore columns are unavailable'; end if;
  execute format('insert into public.client_leads (%s) select %s '
    || 'from jsonb_populate_record(null::public.client_leads, $1) as r',
    v_columns,v_values) using v_archive.lead;
  insert into public.lead_events
    select * from jsonb_populate_recordset(null::public.lead_events,v_archive.events);
  insert into public.lead_events (lead_id,client_id,kind,body,created_by)
  values (p_lead_id,v_archive.client_id,'note',
    'Recovered from archive on ' || to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI') || ' UTC',auth.uid());
  delete from public.archived_leads where id = p_lead_id;
end;
$$;
revoke execute on function public.recover_lead(uuid) from public,anon;
grant execute on function public.recover_lead(uuid) to authenticated,service_role;
select public.lock_down_definer_functions();
commit;
