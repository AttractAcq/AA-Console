-- Phase 3: a secondary offer is sourced from one approved opportunity.
-- The approved evidence preview is frozen with the offer. Later evidence edits
-- hold new signoffs and campaign selection until the offer is reviewed again.
begin;

create table public.secondary_offer_sources_v7 (
  offer_id uuid primary key,
  client_id uuid not null,
  opportunity_id uuid not null,
  opportunity_hash text not null check (opportunity_hash ~ '^[0-9a-f]{64}$'),
  opportunity_snapshot jsonb not null check (jsonb_typeof(opportunity_snapshot) = 'object'),
  compile_job_id uuid references public.agent_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (offer_id, client_id) references public.service_offers(id, client_id) on delete cascade,
  foreign key (opportunity_id, client_id) references public.market_opportunities(id, client_id)
);
create index secondary_offer_sources_v7_opportunity_idx
  on public.secondary_offer_sources_v7(opportunity_id);
alter table public.secondary_offer_sources_v7 enable row level security;
create policy secondary_offer_sources_v7_read on public.secondary_offer_sources_v7
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.secondary_offer_sources_v7 from public, anon, authenticated;
grant select on public.secondary_offer_sources_v7 to authenticated, service_role;

-- Offer links are downstream outputs. Including them in the opportunity's
-- approval hash made the act of linking a new offer revoke its own source.
-- Preserve all input links, scores, attributes, and proof in that hash.
create or replace function public.opportunity_approval_preview_v6(p_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'opportunity_id',o.id,'client_id',o.client_id,
    'request_token',o.approval_request_token,
    'opportunity',to_jsonb(o) - array['status','status_note','updated_at',
      'approval_request_token','approved_request_id','approved_content_hash',
      'activated_request_id','activated_content_hash'],
    'score',(select to_jsonb(s) from public.opportunity_scores s
      where s.opportunity_id=o.id order by s.scored_at desc,s.id desc limit 1),
    'attributes',coalesce((select jsonb_agg(jsonb_build_object(
      'kind',a.kind,'position',a.position,'body',a.body)
      order by a.kind,a.position) from public.opportunity_attributes a
      where a.opportunity_id=o.id),'[]'::jsonb),
    'awareness',coalesce((select jsonb_agg(jsonb_build_object(
      'stage',a.stage,'mindset',a.mindset,'message',a.message,
      'asset_direction',a.asset_direction,'distribution_note',a.distribution_note)
      order by a.stage) from public.opportunity_awareness_stages a
      where a.opportunity_id=o.id),'[]'::jsonb),
    'links',coalesce((select jsonb_agg(jsonb_build_object(
      'role',l.role,'record_id',l.record_id,'offer_id',l.offer_id,
      'campaign_id',l.campaign_id,
      'record',case when r.id is not null then jsonb_build_object(
        'domain',r.domain,'title',r.title,'body',r.body,'status',r.status,
        'updated_at',r.updated_at) else null end)
      order by l.role,l.id) from public.opportunity_links l
      left join public.client_agent_records r on r.id=l.record_id
      left join public.service_offers linked_offer on linked_offer.id=l.offer_id
      where l.opportunity_id=o.id
        and (l.role in ('parent_icp','market','competitor','association')
          or (l.role='offer' and linked_offer.kind='main'))),'[]'::jsonb),
    'proof_requirements',coalesce((select jsonb_agg(jsonb_build_object(
      'requirement',q.requirement,'proof_id',q.proof_id,
      'proof_rights',p.usage_rights,'proof_expiry',p.expires_on,
      'proof_basis',p.permission_basis) order by q.id)
      from public.opportunity_proof_requirements q
      left join public.client_proof_assets p on p.id=q.proof_id
      where q.opportunity_id=o.id),'[]'::jsonb),
    'consequence','Allows a campaign to be planned against this evidenced buying situation'
  ) from public.market_opportunities o where o.id=p_id;
$$;

create function public.create_secondary_offer_v7(p_opportunity_id uuid)
returns public.service_offers language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare o public.market_opportunities%rowtype;
  result public.service_offers%rowtype; h text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'A provisioned human must create this offer.' using errcode = '42501'; end if;
  select * into o from public.market_opportunities where id=p_opportunity_id for share;
  if not found or not public.can_shape_opportunity(o.client_id) then
    raise exception 'The opportunity or its owner is unavailable.' using errcode = '42501'; end if;
  if not public.opportunity_approval_current_v6(o.id) then
    raise exception 'Approve the current opportunity evidence before creating a secondary offer.'
      using errcode = '23514'; end if;
  h := public.opportunity_approval_hash_v6(o.id);
  insert into public.service_offers(client_id,kind,service_name)
    values(o.client_id,'secondary','New secondary offer') returning * into result;
  insert into public.secondary_offer_sources_v7
    (offer_id,client_id,opportunity_id,opportunity_hash,opportunity_snapshot)
    values(result.id,o.client_id,o.id,h,public.opportunity_approval_preview_v6(o.id));
  perform public.link_opportunity_v6(o.id,'offer',result.id);
  return result;
end $$;
revoke all on function public.create_secondary_offer_v7(uuid) from public,anon,service_role;
grant execute on function public.create_secondary_offer_v7(uuid) to authenticated;

-- The old queue function is retained for existing callers but now enforces
-- the kind/source pairing and captures the exact approved evidence hash.
create or replace function public.request_offer_compile_v6(
  p_client_id uuid,p_kind text,p_source text,p_opportunity_id uuid default null
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare o public.market_opportunities%rowtype; v_running integer; h text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not public.can_access_client(p_client_id) then
    raise exception 'A provisioned client account is required.' using errcode = '42501'; end if;
  if p_kind not in ('main','secondary') or p_kind is null then
    raise exception 'An offer is a main offer or a secondary offer.'; end if;
  if p_source not in ('strategy','micro_niche') or p_source is null then
    raise exception 'Compile from offer strategy or from a micro-niche.'; end if;
  if (p_kind='main' and (p_source<>'strategy' or p_opportunity_id is not null))
    or (p_kind='secondary' and (p_source<>'micro_niche' or p_opportunity_id is null)) then
    raise exception 'A main offer uses strategy; a secondary offer needs one approved opportunity.'
      using errcode = '23514'; end if;
  if p_kind='secondary' then
    select * into o from public.market_opportunities where id=p_opportunity_id for share;
    if not found or o.client_id<>p_client_id or not public.can_shape_opportunity(o.client_id) then
      raise exception 'The opportunity or its owner is unavailable.' using errcode = '42501'; end if;
    if not public.opportunity_approval_current_v6(o.id) then
      raise exception 'Approve the current opportunity evidence before compiling a secondary offer.'
        using errcode = '23514'; end if;
    h := public.opportunity_approval_hash_v6(o.id);
  end if;
  select count(*) into v_running from public.agent_jobs j
    where j.agent_key='offer_compile' and j.client_id=p_client_id
      and j.params->>'kind'=p_kind and j.status in ('queued','claimed','running');
  if v_running>0 then raise exception 'A % offer is already being compiled for this client.',p_kind; end if;
  return public.enqueue_agent_job_internal(
    'offer_compile',p_client_id,
    case when p_kind='secondary' then 'market_opportunities' else null end,
    p_opportunity_id,auth.uid(),
    jsonb_build_object('kind',p_kind,'source',p_source,'opportunity_hash',h),
    'Queued: compile a '||p_kind||' offer from '||
      case when p_kind='main' then 'offer strategy' else 'an approved micro-niche' end);
end $$;

create function public.create_compiled_secondary_offer_v7(
  p_client_id uuid,p_opportunity_id uuid,p_opportunity_hash text,p_job_id uuid,
  p_service_name text,p_audience text,p_promise text,p_inclusions text[],
  p_exclusions text[],p_idempotency_key text
) returns public.service_offer_versions language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare o public.market_opportunities%rowtype; j public.agent_jobs%rowtype;
  existing public.service_offer_versions%rowtype; offer_id uuid;
  result public.service_offer_versions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service can compile an offer.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text||':offer:'||btrim(p_idempotency_key),0));
  select * into existing from public.service_offer_versions
    where client_id=p_client_id and idempotency_key=btrim(p_idempotency_key);
  if found then
    if not exists(select 1 from public.secondary_offer_sources_v7 s
      where s.offer_id=existing.offer_id and s.opportunity_id=p_opportunity_id
        and s.opportunity_hash=p_opportunity_hash and s.compile_job_id=p_job_id) then
      raise exception 'The idempotency key belongs to a different source.' using errcode='23514'; end if;
    return existing;
  end if;
  select * into j from public.agent_jobs where id=p_job_id and client_id=p_client_id
    and agent_key='offer_compile' and input_table='market_opportunities'
    and input_id=p_opportunity_id and params->>'kind'='secondary'
    and params->>'source'='micro_niche'
    and params->>'opportunity_hash'=p_opportunity_hash;
  if not found then raise exception 'The compile job has no matching source.' using errcode='23514'; end if;
  select * into o from public.market_opportunities
    where id=p_opportunity_id and client_id=p_client_id for share;
  if not found or not public.opportunity_approval_current_v6(o.id)
    or public.opportunity_approval_hash_v6(o.id) is distinct from p_opportunity_hash then
    raise exception 'The opportunity evidence changed or is no longer approved. Recompile.'
      using errcode='23514'; end if;
  insert into public.service_offers(client_id,kind,service_name)
    values(p_client_id,'secondary',btrim(p_service_name)) returning id into offer_id;
  insert into public.secondary_offer_sources_v7
    (offer_id,client_id,opportunity_id,opportunity_hash,opportunity_snapshot,compile_job_id)
    values(offer_id,p_client_id,o.id,p_opportunity_hash,
      public.opportunity_approval_preview_v6(o.id),p_job_id);
  perform public.link_opportunity_v6(o.id,'offer',offer_id);
  result := public.create_service_offer_version_v6(
    p_client_id,p_service_name,p_audience,p_promise,p_inclusions,p_exclusions,
    null,null,null,'[]'::jsonb,p_idempotency_key,offer_id);
  return result;
end $$;
revoke all on function public.create_compiled_secondary_offer_v7(
  uuid,uuid,text,uuid,text,text,text,text[],text[],text) from public,anon,authenticated;
grant execute on function public.create_compiled_secondary_offer_v7(
  uuid,uuid,text,uuid,text,text,text,text[],text[],text) to service_role;

create or replace function public.service_offer_approval_preview_v6(p_version public.service_offer_versions)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
  select jsonb_build_object(
    'offer_id',p_version.offer_id,'offer_version_id',p_version.id,
    'client_id',p_version.client_id,'version',p_version.version,
    'service_name',o.service_name,'audience',p_version.audience,
    'promise',p_version.promise,'inclusions',p_version.inclusions,
    'exclusions',p_version.exclusions,'price_amount',p_version.price_amount,
    'currency',p_version.currency,'delivery_cost_estimate',p_version.delivery_cost_estimate,
    'claims',p_version.claims) || case when o.kind='secondary' then jsonb_build_object(
    'kind',o.kind,'source_opportunity_id',s.opportunity_id,
    'source_opportunity_hash',s.opportunity_hash,
    'source_opportunity_snapshot',s.opportunity_snapshot) else '{}'::jsonb end
  from public.service_offers o
  left join public.secondary_offer_sources_v7 s on s.offer_id=o.id
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

create function public.secondary_offer_source_current_v7(p_offer_id uuid)
returns boolean language sql stable security definer
set search_path=pg_catalog,public as $$
  select case when o.kind <> 'secondary' then true else
    exists(select 1 from public.secondary_offer_sources_v7 s
      where s.offer_id=o.id and s.client_id=o.client_id
        and public.opportunity_approval_current_v6(s.opportunity_id)
        and public.opportunity_approval_hash_v6(s.opportunity_id)=s.opportunity_hash
        and public.opportunity_approval_preview_v6(s.opportunity_id)=s.opportunity_snapshot)
    end
  from public.service_offers o where o.id=p_offer_id
    and (auth.role()='service_role' or public.can_access_client(o.client_id));
$$;
revoke all on function public.secondary_offer_source_current_v7(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.secondary_offer_source_current_v7(uuid)
  to authenticated,service_role;

create or replace function public.guard_campaign_offer_version_v6()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare v_offer_id uuid;
begin
  if tg_op='UPDATE' and old.offer_version_id is distinct from new.offer_version_id
     and (old.offer_version_id is not null or old.built_at is not null) then
    raise exception 'Choose the campaign offer before planning; create a new campaign for another offer.';
  end if;
  if new.offer_version_id is not null then
    select v.offer_id into v_offer_id from public.service_offer_versions v
      join public.service_offer_signoffs s on s.offer_version_id=v.id
        and s.client_id=v.client_id
      where v.id=new.offer_version_id and v.client_id=new.client_id;
    if v_offer_id is null then
      raise exception 'Choose an approved offer version belonging to this client.';
    end if;
    if not coalesce(public.secondary_offer_source_current_v7(v_offer_id),false) then
      raise exception 'The secondary offer opportunity evidence is missing or stale.'
        using errcode='23514';
    end if;
  end if;
  return new;
end $$;

create or replace function public.guard_manifest_offer_matches_campaign_v6()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare selected uuid; v_offer_id uuid;
begin
  select offer_version_id into selected from public.client_campaigns
    where id=new.campaign_id and client_id=new.client_id;
  if selected is not null and selected<>new.offer_version_id then
    raise exception 'Campaign package must use its selected offer version.'; end if;
  select v.offer_id into v_offer_id from public.service_offer_versions v
    where v.id=new.offer_version_id and v.client_id=new.client_id;
  if v_offer_id is null or not coalesce(public.secondary_offer_source_current_v7(v_offer_id),false) then
    raise exception 'The package offer opportunity evidence is missing or stale.'
      using errcode='23514'; end if;
  return new;
end $$;

select public.lock_down_definer_functions();
commit;
