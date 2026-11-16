-- Text artifacts may enter placement only with a current exact source signoff.
begin;
create or replace function public.proof_placement_source_state_v6(p_request_id uuid)
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
  if (p.proof_id is not null and (s.media_type <> 'text' or s.storage_path is not null))
    or (p.artifact_version_id is not null and not
      public.proof_artifact_signoff_current_v6(p.artifact_version_id))
    or p.asset_id is not null
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

create or replace function public.proof_placement_effect_allowed_v6(p_placement_id uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare p public.proof_placements%rowtype;
  a public.proof_placement_approvals%rowtype;
  s public.client_proof_assets%rowtype;
begin
  if auth.role() not in ('authenticated','service_role') then return false; end if;
  select * into p from public.proof_placements where id = p_placement_id;
  if p.id is null or (auth.role() = 'authenticated'
    and not public.can_access_client(p.client_id)) then return false; end if;
  select * into a from public.proof_placement_approvals where id = p.approval_id
    and placement_id = p.id and client_id = p.client_id;
  select * into s from public.client_proof_assets where id = p.source_proof_id
    and client_id = p.client_id;
  if a.id is null or a.status <> 'approved' or s.id is null
    or (p.proof_id is not null and s.media_type <> 'text')
    or p.asset_id is not null
    or (p.artifact_version_id is not null and not
      public.proof_artifact_signoff_current_v6(p.artifact_version_id))
    or a.destination_key <> p.destination_key or a.payload_hash <> p.payload_hash
    or p.payload_hash is distinct from public.proof_placement_payload_hash_v6(
      p.artifact_version_id,p.proof_id,p.asset_id,p.destination_key)
    or s.usage_rights <> 'approved' or nullif(btrim(s.permission_basis),'') is null
    or (s.expires_on is not null and s.expires_on < current_date)
    or s.approved_rights_request_id is null
    or public.proof_rights_source_state_v6(s.approved_rights_request_id) <> 'source_decided'
    or not exists (select 1 from public.approval_inbox_v6 i
      where i.id = s.approved_rights_request_id and i.status = 'approved')
    or not exists (select 1 from public.client_engine_settings e
      where e.client_id = p.client_id and e.proof_publishing_enabled)
    or not exists (select 1 from public.client_proof_destinations d
      where d.client_id = p.client_id and d.destination_key = p.destination_key
        and d.enabled)
    or not exists (select 1 from public.proof_destinations d
      where d.destination_key = p.destination_key and d.supported
        and (not d.requires_integration or public.integration_usable(p.client_id,d.provider)))
    then return false; end if;
  if a.campaign_action_approval_id is not null then
    return exists (select 1 from public.approval_requests_v6 r
      join public.approval_inbox_v6 i on i.id = r.id
      where r.source_system = 'aa_console' and r.source_kind = 'campaign_action'
        and r.source_id = a.campaign_action_approval_id::text
        and r.client_id = p.client_id and i.status = 'approved'
        and i.preview_blocker is null);
  end if;
  return a.canonical_request_id is not null
    and public.proof_placement_source_state_v6(a.canonical_request_id) = 'source_decided'
    and exists (select 1 from public.approval_inbox_v6 i
      join lateral (select d.decision,d.actor_aal from public.approval_decision_events_v6 d
        where d.request_id = i.id order by d.event_order desc limit 1) d on true
      where i.id = a.canonical_request_id and i.status = 'approved'
        and i.preview_blocker is null and d.decision = 'approved'
        and d.actor_aal = 'aal2');
end $$;

select public.lock_down_definer_functions();
commit;
