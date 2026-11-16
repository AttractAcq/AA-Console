-- Phase 2: bind service-offer signoff to the canonical exact-version inbox.
-- No provider action is released by an offer signoff.
begin;

create function public.service_offer_approval_preview_v6(p_version public.service_offer_versions)
returns jsonb language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'offer_id',p_version.offer_id,'offer_version_id',p_version.id,
    'client_id',p_version.client_id,'version',p_version.version,
    'service_name',o.service_name,'audience',p_version.audience,
    'promise',p_version.promise,'inclusions',p_version.inclusions,
    'exclusions',p_version.exclusions,'price_amount',p_version.price_amount,
    'currency',p_version.currency,'delivery_cost_estimate',p_version.delivery_cost_estimate,
    'claims',p_version.claims)
  from public.service_offers o where o.id = p_version.offer_id
    and o.client_id = p_version.client_id;
$$;

create function public.register_service_offer_approval_v6(p_version public.service_offer_versions)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare v_preview jsonb;
begin
  v_preview := public.service_offer_approval_preview_v6(p_version);
  if v_preview is null then raise exception 'Offer source is missing.'; end if;
  return public.register_approval_request_v6(jsonb_build_object(
    'client_id',p_version.client_id,'source_system','aa_console',
    'source_kind','service_offer','source_id',p_version.id::text,
    'source_version',p_version.content_hash,
    'title','Service offer: ' || (v_preview->>'service_name') ||
      ' · version ' || p_version.version::text,
    'artifact_hash',p_version.content_hash,'preview',v_preview,
    'destination','campaign_factory:offer_version',
    'scope',jsonb_build_object('client_id',p_version.client_id,
      'offer_id',p_version.offer_id,'offer_version_id',p_version.id,
      'version',p_version.version,'content_hash',p_version.content_hash),
    'owner_role','admin_or_active_client_manager',
    'requested_by',case when auth.role() = 'authenticated' then auth.uid() else null end,
    'requester_kind',case when auth.role() = 'authenticated' and auth.uid() is not null
      then 'human' when auth.role() = 'service_role' then 'service' else 'unknown' end,
    'requester_ref',case when auth.role() = 'service_role'
      then 'service_offer_versions:' || p_version.id::text else null end,
    'expires_at',now() + interval '7 days',
    'owning_path','/clients/' || p_version.client_id::text || '/delivery/offer-studio?tab=versions&offer=' || p_version.offer_id::text
  ));
end $$;

create function public.register_new_service_offer_approval_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  perform public.register_service_offer_approval_v6(new);
  return new;
end $$;
create trigger service_offer_inbox_request_v6
  after insert on public.service_offer_versions for each row
  execute function public.register_new_service_offer_approval_v6();

-- Existing unsigned latest versions need a visible decision card too. Historical
-- signoffs remain historical; do not fabricate a retroactive AAL2 decision.
do $$ declare v record; begin
  for v in select ov.* from public.service_offer_versions ov
    where not exists (select 1 from public.service_offer_versions newer
      where newer.offer_id = ov.offer_id and newer.version > ov.version)
      and not exists (select 1 from public.service_offer_signoffs s
        where s.offer_version_id = ov.id)
  loop
    perform public.register_service_offer_approval_v6(v);
  end loop;
end $$;

create function public.service_offer_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_version public.service_offer_versions%rowtype;
  v_claim jsonb;
begin
  select * into v_request from public.approval_requests_v6 where id = p_request_id;
  if not found or v_request.source_system <> 'aa_console'
    or v_request.source_kind <> 'service_offer' then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(v_request.client_id,v_request.owner_role))
    then return 'unverified'; end if;
  if v_request.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into v_version from public.service_offer_versions
    where id = v_request.source_id::uuid;
  if not found then return 'cancelled'; end if;
  if v_version.client_id is distinct from v_request.client_id
    or v_version.content_hash is distinct from v_request.source_version
    or v_version.content_hash is distinct from v_request.artifact_hash
    or public.service_offer_approval_preview_v6(v_version) is distinct from v_request.preview
    or v_request.scope is distinct from jsonb_build_object(
      'client_id',v_version.client_id,'offer_id',v_version.offer_id,
      'offer_version_id',v_version.id,'version',v_version.version,
      'content_hash',v_version.content_hash)
    then return 'superseded'; end if;
  if exists (select 1 from public.service_offer_versions newer
    where newer.offer_id = v_version.offer_id and newer.version > v_version.version)
    then return 'superseded'; end if;
  if exists (select 1 from public.service_offer_signoffs s
    where s.offer_version_id = v_version.id) then return 'source_decided'; end if;
  for v_claim in select value from jsonb_array_elements(v_version.claims) loop
    if v_claim->>'kind' = 'quantified' and
      (coalesce(v_claim->>'proof_asset_id','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not exists (select 1 from public.client_proof_assets proof
        where proof.id::text = v_claim->>'proof_asset_id'
          and proof.client_id = v_version.client_id
          and proof.usage_rights = 'approved'
          and (proof.expires_on is null or proof.expires_on >= current_date)))
      then return 'source_held'; end if;
  end loop;
  return 'pending';
end $$;

create or replace function public.approve_service_offer_version_v6(p_version_id uuid)
returns public.service_offer_signoffs language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_version public.service_offer_versions%rowtype;
  v_request public.approval_requests_v6%rowtype;
  v_signoff public.service_offer_signoffs%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned human with AAL2 must approve this offer.' using errcode = '42501';
  end if;
  select * into v_version from public.service_offer_versions where id = p_version_id for share;
  if not found then raise exception 'Offer version not found.'; end if;
  if not (coalesce(public.is_admin(),false) or
    coalesce(auth.uid() = public.active_video_approval_manager(v_version.client_id),false))
    then raise exception 'Only an admin or the active client manager may approve.' using errcode = '42501'; end if;
  select * into v_request from public.approval_requests_v6
    where source_system = 'aa_console' and source_kind = 'service_offer'
      and source_id = p_version_id::text and source_version = v_version.content_hash;
  if not found or public.service_offer_source_state_v6(v_request.id) <> 'pending'
    or not exists (select 1 from public.approval_inbox_v6 i
      where i.id = v_request.id and i.status = 'pending' and i.preview_blocker is null)
    then raise exception 'Review the current exact offer version in the Approval Inbox.' using errcode = '23514'; end if;
  perform public.record_approval_decision_v6(v_request.id,'approved',
    v_version.content_hash,'service_offer_signoff:' || p_version_id::text);
  insert into public.service_offer_signoffs(offer_version_id,client_id,approved_by)
    values (p_version_id,v_version.client_id,auth.uid()) returning * into v_signoff;
  return v_signoff;
end $$;

create function public.reject_service_offer_version_v6(p_version_id uuid,p_reason text)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare v_version public.service_offer_versions%rowtype;
  v_request public.approval_requests_v6%rowtype;
begin
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A rejection reason is required.'; end if;
  select * into v_version from public.service_offer_versions where id = p_version_id for share;
  if not found then raise exception 'Offer version not found.'; end if;
  select * into v_request from public.approval_requests_v6
    where source_system = 'aa_console' and source_kind = 'service_offer'
      and source_id = p_version_id::text and source_version = v_version.content_hash;
  if not found or public.service_offer_source_state_v6(v_request.id)
    not in ('pending','source_held') then
    raise exception 'This offer version is no longer reviewable.' using errcode = '23514'; end if;
  return public.record_approval_decision_v6(v_request.id,'rejected',
    v_version.content_hash,'service_offer_rejection:' || p_version_id::text,p_reason);
end $$;

revoke all on function public.service_offer_approval_preview_v6(public.service_offer_versions)
  from public,anon;
revoke all on function public.register_service_offer_approval_v6(public.service_offer_versions)
  from public,anon,authenticated,service_role;
revoke all on function public.register_new_service_offer_approval_v6()
  from public,anon,authenticated,service_role;
revoke all on function public.service_offer_source_state_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.service_offer_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.reject_service_offer_version_v6(uuid,text)
  from public,anon,service_role;
grant execute on function public.reject_service_offer_version_v6(uuid,text)
  to authenticated;

-- The latest canonical view definition is repeated below with the new source
-- state branch; it remains security_invoker and keeps all prior hold rules.
create or replace view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when r.source_system = 'aa_console'
      and r.source_kind = 'service_offer'
      and d.decision in ('rejected','revoked') then d.decision
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
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then public.production_release_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'recruitment_meta_build'
      then public.recruitment_meta_build_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'organic_publication'
      then public.organic_publication_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'service_offer'
      then public.service_offer_source_state_v6(r.id)
    else public.approval_source_state_v6(r.id)
  end as source_state
) s;
revoke all on public.approval_inbox_v6 from public, anon, authenticated, service_role;
grant select on public.approval_inbox_v6 to authenticated, service_role;

insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
  (12,2,'service_offer','Service offer signoff',
    'verified','327 offer request, exact preview and current source-state checks',
    'verified','327 approve/reject offer functions; AAL2 ledger and signoff transaction',
    'missing',null,
    'Campaign attachment and downstream use still need executor attestation and integration testing.');

commit;
