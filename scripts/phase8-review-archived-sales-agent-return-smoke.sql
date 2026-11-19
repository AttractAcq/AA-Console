-- Exact AAL2 identity decision from a frozen sales-agent archived-contact hold.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a6450000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'sales-return-review@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('a6450000-0000-4000-8000-000000000001','admin',
  'sales-return-review@example.invalid');
insert into public.clients(id,name,initials)
values ('b6450000-0000-4000-8000-000000000001','Sales return review fixture','SR');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $fixture$
<<fixture>>
declare cid uuid:='b6450000-0000-4000-8000-000000000001';
  agent_id uuid; archived_id uuid; conversation_id uuid;
  second_archived uuid; second_conversation uuid; second_lead uuid; resolved_id uuid;
  packet jsonb; refreshed jsonb; second_packet jsonb;
  refused boolean:=false;
begin
  insert into public.client_sales_agents(client_id,name,purpose)
    values(cid,'Review fixture agent','Capture returning contacts')
    returning id into agent_id;
  insert into public.client_leads(client_id,name,email,source,source_channel,stage)
    values(cid,'Archived original','review-one@example.invalid',
      'sales_agent','sales_agent','conversation') returning id into archived_id;
  perform public.archive_lead(archived_id,'Finished original');
  insert into public.sales_agent_conversations(client_id,sales_agent_id,
    contact_name,contact_email,qualified,outcome,transcript)
    values(cid,agent_id,'Returned first','review-one@example.invalid',true,
      'Asked about a new service','[]'::jsonb) returning id into conversation_id;
  if public.capture_sales_agent_lead(conversation_id) is not null then
    raise exception 'Archived sales contact was automatically promoted';
  end if;
  begin perform public.recover_lead(archived_id);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Direct Archive recovery bypassed sales review'; end if;

  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6450000-0000-4000-8000-000000000099',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6450000-0000-4000-8000-000000000099","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin perform public.sales_agent_return_review_packet_v11(conversation_id);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unprovisioned reviewer read the packet'; end if;
  perform set_config('request.jwt.claim.sub',
    'a6450000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6450000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
  packet:=public.sales_agent_return_review_packet_v11(conversation_id);
  if packet->'matched'->>'contact_name'<>'Returned first'
     or packet->>'archived_email'<>'review-one@example.invalid' then
    raise exception 'Sales return packet omitted the compared identities';
  end if;
  refused:=false;
  begin perform public.resolve_sales_agent_return_v11(conversation_id,'recover',
    packet->>'source_hash','Reviewed exact identity');
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'AAL1 resolved the sales return'; end if;
  perform set_config('request.jwt.claims',
    '{"sub":"a6450000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  update public.sales_agent_conversations set contact_name='Later agent turn'
    where id=conversation_id;
  refused:=false;
  begin perform public.resolve_sales_agent_return_v11(conversation_id,'recover',
    packet->>'source_hash','Reviewed exact identity');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Stale sales review packet was accepted'; end if;
  refreshed:=public.sales_agent_return_review_packet_v11(conversation_id);
  if refreshed->'matched'->>'contact_name'<>'Returned first'
     or refreshed->>'current_name'<>'Later agent turn' then
    raise exception 'The frozen match was replaced by current conversation'; end if;
  resolved_id:=public.resolve_sales_agent_return_v11(conversation_id,'recover',
    refreshed->>'source_hash','Reviewed exact identity');
  if resolved_id is distinct from archived_id
     or not exists(select 1 from public.client_leads where id=archived_id)
     or exists(select 1 from public.archived_leads where id=archived_id)
     or not exists(select 1 from public.sales_agent_return_resolutions_v11 r
       where r.conversation_id=fixture.conversation_id and action='recover'
         and reviewer_aal='aal2' and source_hash=refreshed->>'source_hash') then
    raise exception 'AAL2 sales recovery lost the identity or audit: resolved %, active %, archived %, decision %',
      resolved_id is not distinct from archived_id,
      exists(select 1 from public.client_leads where id=archived_id),
      exists(select 1 from public.archived_leads where id=archived_id),
      exists(select 1 from public.sales_agent_return_resolutions_v11 r
        where r.conversation_id=fixture.conversation_id and r.action='recover'
          and r.reviewer_aal='aal2' and r.source_hash=refreshed->>'source_hash');
  end if;
  refused:=false;
  begin perform public.resolve_sales_agent_return_v11(conversation_id,'recover',
    refreshed->>'source_hash','Reviewed exact identity');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Repeated sales return decision was accepted'; end if;

  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.client_leads(client_id,name,email,source,source_channel,stage)
    values(cid,'Second archived original','review-two@example.invalid',
      'sales_agent','sales_agent','conversation') returning id into second_archived;
  perform public.archive_lead(second_archived,'Finished second original');
  insert into public.sales_agent_conversations(client_id,sales_agent_id,
    contact_name,contact_email,qualified,outcome,transcript)
    values(cid,agent_id,'Second return','review-two@example.invalid',false,
      'Asked about an offer','[]'::jsonb) returning id into second_conversation;
  if public.capture_sales_agent_lead(second_conversation) is not null then
    raise exception 'Second archived contact was automatically promoted'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',
    'a6450000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a6450000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
  second_packet:=public.sales_agent_return_review_packet_v11(second_conversation);
  second_lead:=public.resolve_sales_agent_return_v11(second_conversation,
    'new_lead',second_packet->>'source_hash','Separate identity after review');
  if second_lead is null or second_lead=second_archived
    or not exists(select 1 from public.archived_leads where id=second_archived)
    or not exists(select 1 from public.client_leads
      where id=second_lead and source='sales_agent'
        and name='Second return' and email='review-two@example.invalid')
    or not exists(select 1 from public.sales_agent_conversations
      where id=second_conversation and lead_id=second_lead)
    or not exists(select 1 from public.sales_agent_return_resolutions_v11 r
      where r.conversation_id=second_conversation and action='new_lead'
        and resolved_lead_id=second_lead and reviewer_aal='aal2') then
    raise exception 'AAL2 separate-lead decision lost lineage';
  end if;
end $fixture$;
do $privileges$
begin
  if has_table_privilege('service_role',
       'public.sales_agent_return_resolutions_v11','INSERT')
     or has_function_privilege('service_role',
       'public.resolve_sales_agent_return_v11(uuid,text,text,text)','EXECUTE')
     or has_function_privilege('anon',
       'public.sales_agent_return_review_packet_v11(uuid)','EXECUTE') then
    raise exception 'Archived sales return review grants are too broad';
  end if;
end $privileges$;
rollback;
