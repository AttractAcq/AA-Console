-- A rights grant is written only by its exact AAL2 Inbox decision. Protective
-- restrictions remain immediate and retain the historical rights audit.
begin;
create function public.proof_rights_source_payload_v6(p public.client_proof_assets)
returns jsonb language sql immutable set search_path = pg_catalog, public as $$
  select to_jsonb(p) - array['usage_rights','permission_basis','expires_on',
    'updated_at','approved_rights_request_id','approved_rights_content_hash'];
$$;
create function public.guard_proof_rights_decision_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  q public.proof_rights_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
  source_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.usage_rights = 'approved' or new.approved_rights_request_id is not null
      or new.approved_rights_content_hash is not null then
      raise exception 'New proof starts uncleared and needs an exact rights decision.'
        using errcode = '23514'; end if;
    return new;
  end if;
  source_changed := public.proof_rights_source_payload_v6(new)
    is distinct from public.proof_rights_source_payload_v6(old);
  if old.usage_rights = 'approved' and (source_changed or new.usage_rights <> 'approved') then
    if old.approved_rights_request_id is not null then
      insert into public.proof_rights_revocations_v6
        (canonical_request_id,client_id,proof_id,actor_id,reason)
      values (old.approved_rights_request_id,old.client_id,old.id,auth.uid(),
        case when source_changed then 'Proof source changed after rights clearance.'
          else 'Usage rights were restricted or revoked.' end)
      on conflict do nothing;
    end if;
    new.usage_rights := case when source_changed then 'not_cleared' else new.usage_rights end;
    new.approved_rights_request_id := null;
    new.approved_rights_content_hash := null;
    return new;
  end if;
  if new.usage_rights = 'approved' and (
    old.usage_rights <> 'approved' or new.permission_basis is distinct from old.permission_basis
    or new.expires_on is distinct from old.expires_on
    or new.approved_rights_request_id is distinct from old.approved_rights_request_id) then
    if source_changed or auth.role() <> 'authenticated' or auth.uid() is null
      or public.current_role_of() is null or coalesce(auth.jwt()->>'aal','') <> 'aal2'
      or not (coalesce(public.is_admin(),false)
        or coalesce(auth.uid() = public.active_video_approval_manager(new.client_id),false))
      or new.approved_rights_request_id is null then
      raise exception 'An exact AAL2 Inbox decision must clear this proof.'
        using errcode = '42501'; end if;
    select * into r from public.approval_requests_v6 where id = new.approved_rights_request_id
      and client_id = new.client_id and source_system = 'aa_console'
      and source_kind = 'proof_rights';
    if r.id is null then raise exception 'The rights request is unavailable.' using errcode = '23514'; end if;
    select * into q from public.proof_rights_requests_v6 where id::text = r.source_id
      and canonical_request_id = r.id and proof_id = new.id and client_id = new.client_id;
    if q.id is null then raise exception 'The rights source is unavailable.' using errcode = '23514'; end if;
    h := public.proof_rights_hash_v6(q);
    select * into d from public.approval_decision_events_v6
      where request_id = r.id order by event_order desc limit 1;
    if r.artifact_hash is distinct from h or q.artifact_hash is distinct from h
      or new.approved_rights_content_hash is distinct from h
      or new.permission_basis is distinct from q.requested_basis
      or new.expires_on is distinct from q.requested_expiry
      or d.decision is distinct from 'approved' or d.actor_id is distinct from auth.uid()
      or d.actor_aal <> 'aal2' or d.artifact_hash is distinct from h
      or d.source_decision_ref is distinct from
        'proof_rights:' || new.id::text || ':' || q.request_token::text
      or public.proof_rights_source_state_v6(r.id) <> 'pending'
      or not exists (select 1 from public.approval_inbox_v6 i where i.id = r.id
        and i.status = 'approved' and i.preview_blocker is null) then
      raise exception 'The current proof differs from the exact rights decision.'
        using errcode = '23514'; end if;
  elsif (new.approved_rights_request_id,new.approved_rights_content_hash) is distinct from
      (old.approved_rights_request_id,old.approved_rights_content_hash) then
    raise exception 'Proof rights signatures are source-owned.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger proof_rights_decision_guard_v6 before insert or update
  on public.client_proof_assets for each row
  execute function public.guard_proof_rights_decision_v6();

create function public.approve_proof_rights_v6(p_rights_request_id uuid,p_canonical_id uuid)
returns public.client_proof_assets language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare q public.proof_rights_requests_v6%rowtype;
  p public.client_proof_assets%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 human must clear proof rights.' using errcode = '42501'; end if;
  select * into q from public.proof_rights_requests_v6 where id = p_rights_request_id;
  if q.id is null then raise exception 'Rights request not found.' using errcode = '23514'; end if;
  select * into p from public.client_proof_assets where id = q.proof_id for update;
  if p.id is null or p.client_id <> q.client_id or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(p.client_id),false)) then
    raise exception 'The proof or its decision owner is unavailable.' using errcode = '42501'; end if;
  h := public.proof_rights_hash_v6(q);
  select * into r from public.approval_requests_v6 where id = p_canonical_id
    and id = q.canonical_request_id and source_system = 'aa_console'
    and source_kind = 'proof_rights' and source_id = q.id::text
    and client_id = q.client_id and artifact_hash = h
    and source_version = h || ':' || q.request_token::text;
  if r.id is null or public.proof_rights_source_state_v6(r.id) <> 'pending'
    or not exists (select 1 from public.approval_inbox_v6 i where i.id = r.id
      and i.status = 'pending' and i.preview_blocker is null) then
    raise exception 'Review the current exact proof in Approval Inbox.' using errcode = '23514'; end if;
  perform public.record_approval_decision_v6(r.id,'approved',h,
    'proof_rights:' || p.id::text || ':' || q.request_token::text);
  update public.client_proof_assets set usage_rights = 'approved',
    permission_basis = q.requested_basis, expires_on = q.requested_expiry,
    approved_rights_request_id = r.id, approved_rights_content_hash = h
    where id = p.id returning * into p;
  return p;
end $$;

create function public.reject_proof_rights_v6(
  p_rights_request_id uuid,p_canonical_id uuid,p_reason text)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare q public.proof_rights_requests_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A rejection reason is required.' using errcode = '22023'; end if;
  select * into q from public.proof_rights_requests_v6 where id = p_rights_request_id;
  if q.id is null then raise exception 'Rights request not found.' using errcode = '23514'; end if;
  h := public.proof_rights_hash_v6(q);
  select * into r from public.approval_requests_v6 where id = p_canonical_id
    and id = q.canonical_request_id and source_kind = 'proof_rights'
    and source_id = q.id::text and client_id = q.client_id and artifact_hash = h;
  if r.id is null or public.proof_rights_source_state_v6(r.id)
    not in ('pending','source_held') then
    raise exception 'This proof rights request is no longer reviewable.' using errcode = '23514'; end if;
  return public.record_approval_decision_v6(r.id,'rejected',h,
    'proof_rights_rejection:' || q.id::text,p_reason);
end $$;

revoke all on function public.proof_rights_source_payload_v6(public.client_proof_assets) from public,anon,authenticated,service_role;
revoke all on function public.guard_proof_rights_decision_v6() from public,anon,authenticated,service_role;
revoke all on function public.approve_proof_rights_v6(uuid,uuid) from public,anon,service_role;
grant execute on function public.approve_proof_rights_v6(uuid,uuid) to authenticated;
revoke all on function public.reject_proof_rights_v6(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.reject_proof_rights_v6(uuid,uuid,text) to authenticated;
select public.lock_down_definer_functions();
commit;
