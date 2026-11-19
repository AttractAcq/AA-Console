-- One exact, read-only review packet for an archived identity reached by
-- multiple capture doors. No batch decision or archive transition is enabled.
begin;
create function public.archived_return_batch_review_packet_v11(p_archived_lead_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare a public.archived_leads%rowtype;
  v_sources jsonb; v_dms jsonb;
  v_source_count integer; v_dm_count integer;
  v_hash text;
begin
  if auth.role()<>'authenticated' or auth.uid() is null then
    raise exception 'A signed-in lead reviewer is required.' using errcode='42501';
  end if;
  select * into a from public.archived_leads where id=p_archived_lead_id;
  if a.id is null or not public.may_manage_client_leads(a.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;

  select coalesce(jsonb_agg(x.packet order by x.at,x.kind,x.id),'[]'::jsonb),
         count(*)::integer into v_sources,v_source_count
  from (
    select s.id,s.created_at as at,'form'::text as kind,
      public.archived_return_review_packet_v11(s.id)
        ||jsonb_build_object('kind','form') as packet
    from public.lead_submissions s
    where s.client_id=a.client_id and s.archive_match_lead_id=a.id
      and s.status='received' and s.lead_id is null
    union all
    select c.id,c.started_at as at,'sales_agent'::text as kind,
      public.sales_agent_return_review_packet_v11(c.id)
        ||jsonb_build_object('kind','sales_agent') as packet
    from public.sales_agent_conversations c
    where c.client_id=a.client_id and c.archive_match_lead_id=a.id
      and c.lead_id is null and c.archive_match_snapshot is not null
  ) x;

  select coalesce(jsonb_agg(x.packet order by x.at,x.id),'[]'::jsonb),
         count(*)::integer into v_dms,v_dm_count
  from (
    select c.id,c.last_inbound_at as at,
      jsonb_build_object(
        'kind','dm','conversation_id',c.id,'platform',c.platform,
        'last_inbound_at',c.last_inbound_at,
        'unread_inbound',c.unread_inbound,
        'source_hash',encode(sha256(convert_to(jsonb_build_object(
          'conversation',to_jsonb(c),'identity',to_jsonb(i),
          'messages',coalesce((select jsonb_agg(to_jsonb(m) order by m.occurred_at,m.id)
            from public.dm_messages m where m.conversation_id=c.id),
            '[]'::jsonb))::text,'UTF8')),'hex')) as packet
    from public.dm_conversations c
    join public.dm_identities i on i.id=c.identity_id and i.client_id=c.client_id
    where c.client_id=a.client_id and i.lead_id=a.id
      and c.status='closed' and c.closed_reason='archived_lead_return_review'
  ) x;

  if v_source_count+v_dm_count<1 then
    raise exception 'This archived identity has no pending return to review.'
      using errcode='23514';
  end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object(
    'archive',to_jsonb(a),'sources',v_sources,'dms',v_dms)::text,'UTF8')),'hex');
  return jsonb_build_object(
    'client_id',a.client_id,'archived_lead_id',a.id,
    'archived_name',a.name,'archived_at',a.archived_at,
    'source_hash',v_hash,'source_count',v_source_count,'dm_count',v_dm_count,
    'sources',v_sources,'dms',v_dms,
    'decision_state',case when v_source_count+v_dm_count>1 then 'grouped_hold'
      else 'single_source' end,
    'blocker',case when v_dm_count>0
      then 'An archived DM also needs source-specific identity review. Keep every door held.'
      when v_source_count>1 then
        'All arrivals need one exact coordinated AAL2 identity decision. Keep every door held.'
      else 'One source is pending. Use its individual Sales OS AAL2 review.' end);
end $$;
revoke all on function public.archived_return_batch_review_packet_v11(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.archived_return_batch_review_packet_v11(uuid)
  to authenticated;
comment on function public.archived_return_batch_review_packet_v11(uuid) is
  'Read-only exact packet for multiple archived-contact returns. No recovery or promotion authority.';
select public.lock_down_definer_functions();
commit;
