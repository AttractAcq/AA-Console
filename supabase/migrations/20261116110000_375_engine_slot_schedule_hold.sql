-- A blocked Engine preview is not permission to approve its asset and create
-- a scheduled post. Keep the existing atomic slot transaction, but require
-- its exact AAL2 Inbox decision before the scheduled transition can commit.
-- The source remains held until trusted media, rights and account evidence
-- can be attached by an owning Engine decision adapter.
begin;
create function public.guard_engine_slot_schedule_inbox_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_entry public.slot_events%rowtype;
  v_request public.approval_requests_v6%rowtype;
  v_decision public.approval_decision_events_v6%rowtype;
  v_hash text;
begin
  if old.stage::text <> 'awaiting_approval'
    or new.stage::text <> 'scheduled' then return new; end if;
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 human must approve the Engine slot in Approval Inbox.'
      using errcode = '42501';
  end if;
  select * into v_entry from public.slot_events
    where slot_id=old.id and to_stage::text='awaiting_approval';
  if not found or (select count(*) from public.slot_events
    where slot_id=old.id and to_stage::text='awaiting_approval') <> 1 then
    raise exception 'The Engine approval entry is not uniquely verified.'
      using errcode = '23514';
  end if;
  select * into v_request from public.approval_requests_v6
    where client_id=old.client_id and source_system='aa_console'
      and source_kind='engine_slot' and source_id=old.id::text
      and source_version=v_entry.id::text;
  if v_request.id is null
    or public.approval_source_state_v6(v_request.id) <> 'pending'
    or not public.can_review_approval_request_v6(old.client_id,v_request.owner_role) then
    raise exception 'The exact Engine slot request is unavailable.'
      using errcode = '23514';
  end if;
  select coalesce(e.artifact_hash,v_request.artifact_hash) into v_hash
    from public.approval_request_evidence_v6 e
    right join public.approval_requests_v6 r on r.id=e.request_id
    where r.id=v_request.id;
  select * into v_decision from public.approval_decision_events_v6
    where request_id=v_request.id order by event_order desc limit 1;
  if v_hash is null or v_decision.decision is distinct from 'approved'
    or v_decision.actor_aal is distinct from 'aal2'
    or v_decision.actor_id is distinct from auth.uid()
    or v_decision.artifact_hash is distinct from v_hash
    or v_decision.source_decision_ref is distinct from
      'engine_slot:'||v_entry.id::text
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=v_request.id and i.status='approved'
        and i.preview_blocker is null)
    or exists(select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id=v_request.id) then
    raise exception 'Review this exact Engine slot in Approval Inbox before scheduling.'
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_engine_slot_schedule_inbox_v6()
  from public,anon,authenticated,service_role;
create trigger engine_slot_schedule_inbox_guard_v6
  before update of stage on public.content_slots
  for each row execute function public.guard_engine_slot_schedule_inbox_v6();
select public.lock_down_definer_functions();
commit;
