begin;

alter table public.opportunity_proof_requirements
  add column retired_at timestamptz,
  add column retired_by uuid,
  add column retirement_reason text,
  add constraint opportunity_proof_retirement_complete check (
    (retired_at is null and retired_by is null and retirement_reason is null)
    or (retired_at is not null and retired_by is not null and retirement_reason is not null
      and length(retirement_reason) between 1 and 1000 and retirement_reason ~ '[^[:space:]]'
      and proof_id is null and satisfied_at is null)
  );

-- Keep the worker's existing mutations on the original fields. Retirement metadata
-- is written exclusively by the reviewer RPC.
revoke insert, update on public.opportunity_proof_requirements from service_role;
grant insert (id, opportunity_id, client_id, requirement, proof_id, satisfied_at, created_at),
      update (id, opportunity_id, client_id, requirement, proof_id, satisfied_at, created_at)
  on public.opportunity_proof_requirements to service_role;

create function public.retire_opportunity_proof_requirement(p_requirement_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  req public.opportunity_proof_requirements%rowtype;
  reviewer uuid := auth.uid();
  reason text := btrim(p_reason);
begin
  if auth.role() is distinct from 'authenticated' or reviewer is null
    or not exists (select 1 from public.profiles where id = reviewer and not is_bot) then
    raise exception 'A signed-in human reviewer is required.' using errcode = '42501';
  end if;
  select * into req from public.opportunity_proof_requirements where id = p_requirement_id for update;
  if not found or not public.can_shape_opportunity(req.client_id) then
    raise exception 'The requirement is unavailable to this reviewer.' using errcode = '42501';
  end if;
  if reason is null or length(reason) not between 1 and 1000 or reason !~ '[^[:space:]]' then
    raise exception 'Give an out-of-scope reason of 1 to 1000 characters.' using errcode = '22023';
  end if;
  if req.retired_at is not null then
    if req.retirement_reason = reason and req.retired_by = reviewer then return; end if;
    raise exception 'This requirement already has a retirement decision.' using errcode = '23514';
  end if;
  if req.proof_id is not null then
    raise exception 'Only an open requirement can be retired.' using errcode = '23514';
  end if;
  update public.opportunity_proof_requirements
    set retired_at = clock_timestamp(), retired_by = reviewer, retirement_reason = reason
    where id = req.id;
end $$;
revoke all on function public.retire_opportunity_proof_requirement(uuid,text) from public,anon,service_role;
grant execute on function public.retire_opportunity_proof_requirement(uuid,text) to authenticated;

create or replace view public.opportunity_readiness with (security_invoker = true) as
select
  o.id as opportunity_id,
  o.client_id,
  o.name,
  o.status,
  o.confidence,
  s.total as score,
  s.classification,
  coalesce(gaps.open_gaps, 0) as open_proof_gaps,
  coalesce(stages.stages, 0) as awareness_stages,
  case
    when nullif(btrim(o.core_problem), '') is null
      then 'No problem recorded. An opportunity without one is a description of an audience, not a reason to buy.'
    when nullif(btrim(o.desired_outcome), '') is null
      then 'No desired outcome recorded, so nothing says what these people are trying to achieve.'
    when not exists (select 1 from public.opportunity_links l
                      where l.opportunity_id = o.id and l.role = 'offer')
      then 'Nothing links this to something the client actually sells.'
    when s.id is null
      then 'Nobody has scored it, so there is no way to compare it with the others.'
    when s.classification = 'reject'
      then 'Scored as reject at ' || s.total::text || '. Score it again or reject it properly.'
    when o.confidence = 'hypothesis'
      then 'Still a hypothesis. Nothing outside the model has evidenced this buying situation.'
    when coalesce(gaps.open_gaps, 0) > 0
      then coalesce(gaps.open_gaps, 0)::text || ' claim'
           || case when gaps.open_gaps = 1 then ' has' else 's have' end
           || ' no proof on file. Capture it, or change the claim.'
    when coalesce(stages.stages, 0) = 0
      then 'No awareness journey, so there is nothing to brief content or proof from.'
    else null
  end as blocker
from public.market_opportunities o
left join lateral (
  select sc.* from public.opportunity_scores sc
   where sc.opportunity_id = o.id order by sc.scored_at desc limit 1
) s on true
left join lateral (
  select count(*)::int as open_gaps from public.opportunity_proof_requirements r
   where r.opportunity_id = o.id and r.proof_id is null and r.retired_at is null
) gaps on true
left join lateral (
  select count(*)::int as stages from public.opportunity_awareness_stages a
   where a.opportunity_id = o.id
) stages on true;

create or replace function public.opportunity_proof_ready_v6(p_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select not exists (
    select 1 from public.opportunity_proof_requirements q
    left join public.client_proof_assets p on p.id = q.proof_id
      and p.client_id = q.client_id
    where q.opportunity_id = p_id and q.retired_at is null
      and (q.proof_id is null or p.id is null or p.usage_rights <> 'approved'
        or (p.expires_on is not null and p.expires_on < current_date))
  );
$$;

create or replace function public.request_opportunity_approval_v6(p_opportunity_id uuid)
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
    or not public.opportunity_proof_ready_v6(o.id) then
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

-- Keep existing approval hashes stable until a requirement is actually retired.
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
      'proof_basis',p.permission_basis) || case when q.retired_at is null then '{}'::jsonb
        else jsonb_build_object('retired_at',q.retired_at at time zone 'UTC','retired_by',q.retired_by,
          'retirement_reason',q.retirement_reason) end order by q.id)
      from public.opportunity_proof_requirements q
      left join public.client_proof_assets p on p.id=q.proof_id
      where q.opportunity_id=o.id),'[]'::jsonb),
    'consequence','Allows a campaign to be planned against this evidenced buying situation'
  ) from public.market_opportunities o where o.id=p_id;
$$;

commit;
