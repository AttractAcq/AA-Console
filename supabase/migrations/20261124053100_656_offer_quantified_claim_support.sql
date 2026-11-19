-- New structured offers may cite a quantified result only when the cleared
-- proof actually states that claim and records evidence for it. Legacy offer
-- versions retain their existing rights-only gate and historical decisions.
begin;

create function public.offer_quantified_claims_current_v11(p_version_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare v public.service_offer_versions%rowtype; v_claim jsonb;
begin
  select * into v from public.service_offer_versions where id=p_version_id;
  if not found then return false; end if;
  for v_claim in select value from jsonb_array_elements(v.claims) loop
    if v_claim->>'kind'='quantified' and (
      coalesce(v_claim->>'proof_asset_id','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not exists(select 1 from public.client_proof_assets proof
        where proof.id::text=v_claim->>'proof_asset_id'
          and proof.client_id=v.client_id and proof.usage_rights='approved'
          and (proof.expires_on is null or proof.expires_on>=current_date)
          and nullif(btrim(proof.evidence),'') is not null
          and lower(regexp_replace(btrim(proof.claim),'[[:space:]]+',' ','g')) =
            lower(regexp_replace(btrim(v_claim->>'text'),'[[:space:]]+',' ','g')))
    ) then return false; end if;
  end loop;
  return true;
end $$;
revoke all on function public.offer_quantified_claims_current_v11(uuid)
  from public,anon,authenticated,service_role;

-- Keep the Inbox blocker and the AAL2 signoff transaction on the same rule.
create or replace function public.service_offer_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare r public.approval_requests_v6%rowtype;
  v public.service_offer_versions%rowtype; o public.service_offers%rowtype;
  s public.secondary_offer_sources_v7%rowtype; v_claim jsonb;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if not found or r.source_system<>'aa_console' or r.source_kind<>'service_offer'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  if r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into v from public.service_offer_versions where id=r.source_id::uuid;
  if not found then return 'cancelled'; end if;
  if v.client_id is distinct from r.client_id
    or v.content_hash is distinct from r.source_version
    or v.content_hash is distinct from r.artifact_hash
    or public.service_offer_approval_preview_v6(v) is distinct from r.preview
    or r.scope is distinct from jsonb_build_object(
      'client_id',v.client_id,'offer_id',v.offer_id,
      'offer_version_id',v.id,'version',v.version,'content_hash',v.content_hash)
    then return 'superseded'; end if;
  if exists(select 1 from public.service_offer_versions newer
    where newer.offer_id=v.offer_id and newer.version>v.version) then return 'superseded'; end if;
  select * into o from public.service_offers where id=v.offer_id and client_id=v.client_id;
  if o.archived_at is not null then return 'source_held'; end if;
  if o.kind='secondary' then
    select * into s from public.secondary_offer_sources_v7
      where offer_id=o.id and client_id=o.client_id;
    if not found or not public.opportunity_approval_current_v6(s.opportunity_id)
      or public.opportunity_approval_hash_v6(s.opportunity_id) is distinct from s.opportunity_hash
      or public.opportunity_approval_preview_v6(s.opportunity_id) is distinct from s.opportunity_snapshot
      then return 'source_held'; end if;
  elsif exists(select 1 from public.main_offer_sources_v7 main where main.offer_id=o.id)
    and not coalesce(public.main_offer_source_current_v7(o.id),false) then
    return 'source_held';
  end if;
  if exists(select 1 from public.service_offer_signoffs signed
    where signed.offer_version_id=v.id) then return 'source_decided'; end if;
  if v.value_equation is not null then
    if not public.offer_quantified_claims_current_v11(v.id) then return 'source_held'; end if;
  else
    for v_claim in select value from jsonb_array_elements(v.claims) loop
      if v_claim->>'kind'='quantified' and
        (coalesce(v_claim->>'proof_asset_id','') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not exists(select 1 from public.client_proof_assets proof
          where proof.id::text=v_claim->>'proof_asset_id'
            and proof.client_id=v.client_id and proof.usage_rights='approved'
            and (proof.expires_on is null or proof.expires_on>=current_date)))
        then return 'source_held'; end if;
    end loop;
  end if;
  return 'pending';
end $$;

-- A proof edit after signoff must also block a new campaign or package link.
create function public.guard_offer_claims_at_campaign_use_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare v public.service_offer_versions%rowtype;
begin
  if new.offer_version_id is null then return new; end if;
  select * into v from public.service_offer_versions where id=new.offer_version_id;
  if found and v.value_equation is not null and
    not public.offer_quantified_claims_current_v11(v.id) then
    raise exception 'The offer claim no longer matches current cleared proof.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger guard_offer_claims_campaign_v11
  before insert or update of offer_version_id on public.client_campaigns
  for each row execute function public.guard_offer_claims_at_campaign_use_v11();
create trigger guard_offer_claims_manifest_v11
  before insert or update of offer_version_id on public.campaign_manifest_offers
  for each row execute function public.guard_offer_claims_at_campaign_use_v11();
revoke all on function public.guard_offer_claims_at_campaign_use_v11()
  from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
