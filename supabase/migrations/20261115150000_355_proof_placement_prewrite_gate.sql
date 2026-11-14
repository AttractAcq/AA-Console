-- Recheck the exact approval and current rights at the point a placement is
-- claimed or manually marked placed. A historic approved row is insufficient.
begin;
create function public.proof_placement_effect_allowed_v6(p_placement_id uuid)
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

create function public.mark_proof_placement_placed_inbox_v6(
  p_placement_id uuid,p_external_url text)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if auth.role() <> 'authenticated' or not public.proof_placement_effect_allowed_v6(p_placement_id) then
    raise exception 'Current rights, switches and exact Inbox approval are required before placement.'
      using errcode = '42501'; end if;
  perform public.mark_proof_placement_placed_v6(p_placement_id,p_external_url);
end $$;
revoke execute on function public.mark_proof_placement_placed_v6(uuid,text)
  from authenticated;
revoke all on function public.proof_placement_effect_allowed_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.proof_placement_effect_allowed_v6(uuid)
  to authenticated,service_role;
revoke all on function public.mark_proof_placement_placed_inbox_v6(uuid,text)
  from public,anon,service_role;
grant execute on function public.mark_proof_placement_placed_inbox_v6(uuid,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;
