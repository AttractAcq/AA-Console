-- Keep a sales-agent conversation linked to its durable lead identity after
-- archive. A new conversation with the same contact waits for human identity
-- review instead of creating a second active lead.
begin;
do $preflight$
begin
  if exists (select 1 from public.sales_agent_conversations c
    left join public.lead_identities i on i.id=c.lead_id
      and i.client_id=c.client_id
    where c.lead_id is not null and i.id is null) then
    raise exception 'Sales-agent conversation has a lead without same-client identity.'
      using errcode='23503';
  end if;
end $preflight$;
alter table public.sales_agent_conversations
  drop constraint sales_agent_conversations_lead_id_fkey;
alter table public.sales_agent_conversations
  add constraint sales_agent_conversations_lead_identity_fkey_v11
  foreign key (lead_id,client_id)
  references public.lead_identities(id,client_id)
  on delete set null (lead_id);
create trigger sales_agent_conversations_lead_active_guard_v11
  before insert or update of lead_id,client_id
  on public.sales_agent_conversations
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
alter table public.sales_agent_conversations
  add column archive_match_lead_id uuid;
alter table public.sales_agent_conversations
  add constraint sales_agent_conversations_archive_match_identity_fkey_v11
  foreign key (archive_match_lead_id,client_id)
  references public.lead_identities(id,client_id)
  on delete restrict;
create index sales_agent_conversations_archive_match_v11_idx
  on public.sales_agent_conversations(client_id,started_at desc)
  where archive_match_lead_id is not null and lead_id is null;
comment on column public.sales_agent_conversations.archive_match_lead_id is
  'Historical contact candidate. The conversation is retained but no active lead is created until a human reviews identity.';

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
        set archive_match_lead_id=v_archived where id=v_conv.id;
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
revoke all on function public.capture_sales_agent_lead(uuid,numeric)
  from public,anon,authenticated,service_role;
grant execute on function public.capture_sales_agent_lead(uuid,numeric)
  to service_role;
select public.lock_down_definer_functions();
commit;
