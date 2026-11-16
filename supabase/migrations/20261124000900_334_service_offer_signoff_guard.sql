-- The signoff row is the downstream permission to use an offer in a campaign.
-- New rows must be the result of the same exact AAL2 Inbox decision, even if
-- a privileged caller attempts to bypass the owning RPC.
begin;
create function public.guard_service_offer_signoff_inbox_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_version public.service_offer_versions%rowtype;
  v_request public.approval_requests_v6%rowtype;
  v_decision public.approval_decision_events_v6%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or new.approved_by is distinct from auth.uid()
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 human must sign off this offer.'
      using errcode = '42501';
  end if;
  select * into v_version from public.service_offer_versions
    where id = new.offer_version_id and client_id = new.client_id;
  if not found or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(new.client_id),false)) then
    raise exception 'The offer version or its decision owner does not match.'
      using errcode = '42501';
  end if;
  select * into v_request from public.approval_requests_v6 r
    where r.source_system = 'aa_console' and r.source_kind = 'service_offer'
      and r.source_id = v_version.id::text
      and r.source_version = v_version.content_hash
      and r.client_id = v_version.client_id;
  if not found or public.service_offer_source_state_v6(v_request.id) <> 'pending'
    or not exists (select 1 from public.approval_inbox_v6 i where i.id = v_request.id
      and i.status = 'approved' and i.preview_blocker is null
      and i.artifact_hash = v_version.content_hash) then
    raise exception 'The current exact offer has no approved Inbox decision.'
      using errcode = '23514';
  end if;
  select * into v_decision from public.approval_decision_events_v6 d
    where d.request_id = v_request.id order by d.event_order desc limit 1;
  if not found or v_decision.decision <> 'approved'
    or v_decision.actor_id is distinct from new.approved_by
    or v_decision.actor_aal <> 'aal2'
    or v_decision.artifact_hash is distinct from v_version.content_hash
    or v_decision.source_decision_ref is distinct from
      'service_offer_signoff:' || v_version.id::text then
    raise exception 'The signoff does not match the exact AAL2 decision.'
      using errcode = '23514';
  end if;
  return new;
end $$;
create trigger service_offer_signoff_inbox_v6
  before insert on public.service_offer_signoffs
  for each row execute function public.guard_service_offer_signoff_inbox_v6();
revoke all on function public.guard_service_offer_signoff_inbox_v6()
  from public,anon,authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
  (12,3,'service_offer','Service offer signoff',
    'verified','327 exact version request, preview and live source checks',
    'verified','327 AAL2 canonical decision and source signoff in one transaction',
    'verified','333 signoff insert guard; 210 campaign offer binding and capture require signoff',
    null);
select public.lock_down_definer_functions();
commit;
