-- What you can do to an opportunity, and the one sentence saying why not.
--
-- 225 is the shape. This is the behaviour: creating one, filling it in,
-- scoring it, moving it through its lifecycle, and the view that answers
-- "why can this not be activated yet" in a sentence rather than leaving
-- somebody to work out which of eight things is missing.
--
-- Every write goes through a function. The tables grant select only, which is
-- the pattern the rest of v6 uses, and it is what lets the status guard, the
-- event log and the confidence rule be facts about the system rather than
-- things a careful caller remembers to do.

-- ---------------------------------------------------------------------------
-- Who may change an opportunity
-- ---------------------------------------------------------------------------

create or replace function public.can_shape_opportunity(p_client_id uuid)
returns boolean language sql stable
set search_path = pg_catalog, public as $$
  select coalesce(public.is_admin(), false)
      or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false);
$$;

comment on function public.can_shape_opportunity(uuid) is
  'An admin or the client''s assigned manager. The same bar the Proof Factory uses, so one person''s access means the same thing on both screens.';

revoke all on function public.can_shape_opportunity(uuid) from public, anon;
grant execute on function public.can_shape_opportunity(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Proposing one
-- ---------------------------------------------------------------------------

create or replace function public.create_market_opportunity_v6(
  p_idempotency_key text,
  p_client_id uuid,
  p_name text,
  p_micro_market text,
  p_buying_situation text,
  p_core_problem text default null,
  p_desired_outcome text default null,
  p_purchase_trigger text default null,
  p_entry_awareness text default null,
  p_positioning text default null,
  p_conversion_action text default null,
  p_proposed_by text default 'human',
  p_job_id uuid default null
)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_existing public.market_opportunities%rowtype;
  v_id uuid;
  v_agent boolean := coalesce(auth.role(), '') = 'service_role';
begin
  -- An agent proposes through the service role; a person through their own.
  if not v_agent and not public.can_shape_opportunity(p_client_id) then
    raise exception 'Only an admin or assigned client manager can shape opportunities.'
      using errcode = 'P0001';
  end if;
  if p_proposed_by not in ('human', 'agent') then
    raise exception 'An opportunity is proposed by a human or an agent.' using errcode = 'P0001';
  end if;
  if v_agent and p_proposed_by <> 'agent' then
    raise exception 'The service role proposes as an agent.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text || ':' || btrim(p_idempotency_key), 0));
  select * into v_existing from public.market_opportunities
   where client_id = p_client_id and idempotency_key = btrim(p_idempotency_key);
  if found then
    -- Same key, same opportunity. A discovery run that is retried must not
    -- produce a second copy of everything it found the first time.
    if v_existing.name <> btrim(p_name) then
      raise exception 'That key already belongs to a different opportunity.' using errcode = 'P0001';
    end if;
    return v_existing.id;
  end if;

  insert into public.market_opportunities (
    client_id, name, micro_market, buying_situation, core_problem, desired_outcome,
    purchase_trigger, entry_awareness, positioning, conversion_action,
    proposed_by, proposed_by_job_id, idempotency_key, created_by)
  values (
    p_client_id, btrim(p_name), btrim(p_micro_market), btrim(p_buying_situation),
    nullif(btrim(p_core_problem), ''), nullif(btrim(p_desired_outcome), ''),
    nullif(btrim(p_purchase_trigger), ''), p_entry_awareness,
    nullif(btrim(p_positioning), ''), nullif(btrim(p_conversion_action), ''),
    p_proposed_by, p_job_id, btrim(p_idempotency_key),
    case when v_agent then null else auth.uid() end)
  returning id into v_id;

  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (v_id, p_client_id, 'proposed', p_proposed_by,
          case when p_proposed_by = 'agent'
               then 'Proposed from existing intelligence. A hypothesis until something evidences it.'
               else 'Proposed by hand.' end);
  return v_id;
end $$;

revoke all on function public.create_market_opportunity_v6(
  text, uuid, text, text, text, text, text, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.create_market_opportunity_v6(
  text, uuid, text, text, text, text, text, text, text, text, text, text, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Filling it in
-- ---------------------------------------------------------------------------

create or replace function public.set_opportunity_fields_v6(
  p_opportunity_id uuid,
  p_core_problem text default null,
  p_desired_outcome text default null,
  p_purchase_trigger text default null,
  p_entry_awareness text default null,
  p_positioning text default null,
  p_conversion_action text default null
)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.market_opportunities%rowtype;
begin
  select * into v from public.market_opportunities where id = p_opportunity_id;
  if v.id is null then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if not public.can_shape_opportunity(v.client_id) then
    raise exception 'Only an admin or assigned client manager can shape opportunities.'
      using errcode = 'P0001';
  end if;

  -- coalesce, so a call that means to change one field does not blank five.
  update public.market_opportunities set
    core_problem = coalesce(nullif(btrim(p_core_problem), ''), core_problem),
    desired_outcome = coalesce(nullif(btrim(p_desired_outcome), ''), desired_outcome),
    purchase_trigger = coalesce(nullif(btrim(p_purchase_trigger), ''), purchase_trigger),
    entry_awareness = coalesce(p_entry_awareness, entry_awareness),
    positioning = coalesce(nullif(btrim(p_positioning), ''), positioning),
    conversion_action = coalesce(nullif(btrim(p_conversion_action), ''), conversion_action)
  where id = p_opportunity_id;

  insert into public.opportunity_events (opportunity_id, client_id, event, actor)
  values (p_opportunity_id, v.client_id, 'edited', 'human');
end $$;

revoke all on function public.set_opportunity_fields_v6(uuid, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.set_opportunity_fields_v6(uuid, text, text, text, text, text, text)
  to authenticated;

-- The whole list at once, in order. Replacing rather than appending, because
-- "these are the objections" is one statement and editing it by adding a row
-- and deleting another is how a list ends up with two contradictory halves.
create or replace function public.set_opportunity_attributes_v6(
  p_opportunity_id uuid, p_kind text, p_values text[])
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v public.market_opportunities%rowtype;
  v_clean text[];
  v_count integer;
begin
  select * into v from public.market_opportunities where id = p_opportunity_id;
  if v.id is null then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role' and not public.can_shape_opportunity(v.client_id) then
    raise exception 'Only an admin or assigned client manager can shape opportunities.'
      using errcode = 'P0001';
  end if;
  if p_kind not in ('problem', 'outcome', 'motivation', 'trigger', 'objection') then
    raise exception 'Unknown attribute kind: %.', p_kind using errcode = 'P0001';
  end if;

  -- Deduped, but in the order the caller gave: the first objection is not
  -- the fifth, so a distinct that reorders would quietly rewrite the
  -- statement being made. First occurrence wins.
  select array_agg(x order by ord) into v_clean
    from (select btrim(y) as x, min(ord) as ord
            from unnest(coalesce(p_values, '{}')) with ordinality as t(y, ord)
           where nullif(btrim(y), '') is not null
           group by btrim(y)) deduped;

  delete from public.opportunity_attributes
   where opportunity_id = p_opportunity_id and kind = p_kind;
  insert into public.opportunity_attributes (opportunity_id, client_id, kind, body, position)
  select p_opportunity_id, v.client_id, p_kind, value, ordinality
    from unnest(coalesce(v_clean, '{}')) with ordinality as t(value, ordinality);
  get diagnostics v_count = row_count;

  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (p_opportunity_id, v.client_id, 'edited',
          case when coalesce(auth.role(), '') = 'service_role' then 'agent' else 'human' end,
          v_count || ' ' || p_kind || ' recorded.');
  return v_count;
end $$;

revoke all on function public.set_opportunity_attributes_v6(uuid, text, text[]) from public, anon;
grant execute on function public.set_opportunity_attributes_v6(uuid, text, text[])
  to authenticated, service_role;

create or replace function public.set_opportunity_awareness_v6(
  p_opportunity_id uuid, p_stage text, p_mindset text, p_message text,
  p_asset_direction text default null, p_distribution_note text default null)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.market_opportunities%rowtype;
begin
  select * into v from public.market_opportunities where id = p_opportunity_id;
  if v.id is null then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role' and not public.can_shape_opportunity(v.client_id) then
    raise exception 'Only an admin or assigned client manager can shape opportunities.'
      using errcode = 'P0001';
  end if;

  insert into public.opportunity_awareness_stages (
    opportunity_id, client_id, stage, mindset, message, asset_direction, distribution_note)
  values (p_opportunity_id, v.client_id, p_stage, btrim(p_mindset), btrim(p_message),
          nullif(btrim(p_asset_direction), ''), nullif(btrim(p_distribution_note), ''))
  on conflict (opportunity_id, stage) do update
    set mindset = excluded.mindset, message = excluded.message,
        asset_direction = excluded.asset_direction,
        distribution_note = excluded.distribution_note;
end $$;

revoke all on function public.set_opportunity_awareness_v6(uuid, text, text, text, text, text)
  from public, anon;
grant execute on function public.set_opportunity_awareness_v6(uuid, text, text, text, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What it is built on
-- ---------------------------------------------------------------------------

create or replace function public.link_opportunity_v6(
  p_opportunity_id uuid, p_role text, p_target_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v public.market_opportunities%rowtype;
  v_target_client uuid;
  v_id uuid;
begin
  select * into v from public.market_opportunities where id = p_opportunity_id;
  if v.id is null then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role' and not public.can_shape_opportunity(v.client_id) then
    raise exception 'Only an admin or assigned client manager can shape opportunities.'
      using errcode = 'P0001';
  end if;

  -- Whatever it points at has to belong to the same client. An opportunity
  -- citing another client's ICP would be the worst bug this table could have.
  if p_role in ('parent_icp', 'market', 'competitor', 'association') then
    select client_id into v_target_client from public.client_agent_records where id = p_target_id;
  elsif p_role = 'offer' then
    select client_id into v_target_client from public.service_offers where id = p_target_id;
  elsif p_role = 'campaign' then
    select client_id into v_target_client from public.client_campaigns where id = p_target_id;
  else
    raise exception 'Unknown link role: %.', p_role using errcode = 'P0001';
  end if;
  if v_target_client is null or v_target_client <> v.client_id then
    raise exception 'That does not belong to this client.' using errcode = 'P0001';
  end if;

  insert into public.opportunity_links (
    opportunity_id, client_id, role, record_id, offer_id, campaign_id)
  values (
    p_opportunity_id, v.client_id, p_role,
    case when p_role in ('parent_icp','market','competitor','association') then p_target_id end,
    case when p_role = 'offer' then p_target_id end,
    case when p_role = 'campaign' then p_target_id end)
  on conflict do nothing
  returning id into v_id;

  if v_id is not null then
    insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
    values (p_opportunity_id, v.client_id, 'linked',
            case when coalesce(auth.role(), '') = 'service_role' then 'agent' else 'human' end,
            p_role);
  end if;
  return v_id;
end $$;

revoke all on function public.link_opportunity_v6(uuid, text, uuid) from public, anon;
grant execute on function public.link_opportunity_v6(uuid, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What it would have to prove
-- ---------------------------------------------------------------------------

create or replace function public.require_opportunity_proof_v6(
  p_opportunity_id uuid, p_requirement text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.market_opportunities%rowtype; v_id uuid;
begin
  select * into v from public.market_opportunities where id = p_opportunity_id;
  if v.id is null then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role' and not public.can_shape_opportunity(v.client_id) then
    raise exception 'Only an admin or assigned client manager can shape opportunities.'
      using errcode = 'P0001';
  end if;
  insert into public.opportunity_proof_requirements (opportunity_id, client_id, requirement)
  values (p_opportunity_id, v.client_id, btrim(p_requirement))
  returning id into v_id;
  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (p_opportunity_id, v.client_id, 'proof_required',
          case when coalesce(auth.role(), '') = 'service_role' then 'agent' else 'human' end,
          btrim(p_requirement));
  return v_id;
end $$;

revoke all on function public.require_opportunity_proof_v6(uuid, text) from public, anon;
grant execute on function public.require_opportunity_proof_v6(uuid, text) to authenticated, service_role;

create or replace function public.satisfy_opportunity_proof_v6(
  p_requirement_id uuid, p_proof_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_req public.opportunity_proof_requirements%rowtype;
  v_proof public.client_proof_assets%rowtype;
begin
  select * into v_req from public.opportunity_proof_requirements where id = p_requirement_id;
  if v_req.id is null then raise exception 'No such requirement.' using errcode = 'P0001'; end if;
  if not public.can_shape_opportunity(v_req.client_id) then
    raise exception 'Only an admin or assigned client manager can shape opportunities.'
      using errcode = 'P0001';
  end if;
  select * into v_proof from public.client_proof_assets where id = p_proof_id;
  if v_proof.id is null or v_proof.client_id <> v_req.client_id then
    raise exception 'That proof does not belong to this client.' using errcode = 'P0001';
  end if;
  -- Uncleared proof does not satisfy anything: a campaign built on it would
  -- be making a claim the client has no permission to make.
  if v_proof.usage_rights <> 'approved'
     or (v_proof.expires_on is not null and v_proof.expires_on < current_date) then
    raise exception 'That proof is not cleared for use.' using errcode = 'P0001';
  end if;

  update public.opportunity_proof_requirements
     set proof_id = p_proof_id, satisfied_at = now()
   where id = p_requirement_id;
  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (v_req.opportunity_id, v_req.client_id, 'proof_satisfied', 'human', v_req.requirement);
end $$;

revoke all on function public.satisfy_opportunity_proof_v6(uuid, uuid) from public, anon;
grant execute on function public.satisfy_opportunity_proof_v6(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Scoring
-- ---------------------------------------------------------------------------

-- The weights live in opportunity_score_factors, so this reads them rather
-- than carrying a copy. A factor missing from the call is a factor nobody
-- assessed, and that is refused: a total computed over five of seven factors
-- is not comparable with one computed over seven, and nothing on the screen
-- would say which it was looking at.
create or replace function public.score_market_opportunity_v6(
  p_opportunity_id uuid, p_factors jsonb, p_note text default null)
returns public.opportunity_scores
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v public.market_opportunities%rowtype;
  v_missing text;
  v_total numeric;
  v_class text;
  v_row public.opportunity_scores;
begin
  select * into v from public.market_opportunities where id = p_opportunity_id;
  if v.id is null then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if not public.can_shape_opportunity(v.client_id) then
    raise exception 'Only an admin or assigned client manager can score opportunities.'
      using errcode = 'P0001';
  end if;
  if p_factors is null or jsonb_typeof(p_factors) <> 'object' then
    raise exception 'Score every factor from 0 to 100.' using errcode = 'P0001';
  end if;

  select string_agg(f.factor, ', ' order by f.factor) into v_missing
    from public.opportunity_score_factors f
   where not (p_factors ? f.factor);
  if v_missing is not null then
    raise exception 'Score every factor. Missing: %.', v_missing using errcode = 'P0001';
  end if;

  select sum(f.weight * least(greatest((p_factors ->> f.factor)::numeric, 0), 100))
    into v_total from public.opportunity_score_factors f;

  -- Four bands, and the names say what to do rather than how good it is.
  -- Reject is deliberately a band rather than a silence: an opportunity
  -- somebody looked at and ruled out is worth more than one nobody scored.
  v_class := case
    when v_total >= 75 then 'scale'
    when v_total >= 55 then 'test'
    when v_total >= 35 then 'research'
    else 'reject' end;

  insert into public.opportunity_scores (
    opportunity_id, client_id, factors, total, classification, note, scored_by)
  values (p_opportunity_id, v.client_id, p_factors, round(v_total, 2), v_class,
          nullif(btrim(p_note), ''), auth.uid())
  returning * into v_row;

  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (p_opportunity_id, v.client_id, 'scored', 'human',
          v_class || ' at ' || round(v_total, 2));
  return v_row;
end $$;

revoke all on function public.score_market_opportunity_v6(uuid, jsonb, text) from public, anon;
grant execute on function public.score_market_opportunity_v6(uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Why this is not ready
-- ---------------------------------------------------------------------------

-- publish_due, for opportunities. One sentence per opportunity, and a null
-- blocker means it could be approved now. The order of the cases is the order
-- somebody should hear them: the things that make it wrong first, then the
-- things that make it unevidenced, then the things that make it unbuildable.
create or replace view opportunity_readiness with (security_invoker = true) as
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
   where r.opportunity_id = o.id and r.proof_id is null
) gaps on true
left join lateral (
  select count(*)::int as stages from public.opportunity_awareness_stages a
   where a.opportunity_id = o.id
) stages on true;

comment on view opportunity_readiness is
  'What stops each opportunity being approved, in one sentence. A null blocker means it could be approved now. The approval function reads this rather than trusting the person to have checked.';

grant select on opportunity_readiness to authenticated;

-- ---------------------------------------------------------------------------
-- Moving it along
-- ---------------------------------------------------------------------------

create or replace function public.set_opportunity_status_v6(
  p_opportunity_id uuid, p_status opportunity_status, p_note text default null)
returns public.market_opportunities
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.market_opportunities%rowtype;
begin
  select * into v from public.market_opportunities where id = p_opportunity_id for update;
  if v.id is null then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if not public.can_shape_opportunity(v.client_id) then
    raise exception 'Only an admin or assigned client manager can move an opportunity.'
      using errcode = 'P0001';
  end if;
  -- Approval is the gate that lets money be spent against a hypothesis, so
  -- it is the one that reads the readiness view rather than trusting the
  -- person to have checked.
  if p_status = 'approved' then
    if exists (select 1 from public.opportunity_readiness r
                where r.opportunity_id = p_opportunity_id and r.blocker is not null) then
      raise exception '%', (select r.blocker from public.opportunity_readiness r
                             where r.opportunity_id = p_opportunity_id)
        using errcode = 'P0001';
    end if;
  end if;

  update public.market_opportunities
     set status = p_status, status_note = nullif(btrim(p_note), '')
   where id = p_opportunity_id
   returning * into v;

  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (p_opportunity_id, v.client_id, 'status_changed', 'human',
          p_status::text || coalesce(': ' || nullif(btrim(p_note), ''), ''));
  return v;
end $$;

revoke all on function public.set_opportunity_status_v6(uuid, opportunity_status, text)
  from public, anon;
grant execute on function public.set_opportunity_status_v6(uuid, opportunity_status, text)
  to authenticated;

-- Confidence is evidence, so only a person moves it, and the reason is
-- required. The guard in 225 already stops an agent raising its own.
create or replace function public.set_opportunity_confidence_v6(
  p_opportunity_id uuid, p_confidence opportunity_confidence, p_note text)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.market_opportunities%rowtype;
begin
  select * into v from public.market_opportunities where id = p_opportunity_id for update;
  if v.id is null then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if not public.can_shape_opportunity(v.client_id) then
    raise exception 'Only an admin or assigned client manager can change confidence.'
      using errcode = 'P0001';
  end if;
  if nullif(btrim(p_note), '') is null then
    raise exception 'Say what evidence moved this.' using errcode = 'P0001';
  end if;

  update public.market_opportunities set confidence = p_confidence where id = p_opportunity_id;
  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (p_opportunity_id, v.client_id, 'confidence_changed', 'human',
          p_confidence::text || ': ' || btrim(p_note));
end $$;

revoke all on function public.set_opportunity_confidence_v6(uuid, opportunity_confidence, text)
  from public, anon;
grant execute on function public.set_opportunity_confidence_v6(uuid, opportunity_confidence, text)
  to authenticated;

select lock_down_definer_functions();
