-- Human review of one exact search-copy version, before any paid handoff.
-- The card can be registered at production time but remains held until QA
-- links the immutable copy version to its paid-route work item.
begin;

create function public.google_search_copy_current_v7(p_copy_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare v public.campaign_google_search_copy_versions_v7%rowtype;
  w public.delivery_work_items_v6%rowtype;
  c public.client_campaigns%rowtype;
  r public.campaign_route_packages_v6%rowtype;
begin
  select * into v from public.campaign_google_search_copy_versions_v7 where id=p_copy_id;
  if v.id is null then return false; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(v.client_id)) then
    raise exception 'Client access required.' using errcode='42501';
  end if;
  select * into w from public.delivery_work_items_v6 where id=v.work_item_id;
  select * into c from public.client_campaigns where id=v.campaign_id;
  select * into r from public.campaign_route_packages_v6 where id=v.route_package_id;
  return w.id is not null and c.id is not null and r.id is not null
    and c.client_id=v.client_id and c.archived_at is null
    and c.runs_paid and c.paid_platform='google'
    and public.campaign_sweep_blocker_v6(c.id) is null
    and v.content_spec_id=c.content_spec_id
    and w.client_id=v.client_id and w.campaign_id=c.id
    and w.route_package_id=r.id and w.route_key='paid' and w.required
    and w.state in ('ready_for_review','approved') and w.qa_state='passed'
    and w.output_fingerprint is not null
    and w.output_fingerprint=public.delivery_work_output_hash_v6(w.id)
    and w.expected_output->>'artifact_kind'='google_search_copy'
    and r.campaign_id=c.id and r.client_id=c.client_id
    and r.route='paid' and r.paid_platform='google'
    and r.plan_fingerprint=public.campaign_plan_fingerprint(c)
    and r.version=(select max(x.version) from public.campaign_route_packages_v6 x
      where x.campaign_id=c.id and x.route='paid')
    and exists(select 1 from public.delivery_work_outputs_v6 o
      join public.delivery_entity_versions_v6 e on e.id=o.entity_version_id
      where o.work_item_id=w.id and e.client_id=v.client_id
        and e.entity_kind='google_search_copy' and e.source_key=v.id::text
        and e.fingerprint=v.copy_hash);
end $$;
revoke all on function public.google_search_copy_current_v7(uuid) from public,anon;
grant execute on function public.google_search_copy_current_v7(uuid)
  to authenticated,service_role;

create function public.register_google_search_copy_review_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  perform public.register_approval_request_v6(jsonb_build_object(
    'client_id',new.client_id,'source_system','aa_console',
    'source_kind','google_search_copy','source_id',new.id::text,
    'source_version',new.copy_hash,'artifact_hash',new.copy_hash,
    'title','Google search copy · piece '||new.piece_index::text,
    'preview',jsonb_build_object('campaign_id',new.campaign_id,
      'route_package_id',new.route_package_id,'content_spec_id',new.content_spec_id,
      'work_item_id',new.work_item_id,'piece_index',new.piece_index,
      'source_idea_id',new.source_idea_id,'source_snapshot',new.source_snapshot,
      'headlines',new.headlines,'descriptions',new.descriptions,
      'rationale',new.rationale,'copy_hash',new.copy_hash),
    'destination','google_ads:manual_operator_handoff',
    'scope',jsonb_build_object('client_id',new.client_id,
      'campaign_id',new.campaign_id,'route_package_id',new.route_package_id,
      'copy_id',new.id,'work_item_id',new.work_item_id,
      'copy_hash',new.copy_hash),
    'owner_role','admin_or_active_client_manager',
    'requested_by',null,'requester_kind','service',
    'requester_ref','google_search_copy:'||new.producer_job_id::text,
    'expires_at',now()+interval '7 days',
    'owning_path','/clients/'||new.client_id::text||
      '/delivery/campaign-factory?campaign='||new.campaign_id::text));
  return new;
end $$;
create trigger google_search_copy_inbox_v7 after insert
  on public.campaign_google_search_copy_versions_v7 for each row
  execute function public.register_google_search_copy_review_v7();
revoke all on function public.register_google_search_copy_review_v7()
  from public,anon,authenticated,service_role;

create function public.google_search_copy_review_source_state_v7(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare q public.approval_requests_v6%rowtype;
  v public.campaign_google_search_copy_versions_v7%rowtype;
  v_preview jsonb;
begin
  select * into q from public.approval_requests_v6 where id=p_request_id;
  if q.id is null or q.source_system<>'aa_console'
    or q.source_kind<>'google_search_copy' then return 'unverified'; end if;
  if auth.role()<>'service_role' and (auth.role()<>'authenticated'
    or not public.can_review_approval_request_v6(q.client_id,q.owner_role)) then
    return 'unverified'; end if;
  if q.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into v from public.campaign_google_search_copy_versions_v7
    where id=q.source_id::uuid;
  if v.id is null then return 'cancelled'; end if;
  v_preview:=jsonb_build_object('campaign_id',v.campaign_id,
    'route_package_id',v.route_package_id,'content_spec_id',v.content_spec_id,
    'work_item_id',v.work_item_id,'piece_index',v.piece_index,
    'source_idea_id',v.source_idea_id,'source_snapshot',v.source_snapshot,
    'headlines',v.headlines,'descriptions',v.descriptions,
    'rationale',v.rationale,'copy_hash',v.copy_hash);
  if q.client_id is distinct from v.client_id
    or q.source_version is distinct from v.copy_hash
    or q.artifact_hash is distinct from v.copy_hash
    or q.preview is distinct from v_preview
    or q.destination is distinct from 'google_ads:manual_operator_handoff'
    or q.scope is distinct from jsonb_build_object('client_id',v.client_id,
      'campaign_id',v.campaign_id,'route_package_id',v.route_package_id,
      'copy_id',v.id,'work_item_id',v.work_item_id,'copy_hash',v.copy_hash)
    then return 'superseded'; end if;
  if not public.google_search_copy_current_v7(v.id) then return 'source_held'; end if;
  return 'pending';
end $$;
revoke all on function public.google_search_copy_review_source_state_v7(uuid)
  from public,anon;
grant execute on function public.google_search_copy_review_source_state_v7(uuid)
  to authenticated,service_role;

create function public.decide_google_search_copy_v7(
  p_copy_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare v public.campaign_google_search_copy_versions_v7%rowtype;
  q public.approval_requests_v6%rowtype;
begin
  if p_approved is null then raise exception 'Choose a decision.' using errcode='23514'; end if;
  select * into v from public.campaign_google_search_copy_versions_v7
    where id=p_copy_id for share;
  select * into q from public.approval_requests_v6 where id=p_request_id;
  if v.id is null or q.id is null or q.source_id<>v.id::text
    or q.client_id<>v.client_id or q.source_kind<>'google_search_copy'
    or q.source_version<>v.copy_hash then
    raise exception 'Exact Google search-copy request unavailable.' using errcode='23514';
  end if;
  if public.google_search_copy_review_source_state_v7(q.id)<>'pending'
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=q.id and i.status='pending' and i.preview_blocker is null) then
    raise exception 'Search copy changed or is not reviewable.' using errcode='23514';
  end if;
  return public.record_approval_decision_v6(q.id,
    case when p_approved then 'approved' else 'rejected' end,
    v.copy_hash,'google_search_copy:'||v.id::text,p_reason);
end $$;
revoke all on function public.decide_google_search_copy_v7(uuid,uuid,boolean,text)
  from public,anon,service_role;
grant execute on function public.decide_google_search_copy_v7(uuid,uuid,boolean,text)
  to authenticated;

create function public.google_search_copy_approved_v7(p_copy_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare v public.campaign_google_search_copy_versions_v7%rowtype;
  q public.approval_requests_v6%rowtype;
  v_decision text;
begin
  select * into v from public.campaign_google_search_copy_versions_v7 where id=p_copy_id;
  if v.id is null then return false; end if;
  if not public.google_search_copy_current_v7(v.id) then return false; end if;
  select * into q from public.approval_requests_v6
    where source_system='aa_console' and source_kind='google_search_copy'
      and source_id=v.id::text and source_version=v.copy_hash;
  if q.id is null then return false; end if;
  select d.decision into v_decision from public.approval_decision_events_v6 d
    where d.request_id=q.id order by d.event_order desc limit 1;
  return coalesce(v_decision='approved',false);
end $$;
revoke all on function public.google_search_copy_approved_v7(uuid)
  from public,anon;
grant execute on function public.google_search_copy_approved_v7(uuid)
  to authenticated,service_role;

select public.lock_down_definer_functions();
commit;

-- Source-aware Unified Inbox projection for exact search-copy decisions.
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
      and r.source_kind = 'organic_publication' then coalesce(
        nullif(btrim(r.preview_blocker),''),
        'Organic publication lacks rights provenance, exact AAL2 approval and prewrite attestation.')
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
