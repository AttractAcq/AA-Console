-- Manual operator handoff is a separate event from approval and from delivery.
-- The browser verifies bytes before reporting a download; this ledger records
-- the operator's report, not an independently observed external transfer.
create table public.lead_magnet_operator_events_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  magnet_version_id uuid not null,
  approval_id uuid references public.lead_magnet_approvals(id) on delete restrict,
  content_sha256 text not null check(content_sha256 ~ '^[0-9a-f]{64}$'),
  event_kind text not null check(event_kind in ('verified_download','operator_handoff')),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  recipient text check(recipient is null or length(btrim(recipient)) between 1 and 200),
  reference text check(reference is null or length(btrim(reference)) between 1 and 500),
  occurred_at timestamptz not null default now(),
  foreign key(magnet_version_id,client_id)
    references public.lead_magnet_versions(id,client_id) on delete restrict,
  check((event_kind='verified_download' and recipient is null and reference is null)
    or (event_kind='operator_handoff' and approval_id is not null
      and recipient is not null and reference is not null))
);
create index lead_magnet_operator_events_v7_version_idx
  on public.lead_magnet_operator_events_v7(magnet_version_id,occurred_at desc);
create unique index lead_magnet_operator_handoff_once_v7
  on public.lead_magnet_operator_events_v7(magnet_version_id,approval_id,reference)
  where event_kind='operator_handoff';
alter table public.lead_magnet_operator_events_v7 enable row level security;
create policy lead_magnet_operator_events_v7_read
  on public.lead_magnet_operator_events_v7 for select to authenticated
  using(public.can_access_client(client_id));
revoke all on public.lead_magnet_operator_events_v7 from public,anon,authenticated;
grant select on public.lead_magnet_operator_events_v7 to authenticated;
grant all on public.lead_magnet_operator_events_v7 to service_role;

create function public.guard_lead_magnet_operator_event_v7()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  raise exception 'Magnet operator events are append-only.';
end $$;
create trigger lead_magnet_operator_events_v7_immutable
  before update or delete on public.lead_magnet_operator_events_v7
  for each row execute function public.guard_lead_magnet_operator_event_v7();
create trigger lead_magnet_operator_events_v7_no_truncate
  before truncate on public.lead_magnet_operator_events_v7
  for each statement execute function public.guard_lead_magnet_operator_event_v7();

create function public.record_lead_magnet_operator_event_v7(
  p_version_id uuid,p_kind text,p_recipient text default null,p_reference text default null
) returns public.lead_magnet_operator_events_v7
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare v public.lead_magnet_versions%rowtype;
  a public.lead_magnet_approvals%rowtype;
  e public.lead_magnet_operator_events_v7%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not (coalesce(public.is_admin(),false)
      or coalesce(auth.uid()=public.active_video_approval_manager(
        (select client_id from public.lead_magnet_versions where id=p_version_id)),false)) then
    raise exception 'An admin or assigned client manager is required.' using errcode='42501';
  end if;
  select * into v from public.lead_magnet_versions where id=p_version_id;
  if v.id is null or not public.can_access_client(v.client_id) then
    raise exception 'Magnet version unavailable.' using errcode='42501';
  end if;
  if p_kind not in ('verified_download','operator_handoff') then
    raise exception 'Unsupported magnet operator event.' using errcode='23514';
  end if;
  if p_kind='verified_download' then
    if p_recipient is not null or p_reference is not null then
      raise exception 'A download report has no recipient or handoff reference.';
    end if;
    select * into a from public.lead_magnet_approvals
      where magnet_version_id=v.id and client_id=v.client_id and status='approved'
        and payload_hash=public.lead_magnet_payload_hash_v6(v.id)
      order by decided_at desc limit 1;
  else
    if nullif(btrim(coalesce(p_recipient,'')),'') is null
      or nullif(btrim(coalesce(p_reference,'')),'') is null then
      raise exception 'A handoff needs a recipient and an external reference.';
    end if;
    select * into a from public.lead_magnet_approvals
      where magnet_version_id=v.id and client_id=v.client_id and status='approved'
      order by decided_at desc limit 1;
    if a.id is null or a.payload_hash is distinct from
        public.lead_magnet_payload_hash_v6(v.id) then
      raise exception 'An approved exact version is required for handoff.';
    end if;
    if not exists(select 1 from public.lead_magnet_operator_events_v7 d
      where d.magnet_version_id=v.id and d.client_id=v.client_id
        and d.event_kind='verified_download' and d.content_sha256=v.content_sha256
        and d.approval_id=a.id) then
      raise exception 'Download and verify this approved file before recording handoff.';
    end if;
    select * into e from public.lead_magnet_operator_events_v7 prior
      where prior.magnet_version_id=v.id and prior.approval_id=a.id
        and prior.event_kind='operator_handoff'
        and prior.reference=btrim(p_reference);
    if found then
      if e.recipient is distinct from btrim(p_recipient) then
        raise exception 'This handoff reference already names a different recipient.';
      end if;
      return e;
    end if;
  end if;
  insert into public.lead_magnet_operator_events_v7
    (client_id,magnet_version_id,approval_id,content_sha256,event_kind,
      actor_id,recipient,reference)
  values(v.client_id,v.id,a.id,v.content_sha256,p_kind,auth.uid(),
    case when p_kind='operator_handoff' then btrim(p_recipient) end,
    case when p_kind='operator_handoff' then btrim(p_reference) end)
  on conflict do nothing returning * into e;
  if e.id is null and p_kind='operator_handoff' then
    select * into e from public.lead_magnet_operator_events_v7 prior
      where prior.magnet_version_id=v.id and prior.approval_id=a.id
        and prior.event_kind='operator_handoff'
        and prior.reference=btrim(p_reference);
    if e.id is not null and e.recipient is distinct from btrim(p_recipient) then
      raise exception 'This handoff reference already names a different recipient.';
    end if;
  end if;
  if e.id is null then raise exception 'Magnet operator event could not be recorded.'; end if;
  return e;
end $$;
revoke all on function public.record_lead_magnet_operator_event_v7(uuid,text,text,text)
  from public,anon;
grant execute on function public.record_lead_magnet_operator_event_v7(uuid,text,text,text)
  to authenticated;
select public.lock_down_definer_functions();
