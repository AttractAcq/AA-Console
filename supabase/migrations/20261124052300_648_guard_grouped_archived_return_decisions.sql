-- A single-door decision must not dispose of one arrival while another form,
-- sales conversation or held DM points at the same archived identity.
-- Batch resolution rows are internal-only; the coordinated resolver follows.
begin;
create table public.archived_return_batch_resolutions_v11 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  archived_lead_id uuid not null,
  resolved_lead_id uuid not null,
  action text not null check (action in ('recover','new_lead')),
  reason text not null check (length(btrim(reason)) between 8 and 2000),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  source_count integer not null check (source_count >= 2),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  reviewer_aal text not null check (reviewer_aal='aal2'),
  reviewed_at timestamptz not null default clock_timestamp(),
  foreign key (archived_lead_id,client_id)
    references public.lead_identities(id,client_id) on delete restrict,
  foreign key (resolved_lead_id,client_id)
    references public.lead_identities(id,client_id) on delete restrict
);
alter table public.archived_return_batch_resolutions_v11 enable row level security;
create policy archived_return_batch_resolutions_read_v11
  on public.archived_return_batch_resolutions_v11 for select to authenticated
  using (public.can_read_client_sales_data(client_id));
revoke all on public.archived_return_batch_resolutions_v11
  from public,anon,authenticated,service_role;
grant select on public.archived_return_batch_resolutions_v11 to authenticated;
create trigger archived_return_batch_resolution_immutable_v11
  before update or delete on public.archived_return_batch_resolutions_v11
  for each row execute function public.guard_lead_return_resolution_history_v11();

alter table public.lead_return_resolutions_v11
  add column batch_resolution_id uuid
    references public.archived_return_batch_resolutions_v11(id) on delete restrict;
alter table public.sales_agent_return_resolutions_v11
  add column batch_resolution_id uuid
    references public.archived_return_batch_resolutions_v11(id) on delete restrict;

create function public.guard_grouped_archived_return_resolution_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_batch public.archived_return_batch_resolutions_v11%rowtype;
  v_pending integer;
begin
  if new.batch_resolution_id is not null then
    select * into v_batch from public.archived_return_batch_resolutions_v11
      where id=new.batch_resolution_id;
    if v_batch.id is null or v_batch.client_id is distinct from new.client_id
       or v_batch.archived_lead_id is distinct from new.archived_lead_id
       or v_batch.resolved_lead_id is distinct from new.resolved_lead_id
       or v_batch.action is distinct from new.action
       or v_batch.reviewer_id is distinct from new.reviewer_id
       or v_batch.reviewer_aal is distinct from new.reviewer_aal then
      raise exception 'The grouped identity decision does not match this return.'
        using errcode='23514';
    end if;
    return new;
  end if;

  select count(*) into v_pending from (
    select s.id from public.lead_submissions s
      where s.client_id=new.client_id
        and s.archive_match_lead_id=new.archived_lead_id
        and s.status='received' and s.lead_id is null
    union all
    select c.id from public.sales_agent_conversations c
      where c.client_id=new.client_id
        and c.archive_match_lead_id=new.archived_lead_id
        and c.lead_id is null and c.archive_match_snapshot is not null
    union all
    select d.id from public.dm_conversations d
      join public.dm_identities i on i.id=d.identity_id
        and i.client_id=d.client_id
      where d.client_id=new.client_id and i.lead_id=new.archived_lead_id
        and d.status='closed'
        and d.closed_reason='archived_lead_return_review'
  ) pending;
  if v_pending>1 then
    raise exception 'Related archived-contact arrivals need one coordinated AAL2 decision.'
      using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_grouped_archived_return_resolution_v11()
  from public,anon,authenticated,service_role;
create trigger lead_return_group_guard_v11
  before insert on public.lead_return_resolutions_v11
  for each row execute function public.guard_grouped_archived_return_resolution_v11();
create trigger sales_return_group_guard_v11
  before insert on public.sales_agent_return_resolutions_v11
  for each row execute function public.guard_grouped_archived_return_resolution_v11();
select public.lock_down_definer_functions();
commit;
