-- Bind each new lead-magnet source transition to its exact Inbox request.
begin;
create function public.guard_lead_magnet_inbox_decision_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  v_state text;
begin
  if new.status = old.status then return new; end if;
  if not old.inbox_enforced_v6 then
    if old.status = 'pending' and new.status = 'approved' then
      raise exception 'Create a new version and exact Inbox request for this legacy pending magnet.'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2'
    or not (coalesce(public.is_admin(),false)
      or coalesce(auth.uid() = public.active_video_approval_manager(old.client_id),false))
    or (new.status in ('approved','rejected') and new.decided_by is distinct from auth.uid()) then
    raise exception 'A provisioned AAL2 decision owner must decide this magnet.'
      using errcode = '42501';
  end if;
  select * into r from public.approval_requests_v6
    where source_system = 'aa_console' and source_kind = 'lead_magnet'
      and source_id = old.id::text and source_version = old.payload_hash
      and client_id = old.client_id for update;
  if not found then
    raise exception 'The exact Inbox request is missing.' using errcode = '23514';
  end if;
  v_state := public.lead_magnet_source_state_v6(r.id);
  if old.status = 'pending' and new.status = 'approved' then
    if v_state <> 'pending' or not exists (
      select 1 from public.approval_inbox_v6 i
      where i.id = r.id and i.status = 'pending' and i.preview_blocker is null
        and i.artifact_hash = old.payload_hash
    ) then
      raise exception 'The current exact magnet is not approval-ready.' using errcode = '23514';
    end if;
  elsif old.status = 'pending' and new.status = 'rejected' then
    if v_state not in ('pending','source_held') or
      nullif(btrim(coalesce(new.rejection_reason,'')),'') is null then
      raise exception 'This magnet cannot be rejected without a reason.' using errcode = '23514';
    end if;
  elsif old.status = 'approved' and new.status = 'revoked' then
    if nullif(btrim(coalesce(new.revoked_reason,'')),'') is null or not exists (
      select 1 from public.approval_decision_events_v6 d
      where d.request_id = r.id and d.decision = 'approved'
        and d.actor_aal = 'aal2' and d.artifact_hash = old.payload_hash
        and d.source_decision_ref = 'lead_magnet_approvals:' || old.id::text || ':approved'
    ) then
      raise exception 'Only the exact AAL2 approval may be revoked.' using errcode = '23514';
    end if;
  else
    raise exception 'Unsupported magnet approval transition.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger lead_magnet_inbox_decision_guard_v6
  before update of status on public.lead_magnet_approvals
  for each row execute function public.guard_lead_magnet_inbox_decision_v6();

create function public.record_lead_magnet_inbox_decision_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
begin
  if not old.inbox_enforced_v6 or new.status = old.status then return new; end if;
  select * into r from public.approval_requests_v6
    where source_system = 'aa_console' and source_kind = 'lead_magnet'
      and source_id = new.id::text and source_version = new.payload_hash
      and client_id = new.client_id;
  perform public.record_approval_decision_v6(
    r.id,new.status,new.payload_hash,
    'lead_magnet_approvals:' || new.id::text || ':' || new.status,
    case when new.status = 'rejected' then new.rejection_reason
      when new.status = 'revoked' then new.revoked_reason else null end);
  return new;
end $$;
create trigger lead_magnet_inbox_decision_record_v6
  after update of status on public.lead_magnet_approvals
  for each row execute function public.record_lead_magnet_inbox_decision_v6();
revoke all on function public.guard_lead_magnet_inbox_decision_v6()
  from public,anon,authenticated,service_role;
revoke all on function public.record_lead_magnet_inbox_decision_v6()
  from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
