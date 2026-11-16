-- A signoff row is written only by the matching AAL2 Inbox event.
begin;
create function public.guard_proof_artifact_inbox_signoff_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare q public.proof_artifact_review_requests_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if tg_op <> 'INSERT' then return new; end if;
  if auth.role() <> 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2'
    or new.approved_by is distinct from auth.uid()
    or new.approved_request_id is null then
    raise exception 'Sign off this proof artifact in Approval Inbox.' using errcode = '42501'; end if;
  select * into r from public.approval_requests_v6 where id = new.approved_request_id
    and client_id = new.client_id and source_system = 'aa_console'
    and source_kind = 'proof_artifact';
  if r.id is null then raise exception 'Artifact review request is unavailable.'
    using errcode = '23514'; end if;
  select * into q from public.proof_artifact_review_requests_v6
    where id::text = r.source_id and canonical_request_id = r.id
      and artifact_version_id = new.artifact_version_id and client_id = new.client_id;
  h := public.proof_artifact_review_hash_v6(q);
  select * into d from public.approval_decision_events_v6
    where request_id = r.id order by event_order desc limit 1;
  if q.id is null or r.artifact_hash is distinct from h
    or new.approved_content_hash is distinct from h
    or d.decision is distinct from 'approved' or d.actor_id is distinct from auth.uid()
    or d.actor_aal <> 'aal2' or d.artifact_hash is distinct from h
    or d.source_decision_ref is distinct from 'proof_artifact:' || q.id::text ||
      ':' || q.request_token::text
    or public.proof_artifact_review_source_state_v6(r.id) <> 'pending'
    or not exists (select 1 from public.approval_inbox_v6 i where i.id = r.id
      and i.status = 'approved' and i.preview_blocker is null) then
    raise exception 'The source differs from the exact artifact decision.' using errcode = '23514'; end if;
  return new;
end $$;
create trigger proof_artifact_inbox_signoff_guard_v6
  before insert on public.proof_artifact_signoffs for each row
  execute function public.guard_proof_artifact_inbox_signoff_v6();

create function public.approve_proof_artifact_inbox_v6(
  p_review_id uuid,p_request_id uuid)
returns public.proof_artifact_signoffs language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare q public.proof_artifact_review_requests_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  s public.proof_artifact_signoffs%rowtype;
  h text;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 human must sign off proof claims.' using errcode = '42501'; end if;
  select * into q from public.proof_artifact_review_requests_v6 where id = p_review_id for update;
  if q.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(q.client_id),false)) then
    raise exception 'The artifact or decision owner is unavailable.' using errcode = '42501'; end if;
  h := public.proof_artifact_review_hash_v6(q);
  select * into r from public.approval_requests_v6 where id = p_request_id
    and id = q.canonical_request_id and client_id = q.client_id
    and source_system = 'aa_console' and source_kind = 'proof_artifact'
    and source_id = q.id::text and artifact_hash = h;
  if r.id is null or public.proof_artifact_review_source_state_v6(r.id) <> 'pending'
    or not exists (select 1 from public.approval_inbox_v6 i where i.id = r.id
      and i.status = 'pending' and i.preview_blocker is null) then
    raise exception 'Review the current source and claim in Approval Inbox.'
      using errcode = '23514'; end if;
  perform public.record_approval_decision_v6(r.id,'approved',h,
    'proof_artifact:' || q.id::text || ':' || q.request_token::text);
  insert into public.proof_artifact_signoffs
    (artifact_version_id,client_id,approved_by,approved_request_id,approved_content_hash)
    values (q.artifact_version_id,q.client_id,auth.uid(),r.id,h)
    returning * into s;
  return s;
end $$;

create function public.reject_proof_artifact_inbox_v6(
  p_review_id uuid,p_request_id uuid,p_reason text)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare q public.proof_artifact_review_requests_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A rejection reason is required.' using errcode = '22023'; end if;
  select * into q from public.proof_artifact_review_requests_v6 where id = p_review_id for update;
  if q.id is null then raise exception 'Artifact review not found.' using errcode = '23514'; end if;
  h := public.proof_artifact_review_hash_v6(q);
  select * into r from public.approval_requests_v6 where id = p_request_id
    and id = q.canonical_request_id and client_id = q.client_id
    and source_kind = 'proof_artifact' and source_id = q.id::text
    and artifact_hash = h;
  if r.id is null or public.proof_artifact_review_source_state_v6(r.id) <> 'pending'
    then raise exception 'This artifact is no longer reviewable.' using errcode = '23514'; end if;
  return public.record_approval_decision_v6(r.id,'rejected',h,
    'proof_artifact_rejection:' || q.id::text || ':' || q.request_token::text,p_reason);
end $$;

create function public.proof_artifact_signoff_current_v6(p_artifact_version_id uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare s public.proof_artifact_signoffs%rowtype;
  q public.proof_artifact_review_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if auth.role() not in ('authenticated','service_role') then return false; end if;
  select * into s from public.proof_artifact_signoffs
    where artifact_version_id = p_artifact_version_id;
  if s.artifact_version_id is null or s.approved_request_id is null
    or (auth.role() = 'authenticated' and not public.can_access_client(s.client_id))
    then return false; end if;
  select * into q from public.proof_artifact_review_requests_v6
    where canonical_request_id = s.approved_request_id
      and artifact_version_id = s.artifact_version_id and client_id = s.client_id;
  if q.id is null then return false; end if;
  h := public.proof_artifact_review_hash_v6(q);
  select * into d from public.approval_decision_events_v6
    where request_id = s.approved_request_id order by event_order desc limit 1;
  return s.approved_content_hash = h and q.artifact_hash = h
    and public.proof_artifact_review_source_state_v6(s.approved_request_id) = 'source_decided'
    and d.decision = 'approved' and d.actor_aal = 'aal2'
    and d.artifact_hash = h
    and d.source_decision_ref = 'proof_artifact:' || q.id::text || ':' || q.request_token::text
    and exists (select 1 from public.approval_inbox_v6 i
      where i.id = s.approved_request_id and i.status = 'approved'
        and i.preview_blocker is null);
end $$;

revoke all on function public.guard_proof_artifact_inbox_signoff_v6()
  from public,anon,authenticated,service_role;
revoke execute on function public.approve_proof_artifact_v6(uuid) from authenticated;
revoke all on function public.approve_proof_artifact_inbox_v6(uuid,uuid)
  from public,anon,service_role;
grant execute on function public.approve_proof_artifact_inbox_v6(uuid,uuid) to authenticated;
revoke all on function public.reject_proof_artifact_inbox_v6(uuid,uuid,text)
  from public,anon,service_role;
grant execute on function public.reject_proof_artifact_inbox_v6(uuid,uuid,text) to authenticated;
revoke all on function public.proof_artifact_signoff_current_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.proof_artifact_signoff_current_v6(uuid)
  to authenticated,service_role;
select public.lock_down_definer_functions();
commit;
