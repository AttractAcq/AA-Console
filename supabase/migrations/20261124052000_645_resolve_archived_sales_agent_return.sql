-- Resolve one exact archived-contact sales conversation through AAL2 review.
-- Multiple pending doors to the same archive remain held for coordinated review.
begin;
create table public.sales_agent_return_resolutions_v11 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  conversation_id uuid not null unique references public.sales_agent_conversations(id)
    on delete restrict,
  archived_lead_id uuid not null,
  resolved_lead_id uuid not null,
  action text not null check (action in ('recover','new_lead')),
  reason text not null check (length(btrim(reason)) between 8 and 2000),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  reviewer_aal text not null check (reviewer_aal='aal2'),
  reviewed_at timestamptz not null default clock_timestamp(),
  foreign key (archived_lead_id,client_id)
    references public.lead_identities(id,client_id) on delete restrict,
  foreign key (resolved_lead_id,client_id)
    references public.lead_identities(id,client_id) on delete restrict
);
alter table public.sales_agent_return_resolutions_v11 enable row level security;
create policy sales_agent_return_resolutions_read_v11
  on public.sales_agent_return_resolutions_v11 for select to authenticated
  using (public.can_read_client_sales_data(client_id));
revoke all on public.sales_agent_return_resolutions_v11
  from public,anon,authenticated,service_role;
grant select on public.sales_agent_return_resolutions_v11 to authenticated;
create trigger sales_agent_return_resolution_immutable_v11
  before update or delete on public.sales_agent_return_resolutions_v11
  for each row execute function public.guard_lead_return_resolution_history_v11();

create function public.sales_agent_return_review_packet_v11(p_conversation_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare c public.sales_agent_conversations%rowtype;
  a public.archived_leads%rowtype; v_hash text;
begin
  if auth.role()<>'authenticated' or auth.uid() is null then
    raise exception 'A signed-in lead reviewer is required.' using errcode='42501';
  end if;
  select * into c from public.sales_agent_conversations
    where id=p_conversation_id;
  if c.id is null or not public.may_manage_client_leads(c.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  if c.lead_id is not null or c.archive_match_lead_id is null
     or c.archive_match_snapshot is null
     or exists(select 1 from public.sales_agent_return_resolutions_v11 r
       where r.conversation_id=c.id) then
    raise exception 'This sales conversation is not waiting for archived-contact review.'
      using errcode='23514';
  end if;
  select * into a from public.archived_leads
    where id=c.archive_match_lead_id and client_id=c.client_id;
  if a.id is null then
    raise exception 'The archived contact changed; review again.' using errcode='23514';
  end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object(
    'conversation',to_jsonb(c),'archive',to_jsonb(a))::text,'UTF8')),'hex');
  return jsonb_build_object(
    'source_hash',v_hash,'conversation_id',c.id,'client_id',c.client_id,
    'archived_lead_id',a.id,'archived_name',a.name,
    'archived_email',a.lead->>'email','archived_phone',a.lead->>'phone',
    'archived_source',a.lead->>'source','archived_at',a.archived_at,
    'matched',c.archive_match_snapshot,
    'current_name',c.contact_name,'current_email',c.contact_email,
    'current_phone',c.contact_phone,'current_outcome',c.outcome,
    'current_qualified',c.qualified);
end $$;
revoke all on function public.sales_agent_return_review_packet_v11(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.sales_agent_return_review_packet_v11(uuid)
  to authenticated;

create or replace function public.guard_sales_agent_archive_match_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_archived public.archived_leads%rowtype;
  v_contact_key text;
begin
  if old.archive_match_lead_id is not null then
    if new.archive_match_lead_id is distinct from old.archive_match_lead_id
       or new.archive_match_snapshot is distinct from old.archive_match_snapshot then
      raise exception 'A held sales-agent identity match is immutable.'
        using errcode='23514';
    end if;
    if new.lead_id is distinct from old.lead_id and (
      new.lead_id is null or not exists(
        select 1 from public.sales_agent_return_resolutions_v11 r
        where r.conversation_id=old.id and r.client_id=old.client_id
          and r.archived_lead_id=old.archive_match_lead_id
          and r.resolved_lead_id=new.lead_id and r.reviewer_aal='aal2')) then
      raise exception 'A held sales-agent identity needs exact AAL2 review before promotion.'
        using errcode='23514';
    end if;
    return new;
  end if;
  if new.archive_match_lead_id is null then
    if new.archive_match_snapshot is not null then
      raise exception 'An archived-contact snapshot needs a candidate identity.'
        using errcode='23514';
    end if;
    return new;
  end if;
  if auth.role()<>'service_role' or new.lead_id is not null
     or new.archive_match_snapshot is null then
    raise exception 'An archived-contact hold must be recorded by the internal capture path.'
      using errcode='23514';
  end if;
  v_contact_key:=public.lead_dedupe_key(new.contact_email,new.contact_phone);
  select * into v_archived from public.archived_leads
    where id=new.archive_match_lead_id and client_id=new.client_id;
  if v_archived.id is null or v_contact_key is null
     or new.archive_match_snapshot->>'contact_key' is distinct from v_contact_key
     or new.archive_match_snapshot->>'contact_name' is distinct from new.contact_name
     or new.archive_match_snapshot->>'contact_email' is distinct from new.contact_email
     or new.archive_match_snapshot->>'contact_phone' is distinct from new.contact_phone
     or new.archive_match_snapshot->>'outcome' is distinct from new.outcome
     or new.archive_match_snapshot->>'qualified' is distinct from new.qualified::text
     or new.archive_match_snapshot->>'sales_agent_id' is distinct from new.sales_agent_id::text
     or new.archive_match_snapshot->>'page_id' is distinct from new.page_id::text
     or new.archive_match_snapshot->>'conversation_started_at' is distinct from
       (to_jsonb(new.started_at)#>>'{}')
     or new.archive_match_snapshot->>'transcript_sha256' is distinct from
       encode(sha256(convert_to(new.transcript::text,'UTF8')),'hex')
     or new.archive_match_snapshot->>'matched_at' is null
     or coalesce(v_archived.lead->>'dedupe_key',
       public.lead_dedupe_key(v_archived.lead->>'email',
         v_archived.lead->>'phone')) is distinct from v_contact_key then
    raise exception 'The archived-contact match snapshot does not describe this conversation and archive.'
      using errcode='23514';
  end if;
  return new;
end $$;

create or replace function public.recover_lead(p_lead_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_archive public.archived_leads%rowtype;
  v_columns text; v_values text;
begin
  select * into v_archive from public.archived_leads
    where id=p_lead_id for update;
  if not found then raise exception 'That archived lead no longer exists.'; end if;
  if not public.may_manage_client_leads(v_archive.client_id) then
    raise exception 'Not permitted for this client'; end if;
  if exists(select 1 from public.lead_submissions s
    where s.archive_match_lead_id=p_lead_id and s.status='received'
      and not exists(select 1 from public.lead_return_resolutions_v11 r
        where r.submission_id=s.id and r.client_id=s.client_id
          and r.archived_lead_id=p_lead_id and r.action='recover'
          and r.reviewer_aal='aal2')) then
    raise exception 'A returning submission needs exact AAL2 review before recovery.'
      using errcode='23514';
  end if;
  if exists(select 1 from public.sales_agent_conversations c
    where c.archive_match_lead_id=p_lead_id and c.lead_id is null
      and not exists(select 1 from public.sales_agent_return_resolutions_v11 r
        where r.conversation_id=c.id and r.client_id=c.client_id
          and r.archived_lead_id=p_lead_id and r.action='recover'
          and r.reviewer_aal='aal2')) then
    raise exception 'A returning sales conversation needs exact AAL2 review before recovery.'
      using errcode='23514';
  end if;
  if v_archive.stage_at_archive in ('lead','sale') then
    raise exception 'This legacy lead cannot be recovered into an old stage.';
  end if;
  select string_agg(format('%I',x.attname),', ' order by x.attnum),
         string_agg(format('r.%I',x.attname),', ' order by x.attnum)
    into v_columns,v_values from pg_catalog.pg_attribute x
    where x.attrelid='public.client_leads'::regclass
      and x.attnum>0 and not x.attisdropped and x.attgenerated='';
  if v_columns is null or v_values is null then
    raise exception 'Client lead restore columns are unavailable'; end if;
  execute format('insert into public.client_leads (%s) select %s '
    || 'from jsonb_populate_record(null::public.client_leads,$1) as r',
    v_columns,v_values) using v_archive.lead;
  insert into public.lead_events
    select * from jsonb_populate_recordset(null::public.lead_events,v_archive.events);
  insert into public.lead_events(lead_id,client_id,kind,body,created_by)
  values(p_lead_id,v_archive.client_id,'note',
    'Recovered from archive on '||to_char(now() at time zone 'UTC',
      'YYYY-MM-DD HH24:MI')||' UTC',auth.uid());
  delete from public.archived_leads where id=p_lead_id;
end $$;
revoke execute on function public.recover_lead(uuid) from public,anon;
grant execute on function public.recover_lead(uuid) to authenticated,service_role;

create function public.resolve_sales_agent_return_v11(
  p_conversation_id uuid,p_action text,p_expected_hash text,p_reason text)
returns uuid language plpgsql security definer
set search_path=pg_catalog,public as $$
declare c public.sales_agent_conversations%rowtype;
  a public.archived_leads%rowtype; v_packet jsonb;
  v_key text; v_lead uuid; v_snap jsonb; v_stage public.lead_stage;
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
  return v_lead;
end $$;
revoke all on function public.resolve_sales_agent_return_v11(uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.resolve_sales_agent_return_v11(uuid,text,text,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;
