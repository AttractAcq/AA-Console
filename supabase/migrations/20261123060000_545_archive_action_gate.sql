-- A successful archive action must change exactly one row for the named
-- client. Direct browser updates can silently affect zero rows under RLS,
-- especially Opportunities and Lead Magnets, whose base tables are read-only.
create table public.archive_decisions_v8 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  table_name text not null check(table_name in ('client_pages','client_campaigns',
    'client_sales_agents','market_opportunities','client_agent_records','lead_magnets')),
  record_id uuid not null,
  action text not null check(action in ('archive','restore')),
  acted_by uuid not null references public.profiles(id) on delete restrict,
  acted_at timestamptz not null default now(),
  archive_stamp timestamptz
);
create index archive_decisions_client_record_v8 on public.archive_decisions_v8
  (client_id,table_name,record_id,acted_at desc);
alter table public.archive_decisions_v8 enable row level security;
create policy archive_decisions_client_v8 on public.archive_decisions_v8
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.archive_decisions_v8 from public,anon,authenticated;
grant select on public.archive_decisions_v8 to authenticated;
grant all on public.archive_decisions_v8 to service_role;
create trigger archive_decisions_immutable_v8 before update or delete
  on public.archive_decisions_v8 for each row
  execute function public.reject_approval_ledger_mutation_v6();

create function public.set_client_archive_v8(
  p_client_id uuid,p_table_name text,p_record_id uuid,p_archive boolean)
returns timestamptz language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare v_table text; v_stamp timestamptz; v_count integer;
begin
  if auth.role()<>'authenticated' or auth.uid() is null or p_client_id is null
    or p_record_id is null or p_archive is null then
    raise exception 'An authenticated client archive action is required.' using errcode='42501'; end if;
  if not (public.is_admin() or coalesce(auth.uid()=public.active_video_approval_manager(p_client_id),false)) then
    raise exception 'Archive operator is not authorized for this client.' using errcode='42501'; end if;
  v_table:=case p_table_name
    when 'client_pages' then 'client_pages'
    when 'client_campaigns' then 'client_campaigns'
    when 'client_sales_agents' then 'client_sales_agents'
    when 'market_opportunities' then 'market_opportunities'
    when 'client_agent_records' then 'client_agent_records'
    when 'lead_magnets' then 'lead_magnets'
    else null end;
  if v_table is null then
    raise exception 'Unsupported archive domain.' using errcode='23514'; end if;
  execute format('update public.%I set archived_at=$1 where id=$2 and client_id=$3 and %s returning archived_at',
    v_table,case when p_archive then 'archived_at is null' else 'archived_at is not null' end)
    into v_stamp using case when p_archive then now() else null end,p_record_id,p_client_id;
  get diagnostics v_count=row_count;
  if v_count<>1 then
    raise exception 'The client record was missing or its archive state changed.' using errcode='23514'; end if;
  insert into public.archive_decisions_v8
    (client_id,table_name,record_id,action,acted_by,archive_stamp)
  values(p_client_id,v_table,p_record_id,case when p_archive then 'archive' else 'restore' end,
    auth.uid(),v_stamp);
  return v_stamp;
end $$;
revoke all on function public.set_client_archive_v8(uuid,text,uuid,boolean)
  from public,anon,service_role;
grant execute on function public.set_client_archive_v8(uuid,text,uuid,boolean)
  to authenticated;
select public.lock_down_definer_functions();
