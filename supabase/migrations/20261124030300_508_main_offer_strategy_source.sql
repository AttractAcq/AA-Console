-- Phase 3: freeze reviewed Offer Strategy at main-offer creation and recheck it
-- in the same transaction that writes an agent-compiled offer version.
begin;

create function public.reviewed_offer_strategy_snapshot_v7(p_client_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare result jsonb;
begin
  if auth.role() not in ('authenticated','service_role') or p_client_id is null
    or (auth.role()='authenticated' and not public.can_access_client(p_client_id)) then
    raise exception 'The client strategy is unavailable.' using errcode='42501'; end if;
  if exists(select 1 from public.record_templates t
    where t.domain='offer_strategy' and not exists(
      select 1 from public.model_section_review_state_v7 s
      where s.client_id=p_client_id and s.domain='offer_strategy'
        and s.item_key=t.item_key and s.review_state='supported'
        and nullif(btrim(coalesce(s.body,'')),'') is not null)) then
    raise exception 'Review every Offer Strategy section against dated source evidence.'
      using errcode='23514'; end if;
  if exists(select 1 from public.model_section_review_state_v7 s
    where s.client_id=p_client_id and s.domain='offer_strategy'
      and (s.review_state<>'supported' or
        nullif(btrim(coalesce(s.body,'')),'') is null or s.source_ref is null
        or s.observed_on is null)) then
    raise exception 'Offer Strategy has missing, stale or unsupported source review.'
      using errcode='23514'; end if;
  select jsonb_agg(jsonb_build_object(
    'record_id',s.record_id,'item_key',s.item_key,'title',s.title,'body',s.body,
    'record_hash',s.record_hash,'review_state',s.review_state,
    'model_job_id',s.model_job_id,
    'source_ref',s.source_ref,'observed_on',s.observed_on,
    'review_id',s.review_id,'reviewed_at',s.reviewed_at)
    order by s.item_key,s.record_id) into result
  from public.model_section_review_state_v7 s
  where s.client_id=p_client_id and s.domain='offer_strategy';
  if result is null or result='[]'::jsonb then
    raise exception 'Create and review Offer Strategy before building a main offer.'
      using errcode='23514'; end if;
  return result;
end $$;
revoke all on function public.reviewed_offer_strategy_snapshot_v7(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.reviewed_offer_strategy_snapshot_v7(uuid)
  to authenticated,service_role;

create table public.main_offer_sources_v7 (
  offer_id uuid primary key,
  client_id uuid not null,
  strategy_hash text not null check(strategy_hash ~ '^[0-9a-f]{64}$'),
  strategy_snapshot jsonb not null check(jsonb_typeof(strategy_snapshot)='array'),
  compile_job_id uuid references public.agent_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key(offer_id,client_id) references public.service_offers(id,client_id)
    on delete cascade
);
alter table public.main_offer_sources_v7 enable row level security;
create policy main_offer_sources_v7_read on public.main_offer_sources_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.main_offer_sources_v7 from public,anon,authenticated;
grant select on public.main_offer_sources_v7 to authenticated,service_role;

create function public.main_offer_source_current_v7(p_offer_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare s public.main_offer_sources_v7%rowtype; current_snapshot jsonb;
begin
  select * into s from public.main_offer_sources_v7 where offer_id=p_offer_id;
  if not found then return null; end if;
  if auth.role()='authenticated' and not public.can_access_client(s.client_id) then
    return false; end if;
  begin
    current_snapshot:=public.reviewed_offer_strategy_snapshot_v7(s.client_id);
  exception when others then return false; end;
  return current_snapshot=s.strategy_snapshot
    and encode(sha256(convert_to(current_snapshot::text,'UTF8')),'hex')=s.strategy_hash;
end $$;
revoke all on function public.main_offer_source_current_v7(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.main_offer_source_current_v7(uuid)
  to authenticated,service_role;

create function public.create_main_offer_v7(p_client_id uuid)
returns public.service_offers language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare snapshot jsonb; result public.service_offers%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not (coalesce(public.is_admin(),false) or
      coalesce(auth.uid()=public.active_video_approval_manager(p_client_id),false)) then
    raise exception 'Only the client manager may create this offer.' using errcode='42501'; end if;
  snapshot:=public.reviewed_offer_strategy_snapshot_v7(p_client_id);
  insert into public.service_offers(client_id,kind,service_name)
    values(p_client_id,'main','New main offer') returning * into result;
  insert into public.main_offer_sources_v7
    (offer_id,client_id,strategy_hash,strategy_snapshot)
  values(result.id,p_client_id,
    encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),snapshot);
  return result;
end $$;
revoke all on function public.create_main_offer_v7(uuid) from public,anon,service_role;
grant execute on function public.create_main_offer_v7(uuid) to authenticated;

create function public.create_compiled_main_offer_v7(
  p_client_id uuid,p_strategy_snapshot jsonb,p_job_id uuid,
  p_service_name text,p_audience text,p_promise text,p_inclusions text[],
  p_exclusions text[],p_idempotency_key text
) returns public.service_offer_versions language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare j public.agent_jobs%rowtype; existing public.service_offer_versions%rowtype;
  current_snapshot jsonb; offer_id uuid; result public.service_offer_versions%rowtype;
  v_strategy_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service can compile an offer.' using errcode='42501'; end if;
  if p_strategy_snapshot is null or jsonb_typeof(p_strategy_snapshot)<>'array' then
    raise exception 'A reviewed Strategy snapshot is required.' using errcode='23514'; end if;
  v_strategy_hash:=encode(sha256(convert_to(p_strategy_snapshot::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    p_client_id::text||':offer:'||btrim(p_idempotency_key),0));
  select * into existing from public.service_offer_versions
    where client_id=p_client_id and idempotency_key=btrim(p_idempotency_key);
  if found then
    if not exists(select 1 from public.main_offer_sources_v7 s
      where s.offer_id=existing.offer_id and s.compile_job_id=p_job_id
        and s.strategy_hash=v_strategy_hash and s.strategy_snapshot=p_strategy_snapshot) then
      raise exception 'The idempotency key belongs to a different Strategy source.'
        using errcode='23514'; end if;
    return existing;
  end if;
  select * into j from public.agent_jobs where id=p_job_id and client_id=p_client_id
    and agent_key='offer_compile' and params->>'kind'='main'
    and params->>'source'='strategy';
  if not found then raise exception 'The compile job has no matching Strategy source.'
    using errcode='23514'; end if;
  current_snapshot:=public.reviewed_offer_strategy_snapshot_v7(p_client_id);
  if current_snapshot is distinct from p_strategy_snapshot then
    raise exception 'Offer Strategy changed during compilation. Recompile.'
      using errcode='23514'; end if;
  insert into public.service_offers(client_id,kind,service_name)
    values(p_client_id,'main',btrim(p_service_name)) returning id into offer_id;
  insert into public.main_offer_sources_v7
    (offer_id,client_id,strategy_hash,strategy_snapshot,compile_job_id)
    values(offer_id,p_client_id,v_strategy_hash,p_strategy_snapshot,p_job_id);
  result:=public.create_service_offer_version_v6(p_client_id,p_service_name,
    p_audience,p_promise,p_inclusions,p_exclusions,null,null,null,'[]'::jsonb,
    p_idempotency_key,offer_id);
  return result;
end $$;
revoke all on function public.create_compiled_main_offer_v7(
  uuid,jsonb,uuid,text,text,text,text[],text[],text) from public,anon,authenticated;
grant execute on function public.create_compiled_main_offer_v7(
  uuid,jsonb,uuid,text,text,text,text[],text[],text) to service_role;

create or replace function public.service_offer_approval_preview_v6(p_version public.service_offer_versions)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
  select jsonb_build_object(
    'offer_id',p_version.offer_id,'offer_version_id',p_version.id,
    'client_id',p_version.client_id,'version',p_version.version,
    'service_name',o.service_name,'audience',p_version.audience,
    'promise',p_version.promise,'inclusions',p_version.inclusions,
    'exclusions',p_version.exclusions,'price_amount',p_version.price_amount,
    'currency',p_version.currency,'delivery_cost_estimate',p_version.delivery_cost_estimate,
    'claims',p_version.claims)
    || case when o.kind='secondary' then jsonb_build_object(
      'kind',o.kind,'source_opportunity_id',secondary.opportunity_id,
      'source_opportunity_hash',secondary.opportunity_hash,
      'source_opportunity_snapshot',secondary.opportunity_snapshot)
      when main.offer_id is not null then jsonb_build_object(
      'kind','main','strategy_hash',main.strategy_hash,
      'strategy_snapshot',main.strategy_snapshot)
      else '{}'::jsonb end
  from public.service_offers o
  left join public.secondary_offer_sources_v7 secondary on secondary.offer_id=o.id
  left join public.main_offer_sources_v7 main on main.offer_id=o.id
  where o.id=p_version.offer_id and o.client_id=p_version.client_id;
$$;

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
  return 'pending';
end $$;

-- Existing direct-created main offers retain their historical v6 path. New
-- source-bound main offers cannot be attached once Strategy review drifts.
create or replace function public.secondary_offer_source_current_v7(p_offer_id uuid)
returns boolean language sql stable security definer
set search_path=pg_catalog,public as $$
  select case when o.kind='secondary' then
    exists(select 1 from public.secondary_offer_sources_v7 s
      where s.offer_id=o.id and s.client_id=o.client_id
        and public.opportunity_approval_current_v6(s.opportunity_id)
        and public.opportunity_approval_hash_v6(s.opportunity_id)=s.opportunity_hash
        and public.opportunity_approval_preview_v6(s.opportunity_id)=s.opportunity_snapshot)
    when exists(select 1 from public.main_offer_sources_v7 m where m.offer_id=o.id)
      then coalesce(public.main_offer_source_current_v7(o.id),false)
    else true end
  from public.service_offers o where o.id=p_offer_id
    and (auth.role()='service_role' or public.can_access_client(o.client_id));
$$;

select public.lock_down_definer_functions();
commit;
