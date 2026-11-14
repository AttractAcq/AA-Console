-- Standalone proof placement needs its own exact Inbox decision. Campaign
-- placements continue to use their campaign-action request and executor.
begin;
alter table public.proof_placement_approvals
  add column request_token uuid,
  add column canonical_request_id uuid references public.approval_requests_v6(id);
create unique index proof_placement_canonical_request_v6
  on public.proof_placement_approvals(canonical_request_id)
  where canonical_request_id is not null;

create function public.proof_placement_preview_v6(p_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'client_id',a.client_id,'approval_id',a.id,'placement_id',p.id,
    'request_token',a.request_token,'destination_key',p.destination_key,
    'destination_mode',d.mode,'destination_account',cd.account_ref,
    'placement_payload_hash',p.payload_hash,'scope',a.scope,
    'source_proof',to_jsonb(s) - array['updated_at'],
    'payload_proof',case when p.proof_id is not null then to_jsonb(s) else null end,
    'artifact',case when p.artifact_version_id is not null then to_jsonb(v) else null end,
    'media',case when p.asset_id is not null then to_jsonb(m) else null end,
    'consequence','Releases this exact proof to the named destination; placement is a later, separately receipted action')
  from public.proof_placement_approvals a
  join public.proof_placements p on p.id = a.placement_id and p.client_id = a.client_id
  join public.proof_destinations d on d.destination_key = p.destination_key
  join public.client_proof_assets s on s.id = p.source_proof_id and s.client_id = p.client_id
  left join public.client_proof_destinations cd on cd.client_id = p.client_id
    and cd.destination_key = p.destination_key
  left join public.proof_artifact_versions v on v.id = p.artifact_version_id
  left join public.client_media_assets m on m.id = p.asset_id
  where a.id = p_id;
$$;
create function public.proof_placement_hash_v6(p_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    (public.proof_placement_preview_v6(p_id) - 'request_token')::text,'UTF8')),'hex');
$$;
create function public.proof_placement_scope_v6(p_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object('client_id',a.client_id,'placement_id',a.placement_id,
    'approval_id',a.id,'request_token',a.request_token,
    'destination_key',a.destination_key,'content_hash',public.proof_placement_hash_v6(a.id),
    'effect','release_for_placement')
  from public.proof_placement_approvals a where a.id = p_id;
$$;
create function public.proof_placement_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  a public.proof_placement_approvals%rowtype;
  p public.proof_placements%rowtype;
  s public.client_proof_assets%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id = p_request_id;
  if r.id is null or r.source_system <> 'aa_console' or r.source_kind <> 'proof_placement'
    or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into a from public.proof_placement_approvals
    where id = r.source_id::uuid and client_id = r.client_id
      and canonical_request_id = r.id and campaign_action_approval_id is null;
  if a.id is null then return 'cancelled'; end if;
  select * into p from public.proof_placements
    where id = a.placement_id and client_id = a.client_id and approval_id = a.id;
  if p.id is null then return 'cancelled'; end if;
  select * into s from public.client_proof_assets
    where id = p.source_proof_id and client_id = p.client_id;
  if s.id is null then return 'cancelled'; end if;
  h := public.proof_placement_hash_v6(a.id);
  if a.request_token is null or r.artifact_hash is distinct from h
    or r.source_version is distinct from h || ':' || a.request_token::text
    or r.preview is distinct from public.proof_placement_preview_v6(a.id)
    or r.scope is distinct from public.proof_placement_scope_v6(a.id)
    or r.destination is distinct from 'proof_distribution:' || p.destination_key || ':' || p.id::text
    or a.payload_hash is distinct from p.payload_hash
    or p.payload_hash is distinct from public.proof_placement_payload_hash_v6(
      p.artifact_version_id,p.proof_id,p.asset_id,p.destination_key)
    then return 'superseded'; end if;
  -- Media and derived artifacts need a trusted byte/version attestation.
  -- Legacy proof clearances are held until their rights are reviewed.
  if p.proof_id is null or s.media_type <> 'text' or s.storage_path is not null
    or s.usage_rights <> 'approved' or s.approved_rights_request_id is null
    or public.proof_rights_source_state_v6(s.approved_rights_request_id) <> 'source_decided'
    or not exists (select 1 from public.approval_inbox_v6 i
      where i.id = s.approved_rights_request_id and i.status = 'approved')
    or (s.expires_on is not null and s.expires_on < current_date)
    then return 'source_held'; end if;
  if a.status = 'approved' and p.status in ('approved','queued','placing',
    'awaiting_manual_placement','bound','placed','verified') then return 'source_decided'; end if;
  if a.status = 'rejected' then return 'source_decided'; end if;
  if a.status <> 'pending' or p.status <> 'awaiting_approval'
    then return 'source_held'; end if;
  return 'pending';
end $$;

create function public.request_proof_placement_inbox_v6(p_placement_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare p public.proof_placements%rowtype;
  a public.proof_placement_approvals%rowtype;
  h text;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must request placement review.' using errcode = '42501'; end if;
  select * into p from public.proof_placements where id = p_placement_id for update;
  if p.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(p.client_id),false)) then
    raise exception 'The placement or decision owner is unavailable.' using errcode = '42501'; end if;
  if p.status <> 'drafted' then
    select * into a from public.proof_placement_approvals where id = p.approval_id;
    if a.id is not null and a.canonical_request_id is not null
      and public.proof_placement_source_state_v6(a.canonical_request_id) = 'pending'
      and exists (select 1 from public.approval_inbox_v6 i
        where i.id = a.canonical_request_id and i.status = 'pending')
      then return a.canonical_request_id; end if;
    raise exception 'Draft a new placement for a new review.' using errcode = '23514';
  end if;
  perform public.request_proof_placement_approval_v6(p.id);
  select * into a from public.proof_placement_approvals where id = (
    select approval_id from public.proof_placements where id = p.id) for update;
  update public.proof_placement_approvals set request_token = gen_random_uuid()
    where id = a.id returning * into a;
  h := public.proof_placement_hash_v6(a.id);
  a.canonical_request_id := public.register_approval_request_v6(jsonb_build_object(
    'client_id',a.client_id,'source_system','aa_console',
    'source_kind','proof_placement','source_id',a.id::text,
    'source_version',h || ':' || a.request_token::text,
    'title','Place proof at ' || a.destination_key,
    'artifact_hash',h,'preview',public.proof_placement_preview_v6(a.id),
    'destination','proof_distribution:' || a.destination_key || ':' || p.id::text,
    'scope',public.proof_placement_scope_v6(a.id),
    'owner_role','admin_or_active_client_manager',
    'requested_by',auth.uid(),'requester_kind','human',
    'expires_at',now() + interval '7 days',
    'owning_path','/clients/' || p.client_id::text ||
      '/delivery/proof-distribution?tab=placements'));
  update public.proof_placement_approvals set canonical_request_id = a.canonical_request_id
    where id = a.id;
  return a.canonical_request_id;
end $$;

-- The old direct request may create an orphan pending row if called by a
-- stale client, but no direct decision can grant or reject it.
revoke execute on function public.request_proof_placement_approval_v6(uuid,jsonb)
  from authenticated;

create function public.guard_standalone_proof_placement_decision_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if old.canonical_request_id is not null and
    (new.canonical_request_id,new.request_token) is distinct from
      (old.canonical_request_id,old.request_token) then
    raise exception 'Placement request identity is immutable.' using errcode = '23514'; end if;
  if old.status <> 'pending' or new.status = 'pending' then return new; end if;
  if old.campaign_action_approval_id is not null then
    if auth.role() <> 'service_role' then
      raise exception 'Campaign proof placement is released by its action executor.'
        using errcode = '42501'; end if;
    return new;
  end if;
  if auth.role() <> 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2'
    or new.canonical_request_id is distinct from old.canonical_request_id
    or old.canonical_request_id is null then
    raise exception 'Decide standalone proof placement in Approval Inbox.' using errcode = '42501'; end if;
  select * into r from public.approval_requests_v6 where id = old.canonical_request_id
    and client_id = old.client_id and source_kind = 'proof_placement'
    and source_id = old.id::text;
  h := public.proof_placement_hash_v6(old.id);
  select * into d from public.approval_decision_events_v6
    where request_id = r.id order by event_order desc limit 1;
  if r.id is null or r.artifact_hash is distinct from h
    or d.decision is distinct from new.status or d.actor_id is distinct from auth.uid()
    or d.actor_aal <> 'aal2' or d.artifact_hash is distinct from h
    or d.source_decision_ref is distinct from 'proof_placement:' || old.id::text ||
      ':' || old.request_token::text
    or public.proof_placement_source_state_v6(r.id) <> 'pending'
    or not exists (select 1 from public.approval_inbox_v6 i where i.id = r.id
      and i.status = new.status and i.preview_blocker is null) then
    raise exception 'The current placement differs from the exact decision.' using errcode = '23514'; end if;
  return new;
end $$;
create trigger standalone_proof_placement_decision_guard_v6
  before update on public.proof_placement_approvals for each row
  execute function public.guard_standalone_proof_placement_decision_v6();

create function public.decide_proof_placement_inbox_v6(
  p_approval_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns public.proof_placements language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare a public.proof_placement_approvals%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 human must decide this placement.' using errcode = '42501'; end if;
  select * into a from public.proof_placement_approvals where id = p_approval_id for update;
  if a.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(a.client_id),false)) then
    raise exception 'The placement or decision owner is unavailable.' using errcode = '42501'; end if;
  h := public.proof_placement_hash_v6(a.id);
  select * into r from public.approval_requests_v6 where id = p_request_id
    and id = a.canonical_request_id and client_id = a.client_id
    and source_system = 'aa_console' and source_kind = 'proof_placement'
    and source_id = a.id::text and artifact_hash = h;
  if a.id is null or a.campaign_action_approval_id is not null or r.id is null
    or public.proof_placement_source_state_v6(r.id) <> 'pending'
    or not exists (select 1 from public.approval_inbox_v6 i
      where i.id = r.id and i.status = 'pending' and i.preview_blocker is null) then
    raise exception 'Review the current exact placement in Approval Inbox.' using errcode = '23514'; end if;
  if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A rejection reason is required.' using errcode = '22023'; end if;
  perform public.record_approval_decision_v6(r.id,
    case when p_approved then 'approved' else 'rejected' end,h,
    'proof_placement:' || a.id::text || ':' || a.request_token::text,p_reason);
  return public.decide_proof_placement_approval_v6(a.id,p_approved,p_reason);
end $$;

revoke all on function public.proof_placement_preview_v6(uuid) from public,anon,authenticated,service_role;
revoke all on function public.proof_placement_hash_v6(uuid) from public,anon,authenticated,service_role;
revoke all on function public.proof_placement_scope_v6(uuid) from public,anon,authenticated,service_role;
revoke all on function public.proof_placement_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.proof_placement_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_proof_placement_inbox_v6(uuid) from public,anon,service_role;
grant execute on function public.request_proof_placement_inbox_v6(uuid) to authenticated;
revoke all on function public.guard_standalone_proof_placement_decision_v6() from public,anon,authenticated,service_role;
revoke all on function public.decide_proof_placement_inbox_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_proof_placement_inbox_v6(uuid,uuid,boolean,text) to authenticated;
select public.lock_down_definer_functions();
commit;
