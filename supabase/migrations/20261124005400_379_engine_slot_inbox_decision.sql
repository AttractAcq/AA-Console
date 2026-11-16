-- One exact AAL2 decision owns the existing approve_slot transaction.
begin;
create function public.decide_engine_slot_inbox_v6(
  p_slot_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare s public.content_slots%rowtype;
  r public.approval_requests_v6%rowtype;
  e public.approval_request_evidence_v6%rowtype;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A provisioned AAL2 human must decide the Engine slot.'
      using errcode='42501'; end if;
  if p_approved is null or (not p_approved
    and nullif(btrim(coalesce(p_reason,'')),'') is null) then
    raise exception 'A decision and rejection reason are required.'
      using errcode='22023'; end if;
  select * into s from public.content_slots where id=p_slot_id for update;
  if s.id is null or s.stage::text<>'awaiting_approval' then
    raise exception 'Engine slot is no longer awaiting review.'
      using errcode='23514'; end if;
  select * into r from public.approval_requests_v6
    where id=p_request_id and client_id=s.client_id
      and source_system='aa_console' and source_kind='engine_slot'
      and source_id=s.id::text for update;
  if r.id is null or not public.can_review_approval_request_v6(s.client_id,r.owner_role)
    then raise exception 'The exact Engine request or reviewer is unavailable.'
      using errcode='42501'; end if;
  -- Freeze the rows consulted by the live package check through the source
  -- transition; a concurrent edit cannot change the reviewed bytes or copy.
  perform 1 from public.client_media_assets where id=s.asset_id for update;
  perform 1 from storage.objects o join public.client_media_assets a
    on o.bucket_id='client-media' and o.name=a.storage_path
    where a.id=s.asset_id for share of o;
  perform 1 from public.post_copy where asset_id=s.asset_id for share;
  perform 1 from public.client_integrations i
    where i.client_id=s.client_id and i.provider in ('meta','instagram')
    for share;
  select * into e from public.approval_request_evidence_v6
    where request_id=r.id;
  if e.id is null or public.engine_slot_exact_source_state_v6(r.id)<>'pending'
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=r.id and i.status='pending' and i.preview_blocker is null)
    then raise exception 'Review the current exact Engine package in Approval Inbox.'
      using errcode='23514'; end if;
  perform public.record_approval_decision_v6(r.id,
    case when p_approved then 'approved' else 'rejected' end,
    e.artifact_hash,
    case when p_approved then 'engine_slot:' else 'engine_slot_rejection:' end
      ||r.source_version,p_reason);
  if p_approved then
    perform public.approve_slot(s.id);
  else
    perform public.reject_slot(s.id,p_reason);
  end if;
  return s.id;
end $$;
revoke all on function public.decide_engine_slot_inbox_v6(uuid,uuid,boolean,text)
  from public,anon,service_role;
grant execute on function public.decide_engine_slot_inbox_v6(uuid,uuid,boolean,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;
