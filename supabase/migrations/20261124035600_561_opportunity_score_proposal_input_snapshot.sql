-- A human must not accept a score drafted from an older opportunity, rubric,
-- intelligence record or offer catalog. Historical proposals without a
-- fingerprint stay readable but need a fresh evaluation before acceptance.
begin;

create function public.opportunity_evaluation_input_hash_v7(p_opportunity_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  o public.market_opportunities%rowtype;
  input jsonb;
begin
  select * into o from public.market_opportunities where id=p_opportunity_id;
  if o.id is null then raise exception 'Opportunity unavailable.' using errcode='P0001'; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(o.client_id)) then
    raise exception 'Opportunity access required.' using errcode='42501';
  end if;
  select jsonb_build_object(
    'opportunity',to_jsonb(o),
    'factors',coalesce((select jsonb_agg(to_jsonb(f) order by f.factor)
      from public.opportunity_score_factors f),'[]'::jsonb),
    'intelligence',coalesce((select jsonb_agg(to_jsonb(r) order by r.id)
      from public.client_agent_records r where r.client_id=o.client_id
        and r.domain in ('market','icp','association','competitor','money_model')),'[]'::jsonb),
    'offers',coalesce((select jsonb_agg(to_jsonb(s) order by s.id)
      from public.service_offers s where s.client_id=o.client_id),'[]'::jsonb))
    into input;
  return encode(sha256(convert_to(input::text,'UTF8')),'hex');
end $$;

create or replace function public.accept_opportunity_score_proposal_v6(
  p_proposal_id uuid,p_note text default null
) returns public.opportunity_scores
language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  v_proposal public.opportunity_proposals%rowtype;
  v_score public.opportunity_scores;
begin
  select * into v_proposal from public.opportunity_proposals
    where id=p_proposal_id for update;
  if v_proposal.id is null then
    raise exception 'No such proposal.' using errcode='P0001'; end if;
  if v_proposal.kind<>'score' then
    raise exception 'That proposal is not a score.' using errcode='P0001'; end if;
  if v_proposal.resolution<>'open' then
    raise exception 'That proposal was already %.',v_proposal.resolution using errcode='P0001'; end if;
  if coalesce(v_proposal.payload->>'input_hash','') !~ '^[0-9a-f]{64}$'
    or v_proposal.payload->>'input_hash' is distinct from
      public.opportunity_evaluation_input_hash_v7(v_proposal.opportunity_id) then
    raise exception 'The opportunity or its evaluation sources changed. Request a new evaluation.'
      using errcode='23514';
  end if;
  v_score:=public.score_market_opportunity_v6(
    v_proposal.opportunity_id,v_proposal.payload->'factors',
    coalesce(nullif(btrim(p_note),''),v_proposal.rationale));
  update public.opportunity_proposals
    set resolution='accepted',resolved_by=auth.uid(),resolved_at=now()
    where id=p_proposal_id;
  insert into public.opportunity_events(opportunity_id,client_id,event,actor,detail)
    values(v_proposal.opportunity_id,v_proposal.client_id,
      'score_proposal_accepted','human','drafted by '||v_proposal.proposed_by);
  return v_score;
end $$;

revoke all on function public.opportunity_evaluation_input_hash_v7(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.opportunity_evaluation_input_hash_v7(uuid)
  to authenticated,service_role;
select public.lock_down_definer_functions();
commit;
