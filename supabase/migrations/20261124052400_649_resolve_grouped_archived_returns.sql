-- One signed-in AAL2 decision resolves all pending form/sales arrivals for an
-- archived identity. A held DM remains a blocker until its own review exists.
begin;
create function public.resolve_archived_return_batch_v11(
  p_archived_lead_id uuid,p_action text,p_expected_hash text,p_reason text,
  p_primary_kind text default null,p_primary_id uuid default null)
returns uuid language plpgsql security definer
set search_path=pg_catalog,public as $$
declare a public.archived_leads%rowtype;
  s public.lead_submissions%rowtype;
  c public.sales_agent_conversations%rowtype;
  v_packet jsonb; v_source jsonb; v_item jsonb; v_items jsonb:='[]'::jsonb;
  v_key text; v_source_key text; v_source_id uuid; v_request_id uuid;
  v_lead uuid; v_batch_id uuid; v_resolution_id uuid;
  v_primary_found boolean:=false; v_source_json jsonb;
  v_stage public.lead_stage;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
     or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A signed-in AAL2 lead reviewer is required.'
      using errcode='42501';
  end if;
  if p_action not in ('recover','new_lead')
     or length(btrim(coalesce(p_reason,''))) not between 8 and 2000
     or p_expected_hash !~ '^[0-9a-f]{64}$'
     or (p_action='new_lead' and
       (p_primary_kind not in ('form','sales_agent') or p_primary_id is null))
     or (p_action='recover' and
       (p_primary_kind is not null or p_primary_id is not null)) then
    raise exception 'Choose an exact grouped outcome, primary source and reason.'
      using errcode='23514';
  end if;

  select * into a from public.archived_leads where id=p_archived_lead_id;
  if a.id is null or not public.may_manage_client_leads(a.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  -- Match the single-source lock order: lock source rows before the shared
  -- contact advisory lock and archive row. A new capture then waits on the
  -- archive lock and cannot enter after the final packet comparison.
  perform 1 from public.lead_submissions
    where client_id=a.client_id and archive_match_lead_id=p_archived_lead_id
      and status='received' and lead_id is null order by id for update;
  perform 1 from public.sales_agent_conversations
    where client_id=a.client_id and archive_match_lead_id=p_archived_lead_id
      and lead_id is null and archive_match_snapshot is not null
    order by id for update;
  v_key:=coalesce(a.lead->>'dedupe_key',
    public.lead_dedupe_key(a.lead->>'email',a.lead->>'phone'));
  if v_key is null then
    raise exception 'The archived contact has no comparable identity.'
      using errcode='23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    a.client_id::text||':lead-contact:'||v_key,0));
  select * into a from public.archived_leads
    where id=p_archived_lead_id and client_id=a.client_id for update;
  if a.id is null or coalesce(a.lead->>'dedupe_key',
       public.lead_dedupe_key(a.lead->>'email',a.lead->>'phone'))
       is distinct from v_key
     or (select count(*) from public.archived_leads x
       where x.client_id=a.client_id and coalesce(x.lead->>'dedupe_key',
         public.lead_dedupe_key(x.lead->>'email',x.lead->>'phone'))=v_key)<>1
     or exists(select 1 from public.client_leads l
       where l.client_id=a.client_id and l.dedupe_key=v_key) then
    raise exception 'The archived identity changed or now matches another lead.'
      using errcode='23514';
  end if;
  -- Inbound DM updates its identity row before changing the held conversation.
  perform 1 from public.dm_identities i
    where i.client_id=a.client_id and i.lead_id=a.id
    order by i.id for update;
  v_packet:=public.archived_return_batch_review_packet_v11(a.id);
  if v_packet->>'source_hash' is distinct from p_expected_hash
     or v_packet->>'decision_state'<>'grouped_hold'
     or (v_packet->>'source_count')::integer<2
     or (v_packet->>'dm_count')::integer<>0 then
    raise exception 'The grouped arrivals changed or a DM still needs review.'
      using errcode='23514';
  end if;

  -- Preflight every source and its canonical card before creating a lead or
  -- writing any decision. The outer RPC transaction rolls everything back.
  for v_source in select value from jsonb_array_elements(v_packet->'sources') loop
    v_source_id:=case v_source->>'kind'
      when 'form' then (v_source->>'submission_id')::uuid
      else (v_source->>'conversation_id')::uuid end;
    if v_source->>'kind'='form' then
      select * into s from public.lead_submissions where id=v_source_id;
      if s.id is null or s.client_id<>a.client_id
         or s.archive_match_lead_id<>a.id or s.status<>'received'
         or s.lead_id is not null or s.consent_given_at is null
         or nullif(btrim(s.consent_wording),'') is null then
        raise exception 'A held form or its consent changed.' using errcode='23514';
      end if;
      v_source_key:=public.lead_dedupe_key(s.email,s.phone);
      v_source_json:=s.consent_evidence->'source_snapshot';
      if v_source_json is null or jsonb_typeof(v_source_json)<>'object'
         or nullif(v_source_json->>'purpose','') is null then
        raise exception 'A held form has no captured source snapshot.'
          using errcode='23514';
      end if;
    elsif v_source->>'kind'='sales_agent' then
      select * into c from public.sales_agent_conversations where id=v_source_id;
      if c.id is null or c.client_id<>a.client_id
         or c.archive_match_lead_id<>a.id or c.lead_id is not null
         or c.archive_match_snapshot is null then
        raise exception 'A held sales conversation changed.' using errcode='23514';
      end if;
      v_source_key:=c.archive_match_snapshot->>'contact_key';
      if v_source_key is distinct from public.lead_dedupe_key(
           c.archive_match_snapshot->>'contact_email',
           c.archive_match_snapshot->>'contact_phone') then
        raise exception 'A held sales match snapshot is invalid.'
          using errcode='23514';
      end if;
    else
      raise exception 'Unknown grouped source kind.' using errcode='23514';
    end if;
    if v_source_key is distinct from v_key then
      raise exception 'A grouped arrival has a different contact identity.'
        using errcode='23514';
    end if;
    select id into v_request_id from public.approval_requests_v6
      where source_system='aa_console'
        and source_kind=case v_source->>'kind'
          when 'form' then 'archived_form_return' else 'archived_sales_return' end
        and source_id=v_source_id::text
        and source_version=v_source->>'source_hash'
        and client_id=a.client_id;
    if v_request_id is null or
       public.archived_return_inbox_source_state_v11(v_request_id)<>'pending' then
      raise exception 'A grouped source has no current canonical review.'
        using errcode='23514';
    end if;
    if p_action='new_lead' and v_source->>'kind'=p_primary_kind
       and v_source_id=p_primary_id then v_primary_found:=true; end if;
    v_items:=v_items||jsonb_build_array(jsonb_build_object(
      'kind',v_source->>'kind','id',v_source_id,
      'source_hash',v_source->>'source_hash','request_id',v_request_id));
  end loop;
  if p_action='new_lead' and not v_primary_found then
    raise exception 'The chosen primary source is not in this exact batch.'
      using errcode='23514';
  end if;

  if p_action='recover' then
    v_lead:=a.id;
  elsif p_primary_kind='form' then
    select * into s from public.lead_submissions where id=p_primary_id;
    v_source_json:=s.consent_evidence->'source_snapshot';
    insert into public.client_leads(
      client_id,name,email,phone,contact,notes,source,source_channel,
      consent_given_at,consent_wording,consent_evidence,
      source_client_campaign_id,source_page_id,source_click_id,source_utm,
      created_by)
    values(a.client_id,s.name,s.email,s.phone,coalesce(s.email,s.phone),
      s.message,v_source_json->>'purpose',
      coalesce(v_source_json->>'source_channel',v_source_json->>'purpose'),
      s.consent_given_at,s.consent_wording,s.consent_evidence,
      nullif(v_source_json->>'campaign_id','')::uuid,
      nullif(v_source_json->>'page_id','')::uuid,s.click_id,s.utm,auth.uid())
    returning id into v_lead;
  else
    select * into c from public.sales_agent_conversations where id=p_primary_id;
    v_stage:=case when (c.archive_match_snapshot->>'qualified')::boolean
      then 'qualified_conversation'::public.lead_stage
      else 'conversation'::public.lead_stage end;
    insert into public.client_leads(
      client_id,name,email,phone,contact,source,source_channel,
      source_page_id,source_sales_agent_id,stage,stage_at,notes,created_by)
    values(a.client_id,c.archive_match_snapshot->>'contact_name',
      c.archive_match_snapshot->>'contact_email',
      c.archive_match_snapshot->>'contact_phone',
      coalesce(c.archive_match_snapshot->>'contact_email',
        c.archive_match_snapshot->>'contact_phone'),
      'sales_agent','sales_agent',
      nullif(c.archive_match_snapshot->>'page_id','')::uuid,
      nullif(c.archive_match_snapshot->>'sales_agent_id','')::uuid,
      v_stage,now(),c.archive_match_snapshot->>'outcome',auth.uid())
    returning id into v_lead;
  end if;

  insert into public.archived_return_batch_resolutions_v11(
    client_id,archived_lead_id,resolved_lead_id,action,reason,
    source_hash,source_count,reviewer_id,reviewer_aal)
  values(a.client_id,a.id,v_lead,p_action,btrim(p_reason),
    p_expected_hash,jsonb_array_length(v_items),auth.uid(),'aal2')
  returning id into v_batch_id;
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_source_id:=(v_item->>'id')::uuid;
    v_request_id:=(v_item->>'request_id')::uuid;
    if v_item->>'kind'='form' then
      insert into public.lead_return_resolutions_v11(
        client_id,submission_id,archived_lead_id,resolved_lead_id,
        action,reason,source_hash,reviewer_id,reviewer_aal,
        batch_resolution_id)
      values(a.client_id,v_source_id,a.id,v_lead,p_action,btrim(p_reason),
        v_item->>'source_hash',auth.uid(),'aal2',v_batch_id)
      returning id into v_resolution_id;
    else
      insert into public.sales_agent_return_resolutions_v11(
        client_id,conversation_id,archived_lead_id,resolved_lead_id,
        action,reason,source_hash,reviewer_id,reviewer_aal,
        batch_resolution_id)
      values(a.client_id,v_source_id,a.id,v_lead,p_action,btrim(p_reason),
        v_item->>'source_hash',auth.uid(),'aal2',v_batch_id)
      returning id into v_resolution_id;
    end if;
  end loop;
  if p_action='recover' then perform public.recover_lead(a.id); end if;
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_source_id:=(v_item->>'id')::uuid;
    v_request_id:=(v_item->>'request_id')::uuid;
    if v_item->>'kind'='form' then
      update public.lead_submissions set status='promoted',lead_id=v_lead
        where id=v_source_id;
      select id into v_resolution_id from public.lead_return_resolutions_v11
        where submission_id=v_source_id;
      insert into public.lead_events(lead_id,client_id,kind,body,created_by)
      values(v_lead,a.client_id,'note',
        'Grouped returning submission '||v_source_id::text||' reviewed in batch '
        ||v_batch_id::text||'.',auth.uid());
      perform public.record_approval_decision_v6(v_request_id,'approved',
        v_item->>'source_hash',
        'lead_return_resolutions_v11:'||v_resolution_id::text,btrim(p_reason));
    else
      update public.sales_agent_conversations set lead_id=v_lead
        where id=v_source_id;
      select id into v_resolution_id from public.sales_agent_return_resolutions_v11
        where conversation_id=v_source_id;
      insert into public.lead_events(lead_id,client_id,kind,body,created_by)
      values(v_lead,a.client_id,'note',
        'Grouped returning sales conversation '||v_source_id::text
        ||' reviewed in batch '||v_batch_id::text||'.',auth.uid());
      perform public.record_approval_decision_v6(v_request_id,'approved',
        v_item->>'source_hash',
        'sales_agent_return_resolutions_v11:'||v_resolution_id::text,
        btrim(p_reason));
    end if;
  end loop;
  return v_lead;
end $$;
revoke all on function public.resolve_archived_return_batch_v11(
  uuid,text,text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.resolve_archived_return_batch_v11(
  uuid,text,text,text,text,uuid) to authenticated;
select public.lock_down_definer_functions();
commit;
