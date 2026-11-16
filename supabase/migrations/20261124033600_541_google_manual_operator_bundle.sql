-- Google search copy has no campaign sweep producer. The hand-build route
-- starts from the versioned, manifest-bound sheet and human-entered ad copy.
-- Approval of this packet permits a human handoff only, never API creation or
-- activation of ads.
create table public.google_operator_bundles_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  campaign_id uuid not null,
  sheet_id uuid not null,
  version integer not null check(version>0),
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
  snapshot_hash text not null check(snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key(campaign_id,client_id) references public.client_campaigns(id,client_id) on delete restrict,
  foreign key(sheet_id,campaign_id,client_id)
    references public.google_ads_build_sheets(id,campaign_id,client_id) on delete restrict,
  unique(sheet_id,version)
);
create index google_operator_bundles_client_v7 on public.google_operator_bundles_v7
  (client_id,created_at desc);
create trigger google_operator_bundles_immutable_v7 before update or delete
  on public.google_operator_bundles_v7 for each row
  execute function public.reject_approval_ledger_mutation_v6();
alter table public.google_operator_bundles_v7 enable row level security;
create policy google_operator_bundles_read_v7 on public.google_operator_bundles_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.google_operator_bundles_v7 from public,anon,authenticated;
grant select on public.google_operator_bundles_v7 to authenticated;
grant all on public.google_operator_bundles_v7 to service_role;

create function public.google_operator_sheet_source_v7(p_sheet_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare s public.google_ads_build_sheets%rowtype;
  c public.client_campaigns%rowtype;
  m public.campaign_manifest_versions%rowtype;
  v_offer public.service_offer_versions%rowtype;
begin
  select * into s from public.google_ads_build_sheets where id=p_sheet_id;
  if s.id is null then return null; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(s.client_id)) then
    raise exception 'Client access required.' using errcode='42501';
  end if;
  select * into c from public.client_campaigns where id=s.campaign_id and client_id=s.client_id;
  if c.id is null or c.archived_at is not null or c.acquisition_mode<>'paid'
    or c.paid_platform<>'google' or s.manifest_id is null
    or exists(select 1 from public.google_ads_build_sheets newer
      where newer.campaign_id=c.id and newer.version>s.version) then return null; end if;
  select * into m from public.campaign_manifest_versions
    where id=s.manifest_id and campaign_id=c.id and client_id=c.client_id;
  if m.id is null or m.acquisition_mode<>'paid' or m.paid_platform<>'google'
    or exists(select 1 from public.campaign_manifest_versions newer
      where newer.campaign_id=c.id and newer.version>m.version) then return null; end if;
  if s.plan_hash is distinct from encode(sha256(convert_to(jsonb_build_object(
      'manifest_id',s.manifest_id,'derived',s.derived,'missing',s.missing)::text,'UTF8')),'hex')
    or c.daily_budget is null or c.daily_budget<=0
    or coalesce(array_length(c.target_countries,1),0)=0
    or nullif(btrim(c.conversion_event),'') is null
    or s.derived->'campaign'->'daily_budget' is distinct from to_jsonb(c.daily_budget)
    or s.derived->'campaign'->'geography' is distinct from to_jsonb(c.target_countries)
    or s.derived->'campaign'->>'conversion_action' is distinct from c.conversion_event
    or nullif(btrim(s.derived->'destination'->>'url'),'') is null
    or m.plan_snapshot->>'audience' is distinct from c.audience
    or m.plan_snapshot->>'objective' is distinct from c.objective
    or m.plan_snapshot->>'core_message' is distinct from c.core_message
    or m.plan_snapshot->>'offer_summary' is distinct from c.offer_summary
    then return null; end if;
  select v.* into v_offer from public.service_offer_versions v
    join public.service_offer_signoffs signoff on signoff.offer_version_id=v.id
      and signoff.client_id=v.client_id
    where v.id=c.offer_version_id and v.client_id=c.client_id;
  if v_offer.id is null or s.derived->'offer'->>'version_id' is distinct from v_offer.id::text
    or not public.secondary_offer_source_current_v7(v_offer.offer_id) then return null; end if;
  return jsonb_build_object('sheet_id',s.id,'sheet_version',s.version,
    'sheet_hash',s.plan_hash,'manifest_id',m.id,'manifest_version',m.version,
    'manifest_hash',m.plan_hash,'campaign_id',c.id,'campaign_name',c.name,
    'audience',c.audience,'offer_version_id',v_offer.id,'offer_promise',v_offer.promise,
    'daily_budget',c.daily_budget,'target_countries',c.target_countries,
    'conversion_event',c.conversion_event,'destination_url',s.derived->'destination'->>'url',
    'sheet',s.derived,'sheet_missing',s.missing);
end $$;
revoke all on function public.google_operator_sheet_source_v7(uuid) from public,anon;
grant execute on function public.google_operator_sheet_source_v7(uuid) to authenticated,service_role;

create function public.google_operator_bundle_current_v7(p_bundle_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare b public.google_operator_bundles_v7%rowtype;
  v_source jsonb;
begin
  select * into b from public.google_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null then return false; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(b.client_id)) then
    raise exception 'Client access required.' using errcode='42501'; end if;
  v_source:=public.google_operator_sheet_source_v7(b.sheet_id);
  return v_source is not null and v_source=b.snapshot->'source'
    and b.snapshot_hash=encode(sha256(convert_to(b.snapshot::text,'UTF8')),'hex')
    and b.version=(select max(version) from public.google_operator_bundles_v7
      where sheet_id=b.sheet_id);
end $$;
revoke all on function public.google_operator_bundle_current_v7(uuid) from public,anon;
grant execute on function public.google_operator_bundle_current_v7(uuid) to authenticated,service_role;

create function public.register_google_operator_bundle_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  perform public.register_approval_request_v6(jsonb_build_object(
    'client_id',new.client_id,'source_system','aa_console',
    'source_kind','google_operator_bundle','source_id',new.id::text,
    'source_version',new.snapshot_hash,'artifact_hash',new.snapshot_hash,
    'title','Google manual operator bundle v'||new.version::text,
    'preview',new.snapshot,'destination','google_ads:manual_operator_handoff',
    'scope',jsonb_build_object('client_id',new.client_id,'campaign_id',new.campaign_id,
      'bundle_id',new.id,'sheet_id',new.sheet_id,'version',new.version,
      'snapshot_hash',new.snapshot_hash),
    'owner_role','admin_or_active_client_manager',
    'requested_by',new.created_by,'requester_kind','human',
    'expires_at',now()+interval '7 days',
    'owning_path','/clients/'||new.client_id::text||'/delivery/google-ads-studio'));
  return new;
end $$;
create trigger google_operator_bundle_inbox_v7 after insert on public.google_operator_bundles_v7
  for each row execute function public.register_google_operator_bundle_v7();
revoke all on function public.register_google_operator_bundle_v7()
  from public,anon,authenticated,service_role;

create function public.create_google_operator_bundle_v7(
  p_sheet_id uuid,p_owner text,p_budget_instruction text,p_tracking_instruction text,
  p_headlines text[],p_descriptions text[],p_research_task text)
returns public.google_operator_bundles_v7 language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare s public.google_ads_build_sheets%rowtype;
  v_source jsonb; v_snapshot jsonb; v_hash text;
  prior public.google_operator_bundles_v7%rowtype;
begin
  select * into s from public.google_ads_build_sheets where id=p_sheet_id;
  if s.id is null then raise exception 'Versioned Google sheet required.' using errcode='23514'; end if;
  if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
    or not public.can_access_client(s.client_id) then
    raise exception 'Client operator required.' using errcode='42501'; end if;
  if nullif(btrim(p_owner),'') is null or nullif(btrim(p_budget_instruction),'') is null
    or nullif(btrim(p_tracking_instruction),'') is null
    or nullif(btrim(p_research_task),'') is null
    or coalesce(array_length(p_headlines,1),0) not between 3 and 15
    or not public.all_within_length(p_headlines,30)
    or coalesce(array_length(p_descriptions,1),0) not between 2 and 4
    or not public.all_within_length(p_descriptions,90) then
    raise exception 'Operator, budget, tracking, research task and valid Google ad copy are required.'
      using errcode='23514'; end if;
  perform 1 from public.client_campaigns where id=s.campaign_id for update;
  v_source:=public.google_operator_sheet_source_v7(s.id);
  if v_source is null then
    raise exception 'Current manifest-bound sheet, signed offer, budget, geography, conversion and destination required.'
      using errcode='23514'; end if;
  v_snapshot:=jsonb_build_object('source',v_source,'owner',btrim(p_owner),
    'budget_instruction',btrim(p_budget_instruction),
    'tracking_instruction',btrim(p_tracking_instruction),
    'research_task',btrim(p_research_task),
    'headlines',p_headlines,'descriptions',p_descriptions,
    'consequence','Manual handoff only. Paid activation and spend changes need separate decisions.');
  v_hash:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  select * into prior from public.google_operator_bundles_v7
    where sheet_id=s.id order by version desc limit 1;
  if prior.snapshot_hash=v_hash and prior.snapshot=v_snapshot then return prior; end if;
  insert into public.google_operator_bundles_v7
    (client_id,campaign_id,sheet_id,version,snapshot,snapshot_hash,created_by)
  values(s.client_id,s.campaign_id,s.id,coalesce(prior.version+1,1),
    v_snapshot,v_hash,auth.uid()) returning * into prior;
  return prior;
end $$;
revoke all on function public.create_google_operator_bundle_v7(uuid,text,text,text,text[],text[],text)
  from public,anon,service_role;
grant execute on function public.create_google_operator_bundle_v7(uuid,text,text,text,text[],text[],text)
  to authenticated;

create function public.google_operator_review_source_state_v7(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype;
  b public.google_operator_bundles_v7%rowtype;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if r.id is null or r.source_system<>'aa_console'
    or r.source_kind<>'google_operator_bundle' then return 'unverified'; end if;
  if auth.role()<>'service_role' and (auth.role()<>'authenticated'
    or not public.can_review_approval_request_v6(r.client_id,r.owner_role)) then
    return 'unverified'; end if;
  if r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into b from public.google_operator_bundles_v7 where id=r.source_id::uuid;
  if b.id is null then return 'cancelled'; end if;
  if b.client_id is distinct from r.client_id
    or b.snapshot_hash is distinct from r.source_version
    or b.snapshot_hash is distinct from r.artifact_hash
    or b.snapshot is distinct from r.preview
    or r.destination is distinct from 'google_ads:manual_operator_handoff'
    or r.scope is distinct from jsonb_build_object('client_id',b.client_id,
      'campaign_id',b.campaign_id,'bundle_id',b.id,'sheet_id',b.sheet_id,
      'version',b.version,'snapshot_hash',b.snapshot_hash)
    or not public.google_operator_bundle_current_v7(b.id) then return 'superseded'; end if;
  return 'pending';
end $$;
revoke all on function public.google_operator_review_source_state_v7(uuid) from public,anon;
grant execute on function public.google_operator_review_source_state_v7(uuid)
  to authenticated,service_role;

create function public.decide_google_operator_bundle_v7(
  p_bundle_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare b public.google_operator_bundles_v7%rowtype;
  r public.approval_requests_v6%rowtype;
begin
  if p_approved is null then raise exception 'Choose a decision.' using errcode='23514'; end if;
  select * into b from public.google_operator_bundles_v7 where id=p_bundle_id for share;
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if b.id is null or r.id is null or r.source_id<>b.id::text
    or r.client_id<>b.client_id or r.source_kind<>'google_operator_bundle'
    or r.source_version<>b.snapshot_hash then
    raise exception 'Exact Google operator request unavailable.' using errcode='23514'; end if;
  if public.google_operator_review_source_state_v7(r.id)<>'pending'
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=r.id and i.status='pending' and i.preview_blocker is null) then
    raise exception 'Google operator source changed or is not reviewable.' using errcode='23514'; end if;
  return public.record_approval_decision_v6(r.id,
    case when p_approved then 'approved' else 'rejected' end,
    b.snapshot_hash,'google_operator_bundle:'||b.id::text,p_reason);
end $$;
revoke all on function public.decide_google_operator_bundle_v7(uuid,uuid,boolean,text)
  from public,anon,service_role;
grant execute on function public.decide_google_operator_bundle_v7(uuid,uuid,boolean,text)
  to authenticated;

create function public.google_operator_bundle_approved_v7(p_bundle_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare b public.google_operator_bundles_v7%rowtype;
  r public.approval_requests_v6%rowtype;
  v_decision text;
begin
  select * into b from public.google_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null then return false; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(b.client_id)) then
    raise exception 'Client access required.' using errcode='42501'; end if;
  if not public.google_operator_bundle_current_v7(b.id) then return false; end if;
  select * into r from public.approval_requests_v6
    where source_system='aa_console' and source_kind='google_operator_bundle'
      and source_id=b.id::text and source_version=b.snapshot_hash;
  if r.id is null then return false; end if;
  select d.decision into v_decision from public.approval_decision_events_v6 d
    where d.request_id=r.id order by d.event_order desc limit 1;
  return coalesce(v_decision='approved',false);
end $$;
revoke all on function public.google_operator_bundle_approved_v7(uuid) from public,anon;
grant execute on function public.google_operator_bundle_approved_v7(uuid)
  to authenticated,service_role;

create function public.google_operator_bundle_export_v7(p_bundle_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare b public.google_operator_bundles_v7%rowtype;
begin
  select * into b from public.google_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null or auth.role()<>'authenticated' or auth.uid() is null
    or not public.can_access_client(b.client_id)
    or not coalesce(public.google_operator_bundle_approved_v7(b.id),false) then
    raise exception 'Current approved Google operator bundle required.' using errcode='42501';
  end if;
  return b.snapshot::text;
end $$;
revoke all on function public.google_operator_bundle_export_v7(uuid) from public,anon,service_role;
grant execute on function public.google_operator_bundle_export_v7(uuid) to authenticated;
select public.lock_down_definer_functions();

-- Keep the canonical unified inbox source-aware for this exact packet.
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
    when r.source_system = 'aa_console' and r.source_kind = 'google_operator_bundle'
      then public.google_operator_review_source_state_v7(r.id)
    else public.approval_source_state_v6(r.id)
  end as source_state
) s;
revoke all on public.approval_inbox_v6 from public, anon, authenticated, service_role;
grant select on public.approval_inbox_v6 to authenticated, service_role;
commit;

create table public.google_operator_events_v7 (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.google_operator_bundles_v7(id) on delete restrict,
  client_id uuid not null,
  event text not null check(event in ('verified_download','handoff_reported',
    'external_ids_reported','activation_reported','change_reported')),
  reference text not null check(length(btrim(reference)) between 1 and 500),
  external_campaign_id text,
  external_ad_id text,
  detail text,
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  unique(bundle_id,event,reference)
);
create index google_operator_events_bundle_v7 on public.google_operator_events_v7
  (bundle_id,recorded_at desc);
create trigger google_operator_events_immutable_v7 before update or delete
  on public.google_operator_events_v7 for each row
  execute function public.reject_approval_ledger_mutation_v6();
alter table public.google_operator_events_v7 enable row level security;
create policy google_operator_events_read_v7 on public.google_operator_events_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.google_operator_events_v7 from public,anon,authenticated;
grant select on public.google_operator_events_v7 to authenticated;
grant all on public.google_operator_events_v7 to service_role;

create function public.record_google_operator_event_v7(
  p_bundle_id uuid,p_event text,p_reference text,p_external_campaign_id text default null,
  p_external_ad_id text default null,p_detail text default null)
returns public.google_operator_events_v7 language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare b public.google_operator_bundles_v7%rowtype;
  prior public.google_operator_events_v7%rowtype;
  result public.google_operator_events_v7%rowtype;
begin
  select * into b from public.google_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null then raise exception 'Google operator bundle unavailable.' using errcode='23514'; end if;
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not public.can_access_client(b.client_id) then
    raise exception 'Client operator required.' using errcode='42501'; end if;
  if not coalesce(public.google_operator_bundle_approved_v7(b.id),false) then
    raise exception 'The exact Google operator bundle is stale or not approved.' using errcode='23514';
  end if;
  if p_event is null or p_event not in ('verified_download','handoff_reported',
    'external_ids_reported','activation_reported','change_reported')
    or nullif(btrim(p_reference),'') is null then
    raise exception 'Supported event and evidence reference required.' using errcode='23514'; end if;
  select * into prior from public.google_operator_events_v7
    where bundle_id=b.id and event=p_event and reference=btrim(p_reference);
  if prior.id is not null then
    if prior.external_campaign_id is distinct from nullif(btrim(p_external_campaign_id),'')
      or prior.external_ad_id is distinct from nullif(btrim(p_external_ad_id),'')
      or prior.detail is distinct from nullif(btrim(p_detail),'') then
      raise exception 'Evidence reference already records different data.' using errcode='23514'; end if;
    return prior;
  end if;
  if p_event='verified_download' and p_reference is distinct from 'sha256:'||b.snapshot_hash then
    raise exception 'Verified download must cite the exact packet hash.' using errcode='23514'; end if;
  if p_event='handoff_reported' and not exists(select 1 from public.google_operator_events_v7
      where bundle_id=b.id and event='verified_download'
        and reference='sha256:'||b.snapshot_hash) then
    raise exception 'Verify the exact packet bytes before reporting handoff.' using errcode='23514'; end if;
  if p_event not in ('verified_download','handoff_reported')
    and not exists(select 1 from public.google_operator_events_v7
      where bundle_id=b.id and event='handoff_reported') then
    raise exception 'Operator handoff must be recorded first.' using errcode='23514'; end if;
  if p_event in ('external_ids_reported','activation_reported','change_reported')
    and nullif(btrim(p_external_campaign_id),'') is null then
    raise exception 'External Google campaign resource is required.' using errcode='23514'; end if;
  insert into public.google_operator_events_v7
    (bundle_id,client_id,event,reference,external_campaign_id,external_ad_id,detail,recorded_by)
  values(b.id,b.client_id,p_event,btrim(p_reference),nullif(btrim(p_external_campaign_id),''),
    nullif(btrim(p_external_ad_id),''),nullif(btrim(p_detail),''),auth.uid())
  returning * into result;
  return result;
end $$;
revoke all on function public.record_google_operator_event_v7(uuid,text,text,text,text,text)
  from public,anon,service_role;
grant execute on function public.record_google_operator_event_v7(uuid,text,text,text,text,text)
  to authenticated;
select public.lock_down_definer_functions();
