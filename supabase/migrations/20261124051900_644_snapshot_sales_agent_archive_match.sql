-- Capture the exact sales conversation contact and source at the archived
-- match. Later agent turns may update contact fields; the review sees both the
-- frozen match-time snapshot and current conversation instead of a moving target.
begin;
do $preflight$
begin
  if exists(select 1 from public.sales_agent_conversations
    where archive_match_lead_id is not null) then
    raise exception 'Existing archived sales-agent holds need a separately evidenced snapshot backfill.'
      using errcode='23514';
  end if;
end $preflight$;
alter table public.sales_agent_conversations
  add column archive_match_snapshot jsonb;
alter table public.sales_agent_conversations
  add constraint sales_agent_archive_match_snapshot_pair_v11
  check ((archive_match_lead_id is null and archive_match_snapshot is null)
    or (archive_match_lead_id is not null and archive_match_snapshot is not null));
comment on column public.sales_agent_conversations.archive_match_snapshot is
  'Immutable match-time sales conversation contact/source snapshot. It is not consent or approval to restore an archived identity.';
create function public.guard_sales_agent_archive_match_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_archived public.archived_leads%rowtype;
  v_contact_key text;
begin
  if old.archive_match_lead_id is not null then
    if new.archive_match_lead_id is distinct from old.archive_match_lead_id
       or new.archive_match_snapshot is distinct from old.archive_match_snapshot
       or new.lead_id is distinct from old.lead_id then
      raise exception 'A held sales-agent identity match cannot be rewritten or promoted without review.'
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
  if v_archived.id is null
     or v_contact_key is null
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
revoke all on function public.guard_sales_agent_archive_match_v11()
  from public,anon,authenticated,service_role;
create trigger sales_agent_archive_match_guard_v11
  before update of archive_match_lead_id,archive_match_snapshot,lead_id
  on public.sales_agent_conversations
  for each row execute function public.guard_sales_agent_archive_match_v11();
create or replace function public.capture_sales_agent_lead(
  p_conversation_id uuid,p_opportunity_value numeric default null)
returns uuid language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  v_conv public.sales_agent_conversations%rowtype;
  v_lead public.client_leads%rowtype;
  v_key text;
  v_archived uuid;
  v_stage public.lead_stage;
  v_created boolean:=false;
begin
  select * into v_conv from public.sales_agent_conversations
    where id=p_conversation_id for update;
  if v_conv.id is null then
    raise exception 'That conversation no longer exists.';
  end if;
  if not coalesce(public.may_manage_client_leads(v_conv.client_id),false) then
    raise exception 'Not permitted for this client' using errcode='42501';
  end if;
  -- The durable identity link can name a finished archived lead. It remains
  -- an idempotency key, never a reason to create another lead on retry.
  if v_conv.lead_id is not null then return v_conv.lead_id; end if;
  if v_conv.archive_match_lead_id is not null then return null; end if;
  if nullif(btrim(coalesce(v_conv.contact_email,'')),'') is null
     and nullif(btrim(coalesce(v_conv.contact_phone,'')),'') is null then
    raise exception 'That conversation captured no way to contact anyone.';
  end if;
  v_key:=public.lead_dedupe_key(v_conv.contact_email,v_conv.contact_phone);
  perform pg_advisory_xact_lock(hashtextextended(
    v_conv.client_id::text || ':lead-contact:' || v_key,0));
  select * into v_lead from public.client_leads
    where client_id=v_conv.client_id and dedupe_key=v_key
    order by created_at limit 1 for key share;
  if not found then
    select a.id into v_archived from public.archived_leads a
      where a.client_id=v_conv.client_id
        and coalesce(a.lead->>'dedupe_key',
          public.lead_dedupe_key(a.lead->>'email',a.lead->>'phone'))=v_key
      order by a.archived_at desc,a.id limit 1 for update;
    if v_archived is not null then
      update public.sales_agent_conversations
        set archive_match_lead_id=v_archived,
            archive_match_snapshot=jsonb_build_object(
              'contact_name',v_conv.contact_name,
              'contact_email',v_conv.contact_email,
              'contact_phone',v_conv.contact_phone,
              'contact_key',v_key,
              'outcome',v_conv.outcome,
              'qualified',v_conv.qualified,
              'sales_agent_id',v_conv.sales_agent_id,
              'page_id',v_conv.page_id,
              'conversation_started_at',v_conv.started_at,
              'transcript_sha256',encode(sha256(convert_to(
                v_conv.transcript::text,'UTF8')),'hex'),
              'matched_at',clock_timestamp())
        where id=v_conv.id;
      return null;
    end if;
    v_stage:=case when v_conv.qualified
      then 'qualified_conversation'::public.lead_stage
      else 'conversation'::public.lead_stage end;
    insert into public.client_leads (
      client_id,name,email,phone,source,source_channel,
      source_page_id,source_sales_agent_id,
      stage,stage_at,opportunity_value,notes)
    values (v_conv.client_id,
      nullif(btrim(coalesce(v_conv.contact_name,'')),''),
      nullif(btrim(coalesce(v_conv.contact_email,'')),''),
      nullif(btrim(coalesce(v_conv.contact_phone,'')),''),
      'sales_agent','sales_agent',v_conv.page_id,v_conv.sales_agent_id,
      v_stage,now(),p_opportunity_value,
      nullif(btrim(coalesce(v_conv.outcome,'')),''))
    returning * into v_lead;
    v_created:=true;
  end if;
  update public.sales_agent_conversations set lead_id=v_lead.id
    where id=v_conv.id;
  if v_created then
    insert into public.lead_events
      (lead_id,client_id,kind,body,from_stage,to_stage,created_by)
    values (v_lead.id,v_conv.client_id,'stage_change',
      'Captured from a sales agent conversation.',null,v_stage,auth.uid());
  else
    insert into public.lead_events(lead_id,client_id,kind,body,created_by)
    values(v_lead.id,v_conv.client_id,'note',
      'Returned through a sales agent conversation.',auth.uid());
  end if;
  return v_lead.id;
end $$;
select public.lock_down_definer_functions();
commit;
