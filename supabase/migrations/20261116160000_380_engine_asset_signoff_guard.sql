-- An Engine asset cannot acquire human approval through the old direct media
-- review path while its slot is waiting. The owning Inbox RPC records its
-- exact event first, then approve_slot signs the asset in that transaction.
begin;
create function public.guard_engine_asset_human_signoff_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare s public.content_slots%rowtype;
  r public.approval_requests_v6%rowtype;
  e public.approval_request_evidence_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
begin
  if new.human_approved_at is null
    or new.human_approved_at is not distinct from old.human_approved_at
    then return new; end if;
  select * into s from public.content_slots
    where asset_id=new.id and client_id=new.client_id
      and stage::text='awaiting_approval';
  if s.id is null then return new; end if;
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2'
    or (select count(*) from public.content_slots
      where asset_id=new.id and client_id=new.client_id
        and stage::text='awaiting_approval')<>1 then
    raise exception 'A provisioned AAL2 reviewer must approve this exact Engine asset in Approval Inbox.'
      using errcode='42501'; end if;
  select * into r from public.approval_requests_v6
    where client_id=s.client_id and source_system='aa_console'
      and source_kind='engine_slot' and source_id=s.id::text
      and source_version=(select se.id::text from public.slot_events se
        where se.slot_id=s.id and se.to_stage::text='awaiting_approval'
        limit 1);
  select * into e from public.approval_request_evidence_v6
    where request_id=r.id;
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  if r.id is null or e.id is null
    or public.engine_slot_exact_source_state_v6(r.id)<>'pending'
    or d.decision is distinct from 'approved'
    or d.actor_aal is distinct from 'aal2'
    or d.actor_id is distinct from auth.uid()
    or d.artifact_hash is distinct from e.artifact_hash
    or d.source_decision_ref is distinct from 'engine_slot:'||r.source_version
    then raise exception 'Approve this exact Engine asset in Approval Inbox.'
      using errcode='42501'; end if;
  return new;
end $$;
revoke all on function public.guard_engine_asset_human_signoff_v6()
  from public,anon,authenticated,service_role;
create trigger engine_asset_human_signoff_guard_v6
  before update of human_approved_at on public.client_media_assets
  for each row execute function public.guard_engine_asset_human_signoff_v6();
select public.lock_down_definer_functions();
commit;
