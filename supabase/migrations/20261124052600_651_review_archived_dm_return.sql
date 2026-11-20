-- Bind an archived DM's exact retained messages to one canonical AAL2
-- identity decision. A decision never authorizes a reply or reopens the DM.
begin;

create function public.archived_dm_return_source_v11(p_conversation_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare c public.dm_conversations%rowtype;
  i public.dm_identities%rowtype; a public.archived_leads%rowtype;
  v_messages jsonb; v_hash text;
begin
  select * into c from public.dm_conversations where id=p_conversation_id;
  if c.id is null or c.status<>'closed'
     or c.closed_reason<>'archived_lead_return_review'
     or exists(select 1 from public.archived_dm_return_resolutions_v11 r
       where r.conversation_id=c.id) then return null; end if;
  select * into i from public.dm_identities
    where id=c.identity_id and client_id=c.client_id;
  if i.id is null or i.lead_id is null then return null; end if;
  select * into a from public.archived_leads
    where id=i.lead_id and client_id=c.client_id;
  if a.id is null then return null; end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.occurred_at,m.id),'[]'::jsonb)
    into v_messages from public.dm_messages m
    where m.conversation_id=c.id and m.client_id=c.client_id;
  v_hash:=encode(sha256(convert_to(jsonb_build_object(
    'archive',to_jsonb(a),'conversation',to_jsonb(c),
    'identity',to_jsonb(i),'messages',v_messages)::text,'UTF8')),'hex');
  return jsonb_build_object(
    'source_hash',v_hash,'client_id',c.client_id,
    'conversation_id',c.id,'identity_id',i.id,
    'archived_lead_id',a.id,'archived_name',a.name,
    'archived_at',a.archived_at,'archived_source',a.lead->>'source',
    'platform',c.platform,'scoped_sender_id',i.external_user_id,
    'display_name',i.display_name,'last_inbound_at',c.last_inbound_at,
    'window_expires_at',c.window_expires_at,
    'unread_inbound',c.unread_inbound,'messages',v_messages,
    'reply_state','closed; identity review does not authorize a message');
end $$;
revoke all on function public.archived_dm_return_source_v11(uuid)
  from public,anon,authenticated,service_role;

create or replace function public.archived_dm_return_review_packet_v11(
  p_conversation_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare c public.dm_conversations%rowtype; p jsonb;
begin
  if auth.role()<>'authenticated' or auth.uid() is null then
    raise exception 'A signed-in lead reviewer is required.' using errcode='42501';
  end if;
  select * into c from public.dm_conversations where id=p_conversation_id;
  if c.id is null or not public.may_manage_client_leads(c.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  p:=public.archived_dm_return_source_v11(c.id);
  if p is null then
    raise exception 'This DM is not waiting for archived-contact review.'
      using errcode='23514';
  end if;
  return p;
end $$;

create function public.archived_dm_return_inbox_packet_v11(p_conversation_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare p jsonb;
begin
  p:=public.archived_dm_return_source_v11(p_conversation_id);
  if p is null then return null; end if;
  -- The canonical preview omits message bodies and scoped sender ID. The
  -- source hash still binds both; the owning Sales OS view shows exact text.
  return jsonb_build_object(
    'client_id',p->>'client_id','source_id',p_conversation_id,
    'archived_lead_id',p->>'archived_lead_id',
    'source_hash',p->>'source_hash',
    'captured_at',p->>'last_inbound_at',
    'platform',p->>'platform','display_name',p->>'display_name',
    'archived_name',p->>'archived_name',
    'unread_inbound',p->'unread_inbound',
    'decision','Review the exact retained DM and archived identity in Sales OS. Choose recovery or a separate lead; no reply is authorized.');
end $$;
revoke all on function public.archived_dm_return_inbox_packet_v11(uuid)
  from public,anon,authenticated,service_role;

create function public.archived_dm_return_inbox_source_state_v11(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype;
  p jsonb; v_source_id uuid; v_resolved_hash text;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if r.id is null or r.source_system<>'aa_console'
     or r.source_kind<>'archived_dm_return'
     or r.owner_role<>'client_lead_reviewer'
     or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or r.client_id is null then return 'unverified'; end if;
  if auth.role()<>'service_role'
     and (auth.role()<>'authenticated'
       or not public.can_review_approval_request_v6(r.client_id,r.owner_role)) then
    return 'unverified';
  end if;
  v_source_id:=r.source_id::uuid;
  select source_hash into v_resolved_hash
    from public.archived_dm_return_resolutions_v11
    where conversation_id=v_source_id and client_id=r.client_id;
  if v_resolved_hash is not null then
    return case when v_resolved_hash=r.artifact_hash
      and v_resolved_hash=r.source_version then 'source_decided'
      else 'superseded' end;
  end if;
  p:=public.archived_dm_return_inbox_packet_v11(v_source_id);
  if p is null then return 'cancelled'; end if;
  if r.client_id is distinct from (p->>'client_id')::uuid
     or r.source_version is distinct from p->>'source_hash'
     or r.artifact_hash is distinct from p->>'source_hash'
     or r.preview is distinct from p
     or r.destination is distinct from 'internal:lead_identity'
     or r.scope is distinct from jsonb_build_object(
       'client_id',p->>'client_id','source_id',v_source_id,
       'archived_lead_id',p->>'archived_lead_id',
       'effect','lead_identity_resolution','source_hash',p->>'source_hash')
     or r.owning_path is distinct from
       ('/clients/'||(p->>'client_id')||'/delivery/sales-os?tab=agents')
     then return 'superseded'; end if;
  return 'pending';
end $$;
revoke all on function public.archived_dm_return_inbox_source_state_v11(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.archived_dm_return_inbox_source_state_v11(uuid)
  to authenticated,service_role;

create function public.register_archived_dm_return_inbox_v11(p_conversation_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p jsonb; v_hash text; v_request_id uuid;
begin
  p:=public.archived_dm_return_inbox_packet_v11(p_conversation_id);
  if p is null then return null; end if;
  v_hash:=p->>'source_hash';
  select id into v_request_id from public.approval_requests_v6
    where source_system='aa_console' and source_kind='archived_dm_return'
      and source_id=p_conversation_id::text and source_version=v_hash;
  if v_request_id is not null then return v_request_id; end if;
  return public.register_approval_request_v6(jsonb_build_object(
    'client_id',p->>'client_id','source_system','aa_console',
    'source_kind','archived_dm_return','source_id',p_conversation_id,
    'source_version',v_hash,'title','Review returning DM contact',
    'artifact_hash',v_hash,'preview',p,
    'destination','internal:lead_identity','scope',jsonb_build_object(
      'client_id',p->>'client_id','source_id',p_conversation_id,
      'archived_lead_id',p->>'archived_lead_id',
      'effect','lead_identity_resolution','source_hash',v_hash),
    'owner_role','client_lead_reviewer',
    'expires_at',clock_timestamp()+interval '180 days',
    'owning_path','/clients/'||(p->>'client_id')||'/delivery/sales-os?tab=agents',
    'requester_kind','service',
    'requester_ref','dm_conversations:'||p_conversation_id::text));
end $$;
revoke all on function public.register_archived_dm_return_inbox_v11(uuid)
  from public,anon,authenticated,service_role;

create function public.register_archived_dm_return_trigger_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
  if tg_table_name='dm_conversations' then
    perform public.register_archived_dm_return_inbox_v11(new.id);
  elsif tg_table_name='dm_messages' then
    perform public.register_archived_dm_return_inbox_v11(new.conversation_id);
  elsif tg_table_name='dm_identities' then
    select id into v_id from public.dm_conversations
      where identity_id=new.id and client_id=new.client_id;
    if v_id is not null then
      perform public.register_archived_dm_return_inbox_v11(v_id);
    end if;
  elsif tg_table_name='archived_leads' then
    for v_id in select c.id from public.dm_conversations c
      join public.dm_identities i on i.id=c.identity_id
        and i.client_id=c.client_id
      where i.lead_id=new.id and c.client_id=new.client_id loop
      perform public.register_archived_dm_return_inbox_v11(v_id);
    end loop;
  end if;
  return null;
end $$;
revoke all on function public.register_archived_dm_return_trigger_v11()
  from public,anon,authenticated,service_role;
create trigger archived_dm_conversation_inbox_v11
  after insert or update on public.dm_conversations
  for each row execute function public.register_archived_dm_return_trigger_v11();
create trigger archived_dm_message_inbox_v11
  after insert or update on public.dm_messages
  for each row execute function public.register_archived_dm_return_trigger_v11();
create trigger archived_dm_identity_inbox_v11
  after update on public.dm_identities
  for each row execute function public.register_archived_dm_return_trigger_v11();
create trigger archived_dm_archive_inbox_v11
  after update on public.archived_leads
  for each row execute function public.register_archived_dm_return_trigger_v11();

do $$ declare v_id uuid; begin
  for v_id in select c.id from public.dm_conversations c
    join public.dm_identities i on i.id=c.identity_id
      and i.client_id=c.client_id
    join public.archived_leads a on a.id=i.lead_id
      and a.client_id=c.client_id
    where c.status='closed' and c.closed_reason='archived_lead_return_review' loop
    perform public.register_archived_dm_return_inbox_v11(v_id);
  end loop;
end $$;

-- Preserve every other Inbox branch. The released view has exactly one
-- archived-return branch; fail if that normalized definition changes.
do $$ declare v_view text; v_old text; v_new text;
begin
  v_view:=pg_get_viewdef('public.approval_inbox_v6'::regclass,true);
  v_old:='WHEN r.source_system = ''aa_console''::text AND '
    ||'(r.source_kind = ANY (ARRAY[''archived_form_return''::text, '
    ||'''archived_sales_return''::text])) '
    ||'THEN archived_return_inbox_source_state_v11(r.id)';
  if (length(v_view)-length(replace(v_view,v_old,'')))/length(v_old)<>1 then
    raise exception 'The canonical Inbox archived-return branch changed; review its definition.'
      using errcode='23514';
  end if;
  v_new:=v_old||E'\n                    '
    ||'WHEN r.source_system = ''aa_console''::text '
    ||'AND r.source_kind = ''archived_dm_return''::text '
    ||'THEN archived_dm_return_inbox_source_state_v11(r.id)';
  execute 'create or replace view public.approval_inbox_v6 '
    ||'with (security_invoker=true) as '
    ||replace(v_view,v_old,v_new);
end $$;

create function public.resolve_archived_dm_return_v11(
  p_conversation_id uuid,p_action text,p_expected_hash text,p_reason text)
returns uuid language plpgsql security definer
set search_path=pg_catalog,public as $$
declare c public.dm_conversations%rowtype;
  i public.dm_identities%rowtype; a public.archived_leads%rowtype;
  p jsonb; v_lead uuid; v_request_id uuid; v_resolution_id uuid;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
     or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A signed-in AAL2 lead reviewer is required.'
      using errcode='42501';
  end if;
  if p_action not in ('recover','new_lead')
     or length(btrim(coalesce(p_reason,''))) not between 8 and 2000
     or p_expected_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Choose an exact outcome and give a review reason.'
      using errcode='23514';
  end if;
  select * into c from public.dm_conversations where id=p_conversation_id;
  if c.id is null or not public.may_manage_client_leads(c.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  select * into i from public.dm_identities
    where id=c.identity_id and client_id=c.client_id;
  if i.id is null or i.lead_id is null then
    raise exception 'The DM identity changed; review again.' using errcode='23514';
  end if;
  -- Direct Archive recovery locks this row first. Inbound DM recording locks
  -- the identity before the conversation, so this order avoids a lock cycle.
  select * into a from public.archived_leads
    where id=i.lead_id and client_id=c.client_id for update;
  if a.id is null then
    raise exception 'The archived contact changed; review again.'
      using errcode='23514';
  end if;
  select * into i from public.dm_identities
    where id=c.identity_id and client_id=c.client_id for update;
  select * into c from public.dm_conversations
    where id=p_conversation_id and client_id=a.client_id for update;
  if i.lead_id is distinct from a.id or c.identity_id is distinct from i.id
     or c.status<>'closed' or c.closed_reason<>'archived_lead_return_review'
     or exists(select 1 from public.archived_dm_return_resolutions_v11
       where conversation_id=c.id)
     or exists(select 1 from public.lead_submissions s
       where s.client_id=a.client_id and s.archive_match_lead_id=a.id
         and s.status='received' and s.lead_id is null)
     or exists(select 1 from public.sales_agent_conversations s
       where s.client_id=a.client_id and s.archive_match_lead_id=a.id
         and s.lead_id is null and s.archive_match_snapshot is not null)
     or (select count(*) from public.dm_conversations x
       join public.dm_identities xi on xi.id=x.identity_id
         and xi.client_id=x.client_id
       where xi.lead_id=a.id and x.client_id=a.client_id
         and x.status='closed'
         and x.closed_reason='archived_lead_return_review')<>1 then
    raise exception 'Related arrivals need one coordinated identity review.'
      using errcode='23514';
  end if;
  p:=public.archived_dm_return_source_v11(c.id);
  if p is null or p->>'source_hash' is distinct from p_expected_hash then
    raise exception 'The reviewed DM or archive snapshot changed.'
      using errcode='23514';
  end if;
  select id into v_request_id from public.approval_requests_v6
    where source_system='aa_console' and source_kind='archived_dm_return'
      and source_id=c.id::text and source_version=p_expected_hash
      and client_id=a.client_id;
  if v_request_id is null
     or public.archived_dm_return_inbox_source_state_v11(v_request_id)<>'pending' then
    raise exception 'The canonical DM review changed or is missing.'
      using errcode='23514';
  end if;
  if p_action='recover' then
    v_lead:=a.id;
  else
    insert into public.client_leads(
      client_id,name,stage,stage_at,source,source_channel,created_by)
    values(a.client_id,coalesce(nullif(btrim(i.display_name),''),
      'A '||c.platform||' conversation'),'conversation',now(),
      'direct_message',c.platform,auth.uid())
    returning id into v_lead;
  end if;
  insert into public.archived_dm_return_resolutions_v11(
    client_id,conversation_id,identity_id,archived_lead_id,
    resolved_lead_id,action,reason,source_hash,reviewer_id,reviewer_aal)
  values(a.client_id,c.id,i.id,a.id,v_lead,p_action,btrim(p_reason),
    p_expected_hash,auth.uid(),'aal2') returning id into v_resolution_id;
  if p_action='recover' then perform public.recover_lead(a.id); end if;
  update public.dm_identities set lead_id=v_lead where id=i.id;
  update public.dm_conversations set lead_id=v_lead,status='closed',
    closed_reason='reviewed_return' where id=c.id;
  insert into public.lead_events(lead_id,client_id,kind,body,created_by)
  values(v_lead,a.client_id,'note',
    'Reviewed archived DM '||c.id::text||
    case p_action when 'recover' then ' reopened the archived lead.'
      else ' started a separate lead.' end,auth.uid());
  perform public.record_approval_decision_v6(v_request_id,'approved',
    p_expected_hash,'archived_dm_return_resolutions_v11:'||v_resolution_id::text,
    btrim(p_reason));
  return v_lead;
end $$;
revoke all on function public.resolve_archived_dm_return_v11(uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.resolve_archived_dm_return_v11(uuid,text,text,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;
