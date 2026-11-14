-- An approved action can be withdrawn before another write. The source
-- decision remains immutable; this is an append-only withdrawal and a
-- matching canonical Inbox event. Already observed provider effects remain
-- historical facts and require a separate retraction action.
begin;
create table public.campaign_action_revocations_v6 (
  approval_id uuid primary key references public.campaign_action_approvals(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  revoked_by uuid not null references public.profiles(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  inbox_decision_id uuid not null unique references public.approval_decision_events_v6(id)
    on delete restrict,
  revoked_at timestamptz not null default now()
);
create trigger campaign_action_revocations_v6_append_only
  before update or delete on public.campaign_action_revocations_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger campaign_action_revocations_v6_no_truncate
  before truncate on public.campaign_action_revocations_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
alter table public.campaign_action_revocations_v6 enable row level security;
create policy campaign_action_revocations_v6_read on public.campaign_action_revocations_v6
  for select to authenticated using (
    coalesce(public.is_admin(),false)
    or auth.uid() = public.active_video_approval_manager(client_id)
  );
revoke all on public.campaign_action_revocations_v6 from public,anon,authenticated,service_role;
grant select on public.campaign_action_revocations_v6 to authenticated,service_role;

create function public.revoke_campaign_action_approval_v6(
  p_approval_id uuid,p_reason text)
returns public.campaign_action_revocations_v6 language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_approval public.campaign_action_approvals%rowtype;
  v_request public.approval_requests_v6%rowtype;
  v_decision_id uuid;
  v_revocation public.campaign_action_revocations_v6%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned human with AAL2 must revoke this action.'
      using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null
    or length(btrim(p_reason)) > 1000 then
    raise exception 'A bounded revocation reason is required.' using errcode = '22023';
  end if;
  select * into v_approval from public.campaign_action_approvals
    where id = p_approval_id for update;
  if not found or v_approval.status <> 'approved' then
    raise exception 'Only an approved action can be revoked.' using errcode = '23514';
  end if;
  if not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(v_approval.client_id),false)) then
    raise exception 'Only an admin or the active client manager may revoke this action.'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.campaign_action_revocations_v6
    where approval_id = p_approval_id) then
    raise exception 'This action approval was already revoked.' using errcode = '23514';
  end if;
  select * into v_request from public.approval_requests_v6 r
    where r.source_system = 'aa_console' and r.source_kind = 'campaign_action'
      and r.source_id = p_approval_id::text
      and r.source_version = v_approval.request_hash
      and r.client_id = v_approval.client_id;
  if not found then
    raise exception 'The canonical action decision is missing.' using errcode = '23514';
  end if;
  v_decision_id := public.record_approval_decision_v6(
    v_request.id,'revoked',v_approval.artifact_version_hash,
    'campaign_action_revocations:' || p_approval_id::text,btrim(p_reason));
  insert into public.campaign_action_revocations_v6
    (approval_id,client_id,revoked_by,reason,inbox_decision_id)
  values (p_approval_id,v_approval.client_id,auth.uid(),btrim(p_reason),v_decision_id)
  returning * into v_revocation;
  return v_revocation;
end $$;
revoke all on function public.revoke_campaign_action_approval_v6(uuid,text)
  from public,anon,service_role;
grant execute on function public.revoke_campaign_action_approval_v6(uuid,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;
