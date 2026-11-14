-- A market opportunity is a hypothesis until a person reviews the exact
-- evaluated state that will become eligible for campaigns.
begin;
alter table public.market_opportunities
  add column approval_request_token uuid,
  add column approved_request_id uuid references public.approval_requests_v6(id),
  add column approved_content_hash text check (
    approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$');

create function public.opportunity_approval_preview_v6(p_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'opportunity_id',o.id,'client_id',o.client_id,
    'request_token',o.approval_request_token,
    'opportunity',to_jsonb(o) - array['status','status_note','updated_at',
      'approval_request_token','approved_request_id','approved_content_hash'],
    'score',(select to_jsonb(s) from public.opportunity_scores s
      where s.opportunity_id = o.id order by s.scored_at desc,s.id desc limit 1),
    'attributes',coalesce((select jsonb_agg(jsonb_build_object(
      'kind',a.kind,'position',a.position,'body',a.body)
      order by a.kind,a.position) from public.opportunity_attributes a
      where a.opportunity_id = o.id),'[]'::jsonb),
    'awareness',coalesce((select jsonb_agg(jsonb_build_object(
      'stage',a.stage,'mindset',a.mindset,'message',a.message,
      'asset_direction',a.asset_direction,'distribution_note',a.distribution_note)
      order by a.stage) from public.opportunity_awareness_stages a
      where a.opportunity_id = o.id),'[]'::jsonb),
    'links',coalesce((select jsonb_agg(jsonb_build_object(
      'role',l.role,'record_id',l.record_id,'offer_id',l.offer_id,
      'campaign_id',l.campaign_id,
      'record',case when r.id is not null then jsonb_build_object(
        'domain',r.domain,'title',r.title,'body',r.body,'status',r.status,
        'updated_at',r.updated_at) else null end)
      order by l.role,l.id) from public.opportunity_links l
      left join public.client_agent_records r on r.id = l.record_id
      where l.opportunity_id = o.id and l.role <> 'campaign'),'[]'::jsonb),
    'proof_requirements',coalesce((select jsonb_agg(jsonb_build_object(
      'requirement',q.requirement,'proof_id',q.proof_id,
      'proof_rights',p.usage_rights,'proof_expiry',p.expires_on,
      'proof_basis',p.permission_basis) order by q.id)
      from public.opportunity_proof_requirements q
      left join public.client_proof_assets p on p.id = q.proof_id
      where q.opportunity_id = o.id),'[]'::jsonb),
    'consequence','Allows a campaign to be planned against this evidenced buying situation'
  ) from public.market_opportunities o where o.id = p_id;
$$;
create function public.opportunity_approval_hash_v6(p_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    (public.opportunity_approval_preview_v6(p_id) - 'request_token')::text,
    'UTF8')),'hex');
$$;
create function public.opportunity_approval_scope_v6(p_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object('client_id',o.client_id,'opportunity_id',o.id,
    'request_token',o.approval_request_token,
    'content_hash',public.opportunity_approval_hash_v6(o.id),
    'consequence','May be used as an input to a client campaign')
  from public.market_opportunities o where o.id = p_id;
$$;

create function public.opportunity_approval_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  o public.market_opportunities%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id = p_request_id;
  if r.id is null then return 'unverified'; end if;
  if r.source_system is distinct from 'aa_console' then return 'unverified'; end if;
  if r.source_kind is distinct from 'opportunity_approve' then return 'unverified'; end if;
  if r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into o from public.market_opportunities
    where id = r.source_id::uuid and client_id = r.client_id;
  if o.id is null then return 'cancelled'; end if;
  h := public.opportunity_approval_hash_v6(o.id);
  if o.approval_request_token is null or r.source_version is distinct from
    h || ':' || o.approval_request_token::text or r.artifact_hash is distinct from h
    or r.preview is distinct from public.opportunity_approval_preview_v6(o.id)
    or r.scope is distinct from public.opportunity_approval_scope_v6(o.id)
    or r.destination is distinct from 'campaign_factory:opportunity:' || o.id::text
    then return 'superseded'; end if;
  if o.status = 'approved' and o.approved_request_id = r.id
    and o.approved_content_hash = h then return 'source_decided'; end if;
  if o.status <> 'validated' or exists (select 1 from public.opportunity_readiness ready
      where ready.opportunity_id = o.id and ready.blocker is not null)
    then return 'source_held'; end if;
  return 'pending';
end $$;

create function public.request_opportunity_approval_v6(p_opportunity_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare o public.market_opportunities%rowtype;
  h text; existing uuid;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must request opportunity approval.' using errcode = '42501'; end if;
  select * into o from public.market_opportunities where id = p_opportunity_id for update;
  if not found or not public.can_shape_opportunity(o.client_id) then
    raise exception 'The opportunity or its decision owner is unavailable.' using errcode = '42501'; end if;
  if o.status <> 'validated' or exists (select 1 from public.opportunity_readiness ready
      where ready.opportunity_id = o.id and ready.blocker is not null)
    or exists (select 1 from public.opportunity_proof_requirements q
      left join public.client_proof_assets p on p.id = q.proof_id and p.client_id = q.client_id
      where q.opportunity_id = o.id and
        (q.proof_id is null or p.id is null or p.usage_rights <> 'approved'
          or (p.expires_on is not null and p.expires_on < current_date))) then
    raise exception 'Resolve the opportunity readiness blocker before requesting approval.'
      using errcode = '23514'; end if;
  h := public.opportunity_approval_hash_v6(o.id);
  if o.approval_request_token is not null then
    select r.id into existing from public.approval_requests_v6 r
      where r.source_system = 'aa_console' and r.source_kind = 'opportunity_approve'
        and r.source_id = o.id::text and
        r.source_version = h || ':' || o.approval_request_token::text
        and r.expires_at > now();
    if existing is not null and public.opportunity_approval_source_state_v6(existing) = 'pending'
      and exists (select 1 from public.approval_inbox_v6 i
        where i.id = existing and i.status = 'pending') then return existing; end if;
  end if;
  update public.market_opportunities set approval_request_token = gen_random_uuid()
    where id = o.id returning * into o;
  return public.register_approval_request_v6(jsonb_build_object(
    'client_id',o.client_id,'source_system','aa_console',
    'source_kind','opportunity_approve','source_id',o.id::text,
    'source_version',h || ':' || o.approval_request_token::text,
    'title','Approve market opportunity: ' || o.name,
    'artifact_hash',h,'preview',public.opportunity_approval_preview_v6(o.id),
    'destination','campaign_factory:opportunity:' || o.id::text,
    'scope',public.opportunity_approval_scope_v6(o.id),
    'owner_role','admin_or_active_client_manager',
    'requested_by',auth.uid(),'requester_kind','human',
    'expires_at',now() + interval '7 days',
    'owning_path','/clients/' || o.client_id::text ||
      '/delivery/market-opportunities?opportunity=' || o.id::text));
end $$;

revoke all on function public.opportunity_approval_preview_v6(uuid) from public,anon,authenticated,service_role;
revoke all on function public.opportunity_approval_hash_v6(uuid) from public,anon,authenticated,service_role;
revoke all on function public.opportunity_approval_scope_v6(uuid) from public,anon,authenticated,service_role;
revoke all on function public.opportunity_approval_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.opportunity_approval_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_opportunity_approval_v6(uuid) from public,anon,service_role;
grant execute on function public.request_opportunity_approval_v6(uuid) to authenticated;
select public.lock_down_definer_functions();
commit;
