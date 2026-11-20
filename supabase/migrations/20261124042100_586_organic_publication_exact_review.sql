-- Allow exact human review of the frozen organic publication package.
-- This does not release the publisher: its prewrite RPC and claim remain held
-- until the separate byte-bound execution and provider preflight contract.
begin;
create or replace function public.organic_publication_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_package public.organic_publication_packages_v6%rowtype;
  v_live jsonb;
  v_live_hash text;
begin
  select * into v_request from public.approval_requests_v6 where id = p_request_id;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'organic_publication' then
    return 'unverified';
  end if;
  if auth.role() is distinct from 'service_role'
    and (auth.role() is distinct from 'authenticated'
      or not coalesce(public.can_review_approval_request_v6(
        v_request.client_id, v_request.owner_role), false)) then
    return 'unverified';
  end if;
  if v_request.source_id !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into v_package from public.organic_publication_packages_v6
    where id = v_request.source_id::uuid;
  if not found then return 'cancelled'; end if;
  if v_request.client_id is distinct from v_package.client_id
    or v_request.owner_role is distinct from 'client_media_reviewer'
    or v_request.requester_kind is distinct from 'service'
    or v_request.requester_ref is distinct from
      ('organic_publication_packages_v6:' || v_package.id::text)
    or v_request.source_version is distinct from v_package.artifact_hash
    or v_request.artifact_hash is distinct from v_package.artifact_hash
    or v_request.preview is distinct from v_package.manifest
    or v_request.destination is distinct from
      ('organic:' || (v_package.manifest->>'platform'))
    or v_request.account_ref is distinct from
      (v_package.manifest->>'account_ref')
    or v_request.scope is distinct from jsonb_build_object(
      'client_id',v_package.client_id,
      'scheduled_post_id',v_package.scheduled_post_id,
      'slot_id',v_package.slot_id,
      'source_snapshot_hash',v_package.source_snapshot_hash) then
    return 'superseded';
  end if;
  v_live := public.organic_publication_source_snapshot_v6(
    v_package.scheduled_post_id);
  if v_live is null then return 'superseded'; end if;
  v_live_hash := encode(sha256(convert_to(v_live::text, 'UTF8')), 'hex');
  if v_live_hash is distinct from v_package.source_snapshot_hash
    then return 'superseded'; end if;
  if coalesce(v_package.manifest->'rights'->>'usage_rights','')
       not in ('client_owned','licensed','agency_owned')
    or nullif(btrim(coalesce(v_package.manifest->'provider_copy'->>'caption','')),'') is null
    then return 'source_held'; end if;
  return 'pending';
end;
$$;
revoke all on function public.organic_publication_source_state_v6(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.organic_publication_source_state_v6(uuid)
  to authenticated, service_role;


create function public.decide_organic_publication_v7(
  p_package_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.organic_publication_packages_v6%rowtype;
  q public.approval_requests_v6%rowtype;
begin
  if p_approved is null then raise exception 'Choose a decision.' using errcode='23514'; end if;
  select * into p from public.organic_publication_packages_v6
    where id=p_package_id for share;
  select * into q from public.approval_requests_v6 where id=p_request_id;
  if p.id is null or q.id is null or q.source_id<>p.id::text
    or q.client_id<>p.client_id or q.source_kind<>'organic_publication'
    or q.source_version<>p.artifact_hash then
    raise exception 'Exact organic publication request unavailable.' using errcode='23514';
  end if;
  if public.organic_publication_source_state_v6(q.id)<>'pending'
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=q.id and i.status='pending' and i.preview_blocker is null) then
    raise exception 'Organic publication package changed or is not reviewable.'
      using errcode='23514';
  end if;
  return public.record_approval_decision_v6(q.id,
    case when p_approved then 'approved' else 'rejected' end,
    p.artifact_hash,'organic_publication_packages_v6:'||p.id::text,p_reason);
end $$;
revoke all on function public.decide_organic_publication_v7(uuid,uuid,boolean,text)
  from public,anon,service_role;
grant execute on function public.decide_organic_publication_v7(uuid,uuid,boolean,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;

-- The canonical Inbox keeps its current projection, but makes a current
-- rights-bearing organic package reviewable. The stored historic blocker
-- remains visible for stale or incomplete packages.
begin;
create or replace view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when r.source_system = 'aa_console'
      and r.source_kind in ('service_offer','lead_magnet','sales_agent_public_use','opportunity_approve','proof_rights','proof_placement','proof_artifact','ordinary_media','proof_delivery','meta_profile_change','google_profile_change','opportunity_activate','message_template','nurture_sequence','video_seat','motion_render','campaign_idea','activation_switch','global_engine_activation','integration_grant','metrics_backfill','creative_requirement','global_video_owner','client_authority_assignment','gateway_tool')
      and d.decision in ('rejected','revoked') then d.decision
    when r.source_system = 'aa_console' and r.source_kind in ('proof_rights','message_template','nurture_sequence','video_seat','motion_render','campaign_idea','activation_switch','global_engine_activation','integration_grant','metrics_backfill','creative_requirement','global_video_owner','client_authority_assignment','gateway_tool')
      and s.source_state = 'revoked' then 'revoked'
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      and d.decision in ('rejected','revoked') then d.decision
    when inv.id is not null
      and coalesce(d.decision,'') not in ('rejected','revoked') then 'stale'
    when r.source_system = 'aa_console'
      and r.source_kind in ('production_release','recruitment_meta_build',
        'organic_publication')
      and s.source_state = 'source_held'
      and r.expires_at is not null and r.expires_at <= now() then 'expired'
    when s.source_state in ('cancelled','superseded','source_held','unverified')
      then s.source_state
    when d.decision = 'revoked' then 'revoked'
    when d.decision = 'rejected' then 'rejected'
    when r.source_system = 'aa_console'
      and r.source_kind in ('message_template','nurture_sequence','video_seat','motion_render','campaign_idea','activation_switch','global_engine_activation','integration_grant','metrics_backfill','creative_requirement','global_video_owner','client_authority_assignment','gateway_tool')
      and d.decision = 'approved' and s.source_state <> 'source_decided'
      then 'source_held'
    when r.source_system = 'aa_console' and r.source_kind = 'lead_magnet'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'sales_agent_public_use'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'opportunity_approve'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'proof_rights'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'proof_placement'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind = 'proof_artifact'
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.source_system = 'aa_console' and r.source_kind in ('ordinary_media','proof_delivery','meta_profile_change','google_profile_change','opportunity_activate','message_template','nurture_sequence','video_seat','motion_render','campaign_idea','activation_switch','global_engine_activation','integration_grant','metrics_backfill','creative_requirement','global_video_owner','client_authority_assignment','gateway_tool')
      and d.decision = 'approved' and s.source_state = 'source_decided' then 'approved'
    when r.expires_at is not null and r.expires_at <= now() then 'expired'
    when d.decision = 'approved' then 'approved'
    when s.source_state <> 'pending' then s.source_state
    else 'pending'
  end as status,
  r.requested_at, r.requested_by, r.requester_kind, r.requester_ref,
  r.expires_at,
  coalesce(e.artifact_hash,r.artifact_hash) as artifact_hash,
  case when r.source_system = 'aa_console'
      and r.source_kind = 'production_release' and a.id is not null
    then jsonb_build_object('candidate',r.preview,'trusted_github_evidence',a.packet)
    else coalesce(e.preview,r.preview) end as preview,
  coalesce(e.destination,r.destination) as destination,
  coalesce(e.account_ref,r.account_ref) as account_ref,
  coalesce(e.budget,r.budget) as budget,
  coalesce(e.scope,r.scope) as scope,
  r.owner_role,
  case
    when inv.id is not null then
      'A bound source changed after this exact request. Create and review a new request.'
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then case when s.source_state = 'pending' then null
        else 'Release source and four checks are not independently attested. Refresh trusted GitHub evidence for this exact candidate; no release effect is authorized by this card alone.' end
    when r.source_system = 'aa_console'
      and r.source_kind = 'recruitment_meta_build' then coalesce(
        nullif(btrim(r.preview_blocker),''),
        'Recruitment Meta creation still lacks exact media bytes and an AAL2 prewrite gate.')
    when r.source_system = 'aa_console'
      and r.source_kind = 'organic_publication' then
      case when s.source_state = 'pending' then null
        else coalesce(nullif(btrim(r.preview_blocker),''),
          'Organic publication package is stale or lacks verified rights.') end
    when r.expires_at is null then 'An expiry is missing.'
    when nullif(btrim(coalesce(r.owner_role,'')),'') is null then 'The decision owner is missing.'
    when e.id is not null then null
    when nullif(btrim(coalesce(r.preview_blocker,'')),'') is not null then r.preview_blocker
    when r.artifact_hash is null then 'The exact artifact hash is missing.'
    when r.preview is null or jsonb_typeof(r.preview) <> 'object'
      or r.preview = '{}'::jsonb then 'The exact artifact preview is missing.'
    when r.scope is null or r.scope = '{}'::jsonb then 'The exact scope is missing.'
    else null
  end as preview_blocker,
  r.owning_path,
  s.source_state
from public.approval_requests_v6 r
left join public.approval_request_evidence_v6 e on e.request_id = r.id
left join lateral (
  select de.decision from public.approval_decision_events_v6 de
  where de.request_id = r.id order by de.event_order desc limit 1
) d on true
left join lateral (
  select i.id from public.delivery_approval_invalidations_v6 i
  where i.approval_request_id = r.id
  order by i.invalidated_at desc limit 1
) inv on true
left join lateral (
  select pa.id,pa.packet from public.production_release_attestations_v6 pa
  where pa.request_id = r.id order by pa.event_order desc limit 1
) a on true
cross join lateral (
  select case
    when r.source_system = 'aa_console' and r.source_kind = 'campaign_action'
      then public.campaign_action_exact_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then public.production_release_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'recruitment_meta_build'
      then public.recruitment_meta_build_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'organic_publication'
      then public.organic_publication_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'service_offer'
      then public.service_offer_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'lead_magnet'
      then public.lead_magnet_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'sales_agent_public_use'
      then public.sales_agent_public_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'opportunity_approve'
      then public.opportunity_approval_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'proof_rights'
      then public.proof_rights_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'proof_placement'
      then public.proof_placement_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'proof_artifact'
      then public.proof_artifact_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'engine_slot'
      then public.engine_slot_exact_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'ordinary_media'
      then public.ordinary_media_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'proof_delivery'
      then public.proof_delivery_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'meta_profile_change'
      then public.meta_profile_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'google_profile_change'
      then public.google_profile_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'opportunity_activate'
      then public.opportunity_activation_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'message_template'
      then public.message_template_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'nurture_sequence'
      then public.nurture_sequence_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'video_seat'
      then public.video_seat_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'motion_render'
      then public.motion_render_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'campaign_idea'
      then public.human_idea_review_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'activation_switch'
      then public.client_switch_activation_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'global_engine_activation'
      then public.global_engine_activation_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'integration_grant'
      then public.integration_grant_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'metrics_backfill'
      then public.metrics_backfill_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'creative_requirement'
      then public.creative_requirement_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'global_video_owner'
      then public.global_video_owner_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'client_authority_assignment'
      then public.client_authority_assignment_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'gateway_tool'
      then public.gateway_tool_review_source_state_v6(r.id)
    when r.source_system = 'aa_console'
      and r.source_kind = 'campaign_preparation_package'
      then public.campaign_preparation_review_source_state_v7(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'paid_operator_bundle'
      then public.paid_operator_bundle_review_source_state_v7(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'google_search_copy'
      then public.google_search_copy_review_source_state_v7(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'google_operator_bundle'
      then public.google_operator_review_source_state_v7(r.id)
    else public.approval_source_state_v6(r.id)
  end as source_state
) s;
revoke all on public.approval_inbox_v6 from public,anon,authenticated,service_role;
grant select on public.approval_inbox_v6 to authenticated,service_role;
commit;
