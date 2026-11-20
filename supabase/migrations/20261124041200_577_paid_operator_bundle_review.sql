-- Review the exact frozen operator packet, including instructions added after
-- campaign-package approval. Approval authorizes handoff only, not ad spend.
begin;

create function public.register_paid_operator_bundle_review_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  perform public.register_approval_request_v6(jsonb_build_object(
    'client_id',new.client_id,'source_system','aa_console',
    'source_kind','paid_operator_bundle','source_id',new.id::text,
    'source_version',new.snapshot_hash,'artifact_hash',new.snapshot_hash,
    'title',initcap(new.platform)||' paid operator bundle v'||new.version::text,
    'preview',new.snapshot,
    'destination',new.platform||'_ads:manual_operator_handoff',
    'scope',jsonb_build_object('client_id',new.client_id,
      'campaign_id',new.campaign_id,'package_id',new.package_id,
      'bundle_id',new.id,'platform',new.platform,'version',new.version,
      'snapshot_hash',new.snapshot_hash),
    'owner_role','admin_or_active_client_manager',
    'requested_by',new.created_by,'requester_kind','human',
    'expires_at',now()+interval '7 days',
    'owning_path','/clients/'||new.client_id::text||'/delivery/'||
      case when new.platform='google' then 'google-ads-studio'
        else 'meta-ads-studio' end));
  return new;
end $$;
create trigger paid_operator_bundle_inbox_v7 after insert
  on public.paid_operator_bundles_v7 for each row
  execute function public.register_paid_operator_bundle_review_v7();
revoke all on function public.register_paid_operator_bundle_review_v7()
  from public,anon,authenticated,service_role;

-- Existing immutable bundles also need a pending exact review. Never infer a
-- human decision from an earlier download or handoff report.
do $$
declare b public.paid_operator_bundles_v7%rowtype;
begin
  for b in select * from public.paid_operator_bundles_v7 loop
    perform public.register_approval_request_v6(jsonb_build_object(
      'client_id',b.client_id,'source_system','aa_console',
      'source_kind','paid_operator_bundle','source_id',b.id::text,
      'source_version',b.snapshot_hash,'artifact_hash',b.snapshot_hash,
      'title',initcap(b.platform)||' paid operator bundle v'||b.version::text,
      'preview',b.snapshot,
      'destination',b.platform||'_ads:manual_operator_handoff',
      'scope',jsonb_build_object('client_id',b.client_id,
        'campaign_id',b.campaign_id,'package_id',b.package_id,
        'bundle_id',b.id,'platform',b.platform,'version',b.version,
        'snapshot_hash',b.snapshot_hash),
      'owner_role','admin_or_active_client_manager',
      'requested_by',b.created_by,'requester_kind','human',
      'expires_at',now()+interval '7 days',
      'owning_path','/clients/'||b.client_id::text||'/delivery/'||
        case when b.platform='google' then 'google-ads-studio'
          else 'meta-ads-studio' end));
  end loop;
end $$;

create function public.paid_operator_bundle_review_source_state_v7(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare q public.approval_requests_v6%rowtype;
  b public.paid_operator_bundles_v7%rowtype;
begin
  select * into q from public.approval_requests_v6 where id=p_request_id;
  if q.id is null or q.source_system<>'aa_console'
    or q.source_kind<>'paid_operator_bundle' then return 'unverified'; end if;
  if auth.role()<>'service_role' and (auth.role()<>'authenticated'
    or not public.can_review_approval_request_v6(q.client_id,q.owner_role)) then
    return 'unverified'; end if;
  if q.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into b from public.paid_operator_bundles_v7 where id=q.source_id::uuid;
  if b.id is null then return 'cancelled'; end if;
  if b.client_id is distinct from q.client_id
    or b.snapshot_hash is distinct from q.source_version
    or b.snapshot_hash is distinct from q.artifact_hash
    or b.snapshot is distinct from q.preview
    or q.destination is distinct from b.platform||'_ads:manual_operator_handoff'
    or q.scope is distinct from jsonb_build_object('client_id',b.client_id,
      'campaign_id',b.campaign_id,'package_id',b.package_id,
      'bundle_id',b.id,'platform',b.platform,'version',b.version,
      'snapshot_hash',b.snapshot_hash)
    or not public.paid_operator_bundle_current_v7(b.id) then return 'superseded'; end if;
  return 'pending';
end $$;
revoke all on function public.paid_operator_bundle_review_source_state_v7(uuid)
  from public,anon;
grant execute on function public.paid_operator_bundle_review_source_state_v7(uuid)
  to authenticated,service_role;

create function public.decide_paid_operator_bundle_v7(
  p_bundle_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare b public.paid_operator_bundles_v7%rowtype;
  q public.approval_requests_v6%rowtype;
begin
  if p_approved is null then raise exception 'Choose a decision.' using errcode='23514'; end if;
  select * into b from public.paid_operator_bundles_v7 where id=p_bundle_id for share;
  select * into q from public.approval_requests_v6 where id=p_request_id;
  if b.id is null or q.id is null or q.source_id<>b.id::text
    or q.client_id<>b.client_id or q.source_kind<>'paid_operator_bundle'
    or q.source_version<>b.snapshot_hash then
    raise exception 'Exact paid operator request unavailable.' using errcode='23514'; end if;
  if public.paid_operator_bundle_review_source_state_v7(q.id)<>'pending'
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=q.id and i.status='pending' and i.preview_blocker is null) then
    raise exception 'Paid operator packet changed or is not reviewable.' using errcode='23514'; end if;
  return public.record_approval_decision_v6(q.id,
    case when p_approved then 'approved' else 'rejected' end,
    b.snapshot_hash,'paid_operator_bundle:'||b.id::text,p_reason);
end $$;
revoke all on function public.decide_paid_operator_bundle_v7(uuid,uuid,boolean,text)
  from public,anon,service_role;
grant execute on function public.decide_paid_operator_bundle_v7(uuid,uuid,boolean,text)
  to authenticated;

create function public.paid_operator_bundle_approved_v7(p_bundle_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare b public.paid_operator_bundles_v7%rowtype;
  q public.approval_requests_v6%rowtype;
  v_decision text;
begin
  select * into b from public.paid_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null then return false; end if;
  if not public.paid_operator_bundle_current_v7(b.id) then return false; end if;
  select * into q from public.approval_requests_v6
    where source_system='aa_console' and source_kind='paid_operator_bundle'
      and source_id=b.id::text and source_version=b.snapshot_hash;
  if q.id is null then return false; end if;
  select d.decision into v_decision from public.approval_decision_events_v6 d
    where d.request_id=q.id order by d.event_order desc limit 1;
  return coalesce(v_decision='approved',false);
end $$;
revoke all on function public.paid_operator_bundle_approved_v7(uuid)
  from public,anon;
grant execute on function public.paid_operator_bundle_approved_v7(uuid)
  to authenticated,service_role;

select public.lock_down_definer_functions();
commit;

-- The canonical Inbox must evaluate the bundle's exact current source.
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

-- Export and every reportable operator event require that decision.
begin;
create or replace function public.paid_operator_bundle_export_v7(p_bundle_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare b public.paid_operator_bundles_v7%rowtype;
begin
  select * into b from public.paid_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null or auth.role()<>'authenticated' or auth.uid() is null
    or not public.can_access_client(b.client_id)
    or not public.paid_operator_bundle_approved_v7(b.id) then
    raise exception 'A current approved paid operator bundle is required.' using errcode='42501';
  end if;
  return b.snapshot::text;
end $$;
revoke all on function public.paid_operator_bundle_export_v7(uuid)
  from public,anon,service_role;
grant execute on function public.paid_operator_bundle_export_v7(uuid)
  to authenticated;

select public.lock_down_definer_functions();
commit;

-- Exact packet-byte evidence is required before a reported operator handoff.
begin;
create or replace function public.record_paid_operator_event_v7(
  p_bundle_id uuid,p_event text,p_reference text,p_external_campaign_id text default null,
  p_external_ad_id text default null,p_detail text default null)
returns public.paid_operator_events_v7 language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare b public.paid_operator_bundles_v7%rowtype;
  v_prior public.paid_operator_events_v7%rowtype;
  v_event public.paid_operator_events_v7%rowtype;
begin
  select * into b from public.paid_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null then raise exception 'Bundle unavailable.' using errcode='23514'; end if;
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not public.can_access_client(b.client_id) then
    raise exception 'Client operator required.' using errcode='42501';
  end if;
  if not public.paid_operator_bundle_approved_v7(b.id) then
    raise exception 'The exact paid bundle is stale or lacks human approval.' using errcode='23514';
  end if;
  if p_event not in ('verified_download','handoff_reported','external_ids_reported','activation_reported','change_reported')
    or nullif(btrim(p_reference),'') is null then
    raise exception 'A supported event and external evidence reference are required.' using errcode='23514';
  end if;
  select * into v_prior from public.paid_operator_events_v7
    where bundle_id=b.id and event=p_event and reference=btrim(p_reference);
  if v_prior.id is not null then
    if v_prior.external_campaign_id is distinct from nullif(btrim(p_external_campaign_id),'')
      or v_prior.external_ad_id is distinct from nullif(btrim(p_external_ad_id),'')
      or v_prior.detail is distinct from nullif(btrim(p_detail),'') then
      raise exception 'This evidence reference already records a different event.' using errcode='23514';
    end if;
    return v_prior;
  end if;
  if p_event='verified_download' and p_reference is distinct from 'sha256:'||b.snapshot_hash then
    raise exception 'Download evidence must name the exact packet hash.' using errcode='23514';
  end if;
  if p_event='handoff_reported' and not exists(select 1 from public.paid_operator_events_v7
    where bundle_id=b.id and event='verified_download'
      and reference='sha256:'||b.snapshot_hash) then
    raise exception 'Download and verify the bundle files before reporting handoff.' using errcode='23514';
  end if;
  if p_event not in ('verified_download','handoff_reported') and not exists(select 1 from public.paid_operator_events_v7
    where bundle_id=b.id and event='handoff_reported') then
    raise exception 'Record the operator handoff first.' using errcode='23514';
  end if;
  if p_event in ('external_ids_reported','activation_reported','change_reported')
    and nullif(btrim(p_external_campaign_id),'') is null then
    raise exception 'The external campaign ID is required.' using errcode='23514';
  end if;
  insert into public.paid_operator_events_v7
    (bundle_id,client_id,event,reference,external_campaign_id,external_ad_id,detail,recorded_by)
  values(b.id,b.client_id,p_event,btrim(p_reference),nullif(btrim(p_external_campaign_id),''),
    nullif(btrim(p_external_ad_id),''),nullif(btrim(p_detail),''),auth.uid())
  returning * into v_event;
  return v_event;
end $$;
commit;
