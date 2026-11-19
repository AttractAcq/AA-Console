-- Preserve and expose the exact archived-DM return for human identity review.
-- The decision route follows; direct Archive recovery cannot bypass this hold.
begin;
create table public.archived_dm_return_resolutions_v11 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  conversation_id uuid not null unique references public.dm_conversations(id)
    on delete restrict,
  identity_id uuid not null references public.dm_identities(id) on delete restrict,
  archived_lead_id uuid not null,
  resolved_lead_id uuid not null,
  action text not null check (action in ('recover','new_lead')),
  reason text not null check (length(btrim(reason)) between 8 and 2000),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  reviewer_aal text not null check (reviewer_aal='aal2'),
  batch_resolution_id uuid references public.archived_return_batch_resolutions_v11(id)
    on delete restrict,
  reviewed_at timestamptz not null default clock_timestamp(),
  foreign key (archived_lead_id,client_id)
    references public.lead_identities(id,client_id) on delete restrict,
  foreign key (resolved_lead_id,client_id)
    references public.lead_identities(id,client_id) on delete restrict
);
alter table public.archived_dm_return_resolutions_v11 enable row level security;
create policy archived_dm_return_resolutions_read_v11
  on public.archived_dm_return_resolutions_v11 for select to authenticated
  using (public.can_read_client_sales_data(client_id));
revoke all on public.archived_dm_return_resolutions_v11
  from public,anon,authenticated,service_role;
grant select on public.archived_dm_return_resolutions_v11 to authenticated;
create trigger archived_dm_return_resolution_immutable_v11
  before update or delete on public.archived_dm_return_resolutions_v11
  for each row execute function public.guard_lead_return_resolution_history_v11();

create function public.archived_dm_return_review_packet_v11(p_conversation_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare c public.dm_conversations%rowtype;
  i public.dm_identities%rowtype;
  a public.archived_leads%rowtype;
  v_messages jsonb; v_hash text;
begin
  if auth.role()<>'authenticated' or auth.uid() is null then
    raise exception 'A signed-in lead reviewer is required.' using errcode='42501';
  end if;
  select * into c from public.dm_conversations where id=p_conversation_id;
  if c.id is null or not public.may_manage_client_leads(c.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  select * into i from public.dm_identities
    where id=c.identity_id and client_id=c.client_id;
  if i.id is null or i.lead_id is null or c.status<>'closed'
     or c.closed_reason<>'archived_lead_return_review'
     or exists(select 1 from public.archived_dm_return_resolutions_v11 r
       where r.conversation_id=c.id) then
    raise exception 'This DM is not waiting for archived-contact review.'
      using errcode='23514';
  end if;
  select * into a from public.archived_leads
    where id=i.lead_id and client_id=c.client_id;
  if a.id is null then
    raise exception 'The archived contact changed; review again.'
      using errcode='23514';
  end if;
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
revoke all on function public.archived_dm_return_review_packet_v11(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.archived_dm_return_review_packet_v11(uuid)
  to authenticated;

create function public.list_archived_dm_returns_v11(p_client_id uuid)
returns table(conversation_id uuid,archived_lead_id uuid,platform text,
  display_name text,last_inbound_at timestamptz,unread_inbound integer)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.role()<>'authenticated' or auth.uid() is null
     or not public.may_manage_client_leads(p_client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  return query select c.id,a.id,c.platform,i.display_name,
      c.last_inbound_at,c.unread_inbound
    from public.dm_conversations c
    join public.dm_identities i on i.id=c.identity_id
      and i.client_id=c.client_id
    join public.archived_leads a on a.id=i.lead_id
      and a.client_id=c.client_id
    where c.client_id=p_client_id and c.status='closed'
      and c.closed_reason='archived_lead_return_review'
      and not exists(select 1 from public.archived_dm_return_resolutions_v11 r
        where r.conversation_id=c.id)
    order by c.last_inbound_at desc nulls last,c.id;
end $$;
revoke all on function public.list_archived_dm_returns_v11(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.list_archived_dm_returns_v11(uuid)
  to authenticated;

create function public.guard_archived_dm_recovery_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  -- The insert guard serializes with inbound DM recording before a recovered
  -- lead can become active. This delete guard is a second check for direct
  -- archive deletion and for a held conversation changed within the request.
  if exists(select 1 from public.dm_conversations c
      join public.dm_identities i on i.id=c.identity_id
        and i.client_id=c.client_id
      where i.lead_id=old.id and c.client_id=old.client_id
        and c.status='closed'
        and c.closed_reason='archived_lead_return_review'
        and not exists(select 1 from public.archived_dm_return_resolutions_v11 r
          where r.conversation_id=c.id and r.client_id=c.client_id
            and r.identity_id=i.id and r.archived_lead_id=old.id
            and r.resolved_lead_id=old.id and r.action='recover'
            and r.reviewer_aal='aal2')) then
    raise exception 'An archived DM needs exact AAL2 identity review before recovery.'
      using errcode='23514';
  end if;
  return old;
end $$;
revoke all on function public.guard_archived_dm_recovery_v11()
  from public,anon,authenticated,service_role;
create trigger archived_dm_recovery_guard_v11
  before delete on public.archived_leads
  for each row execute function public.guard_archived_dm_recovery_v11();

create function public.guard_archived_dm_lead_restore_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if exists(select 1 from public.archived_leads a
      where a.id=new.id and a.client_id=new.client_id) then
    -- Inbound record_inbound_dm_v6 updates this identity before it checks
    -- whether the lead is active. Lock it before inserting the active row,
    -- avoiding a DM/recovery race or a later lock-order cycle.
    perform 1 from public.dm_identities i
      where i.client_id=new.client_id and i.lead_id=new.id
      order by i.id for update;
    if exists(select 1 from public.dm_conversations c
        join public.dm_identities i on i.id=c.identity_id
          and i.client_id=c.client_id
        where i.lead_id=new.id and c.client_id=new.client_id
          and c.status='closed'
          and c.closed_reason='archived_lead_return_review'
          and not exists(select 1 from public.archived_dm_return_resolutions_v11 r
            where r.conversation_id=c.id and r.client_id=c.client_id
              and r.identity_id=i.id and r.archived_lead_id=new.id
              and r.resolved_lead_id=new.id and r.action='recover'
              and r.reviewer_aal='aal2')) then
      raise exception 'An archived DM needs exact AAL2 identity review before recovery.'
        using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_archived_dm_lead_restore_v11()
  from public,anon,authenticated,service_role;
create trigger archived_dm_lead_restore_guard_v11
  before insert on public.client_leads
  for each row execute function public.guard_archived_dm_lead_restore_v11();
select public.lock_down_definer_functions();
commit;
