-- Mirror exact archived-contact return reviews into the canonical Inbox.
-- Sales OS remains the only decision authority; its AAL2 transition records
-- the canonical event in the same transaction. No external effect is released.
begin;

create or replace function public.can_review_approval_request_v6(
  p_client_id uuid,p_owner_role text)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select coalesce(public.is_admin(),false) or coalesce((
    p_client_id is not null and case
      when p_owner_role='admin_or_active_client_manager' then
        auth.uid()=public.active_video_approval_manager(p_client_id)
      when p_owner_role='client_media_reviewer' then public.can_access_client(p_client_id)
      when p_owner_role='client_lead_reviewer' then public.may_manage_client_leads(p_client_id)
      when p_owner_role ~* '^video_(owner|manager|client):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then auth.uid()=split_part(p_owner_role,':',2)::uuid
      else false end),false);
$$;

create function public.archived_return_inbox_packet_v11(p_kind text,p_source_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare s public.lead_submissions%rowtype;
  c public.sales_agent_conversations%rowtype;
  a public.archived_leads%rowtype;
  v_hash text;
begin
  if p_kind='archived_form_return' then
    select * into s from public.lead_submissions where id=p_source_id;
    if s.id is null or s.status<>'received' or s.lead_id is not null
       or s.archive_match_lead_id is null then return null; end if;
    select * into a from public.archived_leads
      where id=s.archive_match_lead_id and client_id=s.client_id;
    if a.id is null then return null; end if;
    v_hash:=encode(sha256(convert_to(jsonb_build_object(
      'submission',to_jsonb(s),'archive',to_jsonb(a))::text,'UTF8')),'hex');
    return jsonb_build_object(
      'client_id',s.client_id,'source_id',s.id,'archived_lead_id',a.id,
      'source_hash',v_hash,'captured_at',s.created_at,
      'submitted_name',s.name,'archived_name',a.name,
      'consent_present',s.consent_given_at is not null
        and nullif(btrim(s.consent_wording),'') is not null,
      'route_package_id',s.route_package_id,
      'decision','Review the exact form and archived identity in Sales OS; choose recovery or a separate lead.');
  elsif p_kind='archived_sales_return' then
    select * into c from public.sales_agent_conversations where id=p_source_id;
    if c.id is null or c.lead_id is not null or c.archive_match_lead_id is null
       or c.archive_match_snapshot is null then return null; end if;
    select * into a from public.archived_leads
      where id=c.archive_match_lead_id and client_id=c.client_id;
    if a.id is null then return null; end if;
    v_hash:=encode(sha256(convert_to(jsonb_build_object(
      'conversation',to_jsonb(c),'archive',to_jsonb(a))::text,'UTF8')),'hex');
    return jsonb_build_object(
      'client_id',c.client_id,'source_id',c.id,'archived_lead_id',a.id,
      'source_hash',v_hash,'captured_at',c.started_at,
      'matched_contact_name',c.archive_match_snapshot->>'contact_name',
      'archived_name',a.name,
      'decision','Review the exact sales conversation and archived identity in Sales OS; choose recovery or a separate lead.');
  end if;
  return null;
end $$;

create function public.refresh_archived_return_inbox_v11()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
  for v_id in select id from public.lead_submissions
    where archive_match_lead_id=new.id and client_id=new.client_id
      and status='received' and lead_id is null loop
    perform public.register_archived_return_inbox_v11('archived_form_return',v_id);
  end loop;
  for v_id in select id from public.sales_agent_conversations
    where archive_match_lead_id=new.id and client_id=new.client_id
      and lead_id is null and archive_match_snapshot is not null loop
    perform public.register_archived_return_inbox_v11('archived_sales_return',v_id);
  end loop;
  return null;
end $$;
revoke all on function public.refresh_archived_return_inbox_v11()
  from public,anon,authenticated,service_role;
create trigger archived_identity_return_inbox_v11
  after update on public.archived_leads
  for each row execute function public.refresh_archived_return_inbox_v11();

create function public.archived_return_inbox_source_state_v11(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; p jsonb;
  v_source_id uuid; v_resolved_hash text;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if r.id is null or r.source_system<>'aa_console'
     or r.source_kind not in ('archived_form_return','archived_sales_return')
     or r.owner_role<>'client_lead_reviewer'
     or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or r.client_id is null then return 'unverified'; end if;
  if auth.role()<>'service_role'
     and (auth.role()<>'authenticated'
       or not public.can_review_approval_request_v6(r.client_id,r.owner_role)) then
    return 'unverified';
  end if;
  v_source_id:=r.source_id::uuid;
  if r.source_kind='archived_form_return' then
    select source_hash into v_resolved_hash from public.lead_return_resolutions_v11
      where submission_id=v_source_id and client_id=r.client_id;
  else
    select source_hash into v_resolved_hash from public.sales_agent_return_resolutions_v11
      where conversation_id=v_source_id and client_id=r.client_id;
  end if;
  if v_resolved_hash is not null then
    return case when v_resolved_hash=r.artifact_hash
      and v_resolved_hash=r.source_version then 'source_decided' else 'superseded' end;
  end if;
  p:=public.archived_return_inbox_packet_v11(r.source_kind,v_source_id);
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
       ('/clients/'||(p->>'client_id')||'/delivery/sales-os?tab='||
         (case r.source_kind when 'archived_form_return' then 'capture' else 'agents' end))
     then return 'superseded'; end if;
  return 'pending';
end $$;
revoke all on function public.archived_return_inbox_source_state_v11(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.archived_return_inbox_source_state_v11(uuid)
  to authenticated,service_role;
revoke all on function public.archived_return_inbox_packet_v11(text,uuid)
  from public,anon,authenticated,service_role;

create function public.register_archived_return_inbox_v11(p_kind text,p_source_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p jsonb; v_hash text; v_request_id uuid;
begin
  p:=public.archived_return_inbox_packet_v11(p_kind,p_source_id);
  if p is null then return null; end if;
  v_hash:=p->>'source_hash';
  select id into v_request_id from public.approval_requests_v6
    where source_system='aa_console' and source_kind=p_kind
      and source_id=p_source_id::text and source_version=v_hash;
  if v_request_id is not null then return v_request_id; end if;
  return public.register_approval_request_v6(jsonb_build_object(
    'client_id',p->>'client_id','source_system','aa_console',
    'source_kind',p_kind,'source_id',p_source_id,'source_version',v_hash,
    'title',case p_kind when 'archived_form_return'
      then 'Review returning form contact' else 'Review returning sales-agent contact' end,
    'artifact_hash',v_hash,'preview',p,
    'destination','internal:lead_identity','scope',jsonb_build_object(
      'client_id',p->>'client_id','source_id',p_source_id,
      'archived_lead_id',p->>'archived_lead_id',
      'effect','lead_identity_resolution','source_hash',v_hash),
    'owner_role','client_lead_reviewer',
    'expires_at',clock_timestamp()+interval '180 days',
    'owning_path','/clients/'||(p->>'client_id')||'/delivery/sales-os?tab='||
      case p_kind when 'archived_form_return' then 'capture' else 'agents' end,
    'requester_kind','service',
    'requester_ref',case p_kind when 'archived_form_return'
      then 'lead_submissions:' else 'sales_agent_conversations:' end||p_source_id::text));
end $$;
revoke all on function public.register_archived_return_inbox_v11(text,uuid)
  from public,anon,authenticated,service_role;

create function public.register_archived_return_trigger_v11()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_table_name='lead_submissions' then
    if new.status='received' and new.lead_id is null
       and new.archive_match_lead_id is not null then
      perform public.register_archived_return_inbox_v11('archived_form_return',new.id);
    end if;
  elsif tg_table_name='sales_agent_conversations' then
    if new.lead_id is null and new.archive_match_lead_id is not null
       and new.archive_match_snapshot is not null then
      perform public.register_archived_return_inbox_v11('archived_sales_return',new.id);
    end if;
  end if;
  return null;
end $$;
revoke all on function public.register_archived_return_trigger_v11()
  from public,anon,authenticated,service_role;
create trigger archived_form_return_inbox_v11
  after insert or update on public.lead_submissions
  for each row execute function public.register_archived_return_trigger_v11();
create trigger archived_sales_return_inbox_v11
  after insert or update on public.sales_agent_conversations
  for each row execute function public.register_archived_return_trigger_v11();

do $$ declare v_id uuid; begin
  for v_id in select id from public.lead_submissions
    where status='received' and lead_id is null and archive_match_lead_id is not null loop
    perform public.register_archived_return_inbox_v11('archived_form_return',v_id);
  end loop;
  for v_id in select id from public.sales_agent_conversations
    where lead_id is null and archive_match_lead_id is not null
      and archive_match_snapshot is not null loop
    perform public.register_archived_return_inbox_v11('archived_sales_return',v_id);
  end loop;
end $$;

-- Source-owned transitions and canonical decision records are atomic.
create or replace function public.resolve_archived_return_v11(
  p_submission_id uuid,p_action text,p_expected_hash text,p_reason text)
returns uuid language plpgsql security definer
set search_path=pg_catalog,public as $$
declare s public.lead_submissions%rowtype;
  a public.archived_leads%rowtype; v_packet jsonb;
  v_dedupe text; v_resolved uuid; v_source jsonb;
  v_request_id uuid; v_resolution_id uuid;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
     or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A signed-in AAL2 lead reviewer is required.'
      using errcode='42501';
  end if;
  if p_action not in ('recover','new_lead')
     or length(btrim(coalesce(p_reason,''))) not between 8 and 2000
     or p_expected_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Choose an exact action and give a review reason.'
      using errcode='23514';
  end if;
  select * into s from public.lead_submissions
    where id=p_submission_id for update;
  if s.id is null or not public.may_manage_client_leads(s.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  if s.status<>'received' or s.lead_id is not null
     or s.archive_match_lead_id is null
     or exists(select 1 from public.lead_return_resolutions_v11
       where submission_id=s.id) then
    raise exception 'This return has already been resolved or is not reviewable.'
      using errcode='23514';
  end if;
  v_dedupe:=public.lead_dedupe_key(s.email,s.phone);
  if v_dedupe is null then
    raise exception 'The submitted contact cannot be matched.'
      using errcode='23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    s.client_id::text || ':lead-contact:' || v_dedupe,0));
  select * into a from public.archived_leads
    where id=s.archive_match_lead_id and client_id=s.client_id for update;
  if a.id is null or coalesce(a.lead->>'dedupe_key',
       public.lead_dedupe_key(a.lead->>'email',a.lead->>'phone'))
       is distinct from v_dedupe
     or (select count(*) from public.archived_leads x
       where x.client_id=s.client_id and coalesce(x.lead->>'dedupe_key',
         public.lead_dedupe_key(x.lead->>'email',x.lead->>'phone'))=v_dedupe)<>1
     or exists(select 1 from public.client_leads l
       where l.client_id=s.client_id and l.dedupe_key=v_dedupe) then
    raise exception 'The contact match changed or is ambiguous; review again.'
      using errcode='23514';
  end if;
  v_packet:=public.archived_return_review_packet_v11(s.id);
  if v_packet->>'source_hash' is distinct from p_expected_hash then
    raise exception 'The reviewed submission or archive snapshot changed.'
      using errcode='23514';
  end if;
  select id into v_request_id from public.approval_requests_v6
    where source_system='aa_console' and source_kind='archived_form_return'
      and source_id=s.id::text and source_version=p_expected_hash
      and client_id=s.client_id;
  if v_request_id is null
     or public.archived_return_inbox_source_state_v11(v_request_id)<>'pending' then
    raise exception 'The canonical form return review changed or is missing.'
      using errcode='23514';
  end if;
  if s.consent_given_at is null or nullif(btrim(s.consent_wording),'') is null then
    raise exception 'Consent evidence is missing.' using errcode='23514';
  end if;
  if p_action='recover' then
    v_resolved:=a.id;
    insert into public.lead_return_resolutions_v11(
      client_id,submission_id,archived_lead_id,resolved_lead_id,
      action,reason,source_hash,reviewer_id,reviewer_aal)
    values(s.client_id,s.id,a.id,v_resolved,p_action,btrim(p_reason),
      p_expected_hash,auth.uid(),'aal2');
    perform public.recover_lead(a.id);
  else
    v_source:=s.consent_evidence->'source_snapshot';
    if v_source is null or jsonb_typeof(v_source)<>'object'
       or nullif(v_source->>'purpose','') is null then
      raise exception 'Captured source snapshot is missing; review manually.'
        using errcode='23514';
    end if;
    insert into public.client_leads(
      client_id,name,email,phone,contact,notes,source,source_channel,
      consent_given_at,consent_wording,consent_evidence,
      source_client_campaign_id,source_page_id,source_click_id,source_utm,
      created_by)
    values(s.client_id,s.name,s.email,s.phone,coalesce(s.email,s.phone),
      s.message,v_source->>'purpose',
      coalesce(v_source->>'source_channel',v_source->>'purpose'),
      s.consent_given_at,s.consent_wording,s.consent_evidence,
      nullif(v_source->>'campaign_id','')::uuid,
      nullif(v_source->>'page_id','')::uuid,s.click_id,s.utm,auth.uid())
    returning id into v_resolved;
    insert into public.lead_return_resolutions_v11(
      client_id,submission_id,archived_lead_id,resolved_lead_id,
      action,reason,source_hash,reviewer_id,reviewer_aal)
    values(s.client_id,s.id,a.id,v_resolved,p_action,btrim(p_reason),
      p_expected_hash,auth.uid(),'aal2');
  end if;
  update public.lead_submissions set status='promoted',lead_id=v_resolved
    where id=s.id;
  insert into public.lead_events(lead_id,client_id,kind,body,created_by)
  values(v_resolved,s.client_id,'note',
    'Reviewed returning submission '||s.id::text||
    case p_action when 'recover' then ' reopened the archived lead.'
      else ' started a separate lead.' end,auth.uid());
  select id into v_resolution_id from public.lead_return_resolutions_v11
    where submission_id=s.id and client_id=s.client_id;
  perform public.record_approval_decision_v6(v_request_id,'approved',p_expected_hash,
    'lead_return_resolutions_v11:'||v_resolution_id::text,btrim(p_reason));
  return v_resolved;
end $$;

create or replace function public.resolve_sales_agent_return_v11(
  p_conversation_id uuid,p_action text,p_expected_hash text,p_reason text)
returns uuid language plpgsql security definer
set search_path=pg_catalog,public as $$
declare c public.sales_agent_conversations%rowtype;
  a public.archived_leads%rowtype; v_packet jsonb;
  v_key text; v_lead uuid; v_snap jsonb; v_stage public.lead_stage;
  v_request_id uuid; v_resolution_id uuid;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
     or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A signed-in AAL2 lead reviewer is required.'
      using errcode='42501';
  end if;
  if p_action not in ('recover','new_lead')
     or length(btrim(coalesce(p_reason,''))) not between 8 and 2000
     or p_expected_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Choose an exact action and give a review reason.'
      using errcode='23514';
  end if;
  select * into c from public.sales_agent_conversations
    where id=p_conversation_id for update;
  if c.id is null or not public.may_manage_client_leads(c.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  if c.lead_id is not null or c.archive_match_lead_id is null
     or c.archive_match_snapshot is null
     or exists(select 1 from public.sales_agent_return_resolutions_v11
       where conversation_id=c.id) then
    raise exception 'This sales return was already resolved or is not reviewable.'
      using errcode='23514';
  end if;
  v_snap:=c.archive_match_snapshot;
  v_key:=v_snap->>'contact_key';
  if v_key is null or v_key is distinct from public.lead_dedupe_key(
      v_snap->>'contact_email',v_snap->>'contact_phone') then
    raise exception 'The matched contact snapshot is invalid.' using errcode='23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    c.client_id::text||':lead-contact:'||v_key,0));
  select * into a from public.archived_leads
    where id=c.archive_match_lead_id and client_id=c.client_id for update;
  if a.id is null
     or coalesce(a.lead->>'dedupe_key',
       public.lead_dedupe_key(a.lead->>'email',a.lead->>'phone'))
       is distinct from v_key
     or (select count(*) from public.archived_leads x
       where x.client_id=c.client_id and coalesce(x.lead->>'dedupe_key',
         public.lead_dedupe_key(x.lead->>'email',x.lead->>'phone'))=v_key)<>1
     or exists(select 1 from public.client_leads l
       where l.client_id=c.client_id and l.dedupe_key=v_key)
     or exists(select 1 from public.lead_submissions s
       where s.archive_match_lead_id=a.id and s.status='received')
     or (select count(*) from public.sales_agent_conversations x
       where x.archive_match_lead_id=a.id and x.lead_id is null)<>1 then
    raise exception 'The contact match is ambiguous or has another pending return; coordinate review.'
      using errcode='23514';
  end if;
  v_packet:=public.sales_agent_return_review_packet_v11(c.id);
  if v_packet->>'source_hash' is distinct from p_expected_hash then
    raise exception 'The reviewed conversation or archive snapshot changed.'
      using errcode='23514';
  end if;
  select id into v_request_id from public.approval_requests_v6
    where source_system='aa_console' and source_kind='archived_sales_return'
      and source_id=c.id::text and source_version=p_expected_hash
      and client_id=c.client_id;
  if v_request_id is null
     or public.archived_return_inbox_source_state_v11(v_request_id)<>'pending' then
    raise exception 'The canonical sales return review changed or is missing.'
      using errcode='23514';
  end if;
  if p_action='recover' then
    v_lead:=a.id;
    insert into public.sales_agent_return_resolutions_v11(
      client_id,conversation_id,archived_lead_id,resolved_lead_id,
      action,reason,source_hash,reviewer_id,reviewer_aal)
    values(c.client_id,c.id,a.id,v_lead,p_action,btrim(p_reason),
      p_expected_hash,auth.uid(),'aal2');
    perform public.recover_lead(a.id);
  else
    v_stage:=case when (v_snap->>'qualified')::boolean
      then 'qualified_conversation'::public.lead_stage
      else 'conversation'::public.lead_stage end;
    insert into public.client_leads(
      client_id,name,email,phone,contact,source,source_channel,
      source_page_id,source_sales_agent_id,stage,stage_at,notes,created_by)
    values(c.client_id,v_snap->>'contact_name',v_snap->>'contact_email',
      v_snap->>'contact_phone',coalesce(v_snap->>'contact_email',
        v_snap->>'contact_phone'),'sales_agent','sales_agent',
      nullif(v_snap->>'page_id','')::uuid,
      nullif(v_snap->>'sales_agent_id','')::uuid,
      v_stage,now(),v_snap->>'outcome',auth.uid())
    returning id into v_lead;
    insert into public.sales_agent_return_resolutions_v11(
      client_id,conversation_id,archived_lead_id,resolved_lead_id,
      action,reason,source_hash,reviewer_id,reviewer_aal)
    values(c.client_id,c.id,a.id,v_lead,p_action,btrim(p_reason),
      p_expected_hash,auth.uid(),'aal2');
  end if;
  update public.sales_agent_conversations set lead_id=v_lead where id=c.id;
  insert into public.lead_events(lead_id,client_id,kind,body,created_by)
  values(v_lead,c.client_id,'note',
    'Reviewed returning sales-agent conversation '||c.id::text||
    case p_action when 'recover' then ' reopened the archived lead.'
      else ' started a separate lead.' end,auth.uid());
  select id into v_resolution_id from public.sales_agent_return_resolutions_v11
    where conversation_id=c.id and client_id=c.client_id;
  perform public.record_approval_decision_v6(v_request_id,'approved',p_expected_hash,
    'sales_agent_return_resolutions_v11:'||v_resolution_id::text,btrim(p_reason));
  return v_lead;
end $$;

-- Extend the existing security-invoker Inbox projection.
create or replace view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when r.source_system = 'aa_console'
      and r.source_kind in ('service_offer','lead_magnet','sales_agent_public_use','opportunity_approve','proof_rights','proof_placement','proof_artifact','ordinary_media','proof_delivery','meta_profile_change','google_profile_change','opportunity_activate','message_template','nurture_sequence','video_seat','motion_render','campaign_idea','activation_switch','global_engine_activation','integration_grant','metrics_backfill','creative_requirement','global_video_owner','client_authority_assignment','gateway_tool')
      and d.decision in ('rejected','revoked') then d.decision
    when r.source_system = 'aa_console' and r.source_kind in ('proof_rights','message_template','nurture_sequence','video_seat','motion_render','campaign_idea','activation_switch','global_engine_activation','integration_grant','metrics_backfill','creative_requirement','global_video_owner','client_authority_assignment','gateway_tool')
      and s.source_state = 'revoked' then 'revoked'
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      and d.decision in ('rejected','revoked') then d.decision
    when inv.id is not null
      and coalesce(d.decision,'') not in ('rejected','revoked') then 'stale'
    when r.source_system = 'aa_console'
      and r.source_kind in ('production_release','recruitment_meta_build',
        'organic_publication')
      and s.source_state = 'source_held'
      and r.expires_at is not null and r.expires_at <= now() then 'expired'
    when s.source_state in ('cancelled','superseded','source_held','unverified')
      then s.source_state
    when d.decision = 'revoked' then 'revoked'
    when d.decision = 'rejected' then 'rejected'
    when r.source_system = 'aa_console'
      and r.source_kind in ('message_template','nurture_sequence','video_seat','motion_render','campaign_idea','activation_switch','global_engine_activation','integration_grant','metrics_backfill','creative_requirement','global_video_owner','client_authority_assignment','gateway_tool')
      and d.decision = 'approved' and s.source_state <> 'source_decided'
      then 'source_held'
    when r.source_system = 'aa_console' and r.source_kind = 'lead_magnet'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'sales_agent_public_use'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'opportunity_approve'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'proof_rights'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'proof_placement'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'proof_artifact'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind in ('ordinary_media','proof_delivery','meta_profile_change','google_profile_change','opportunity_activate','message_template','nurture_sequence','video_seat','motion_render','campaign_idea','activation_switch','global_engine_activation','integration_grant','metrics_backfill','creative_requirement','global_video_owner','client_authority_assignment','gateway_tool')
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.expires_at is not null and r.expires_at <= now() then 'expired'
    when d.decision = 'approved' then 'approved'
    when s.source_state <> 'pending' then s.source_state
    else 'pending'
  end as status,
  r.requested_at, r.requested_by, r.requester_kind, r.requester_ref,
  r.expires_at,
  coalesce(e.artifact_hash,r.artifact_hash) as artifact_hash,
  case when r.source_system = 'aa_console'
      and r.source_kind = 'production_release' and a.id is not null
    then jsonb_build_object('candidate',r.preview,'trusted_github_evidence',a.packet)
    else coalesce(e.preview,r.preview) end as preview,
  coalesce(e.destination,r.destination) as destination,
  coalesce(e.account_ref,r.account_ref) as account_ref,
  coalesce(e.budget,r.budget) as budget,
  coalesce(e.scope,r.scope) as scope,
  r.owner_role,
  case
    when inv.id is not null then
      'A bound source changed after this exact request. Create and review a new request.'
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then case when s.source_state = 'pending' then null
        else 'Release source and four checks are not independently attested. Refresh trusted GitHub evidence for this exact candidate; no release effect is authorized by this card alone.' end
    when r.source_system = 'aa_console'
      and r.source_kind = 'recruitment_meta_build' then coalesce(
        nullif(btrim(r.preview_blocker),''),
        'Recruitment Meta creation still lacks exact media bytes and an AAL2 prewrite gate.')
    when r.source_system = 'aa_console'
      and r.source_kind = 'organic_publication' then
      case when s.source_state = 'pending' then null
        else coalesce(nullif(btrim(r.preview_blocker),''),
          'Organic publication package is stale or lacks verified rights.') end
    when r.expires_at is null then 'An expiry is missing.'
    when nullif(btrim(coalesce(r.owner_role,'')),'') is null then 'The decision owner is missing.'
    when e.id is not null then null
    when nullif(btrim(coalesce(r.preview_blocker,'')),'') is not null then r.preview_blocker
    when r.artifact_hash is null then 'The exact artifact hash is missing.'
    when r.preview is null or jsonb_typeof(r.preview) <> 'object'
      or r.preview = '{}'::jsonb then 'The exact artifact preview is missing.'
    when r.scope is null or r.scope = '{}'::jsonb then 'The exact scope is missing.'
    else null
  end as preview_blocker,
  r.owning_path,
  s.source_state
from public.approval_requests_v6 r
left join public.approval_request_evidence_v6 e on e.request_id = r.id
left join lateral (
  select de.decision from public.approval_decision_events_v6 de
  where de.request_id = r.id order by de.event_order desc limit 1
) d on true
left join lateral (
  select i.id from public.delivery_approval_invalidations_v6 i
  where i.approval_request_id = r.id
  order by i.invalidated_at desc limit 1
) inv on true
left join lateral (
  select pa.id,pa.packet from public.production_release_attestations_v6 pa
  where pa.request_id = r.id order by pa.event_order desc limit 1
) a on true
cross join lateral (
  select case
    when r.source_system = 'aa_console' and r.source_kind = 'campaign_action'
      then public.campaign_action_exact_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then public.production_release_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'recruitment_meta_build'
      then public.recruitment_meta_build_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'organic_publication'
      then public.organic_publication_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'service_offer'
      then public.service_offer_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'lead_magnet'
      then public.lead_magnet_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'sales_agent_public_use'
      then public.sales_agent_public_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'opportunity_approve'
      then public.opportunity_approval_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'proof_rights'
      then public.proof_rights_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'proof_placement'
      then public.proof_placement_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'proof_artifact'
      then public.proof_artifact_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'engine_slot'
      then public.engine_slot_exact_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'ordinary_media'
      then public.ordinary_media_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'proof_delivery'
      then public.proof_delivery_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'meta_profile_change'
      then public.meta_profile_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'google_profile_change'
      then public.google_profile_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'opportunity_activate'
      then public.opportunity_activation_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'message_template'
      then public.message_template_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'nurture_sequence'
      then public.nurture_sequence_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'video_seat'
      then public.video_seat_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'motion_render'
      then public.motion_render_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'campaign_idea'
      then public.human_idea_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'activation_switch'
      then public.client_switch_activation_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'global_engine_activation'
      then public.global_engine_activation_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'integration_grant'
      then public.integration_grant_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'metrics_backfill'
      then public.metrics_backfill_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'creative_requirement'
      then public.creative_requirement_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'global_video_owner'
      then public.global_video_owner_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'client_authority_assignment'
      then public.client_authority_assignment_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'gateway_tool'
      then public.gateway_tool_review_source_state_v6(r.id)
    when r.source_system = 'aa_console'
      and r.source_kind = 'campaign_preparation_package'
      then public.campaign_preparation_review_source_state_v7(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'paid_operator_bundle'
      then public.paid_operator_bundle_review_source_state_v7(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'google_search_copy'
      then public.google_search_copy_review_source_state_v7(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'google_operator_bundle'
      then public.google_operator_review_source_state_v7(r.id)
    when r.source_system = 'aa_console'
      and r.source_kind in ('archived_form_return','archived_sales_return')
      then public.archived_return_inbox_source_state_v11(r.id)
    else public.approval_source_state_v6(r.id)
  end as source_state
) s;
revoke all on public.approval_inbox_v6 from public,anon,authenticated,service_role;
grant select on public.approval_inbox_v6 to authenticated,service_role;
select public.lock_down_definer_functions();
commit;
