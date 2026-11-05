-- v6.1 / 1.1: the agent that compiles an offer.
--
-- The notes, on Offer Studio: "single page, table of all offers, two buttons
-- (main offer / secondary offer), agent compiles from Offer Strategy or from
-- the micro-niche".
--
-- #324 built the page and the two buttons. They create an offer for a person to
-- fill in. The compiling half was left with a comment saying it was owed, and
-- this is it.
--
-- NO PERMISSION CHANGE IS NEEDED, WHICH IS WORTH SAYING
--
-- create_service_offer_version_v6 already grants execute to service_role, so an
-- agent can write an offer version today. Unlike scoring an opportunity --
-- where 306 had to build a proposal channel because the guard is deliberately
-- closed to the runtime -- this one needed checking rather than arguing about.
-- It was already open.
--
-- That asymmetry is not an oversight in either direction. An offer version is
-- a draft artefact: it is created, then reviewed, then claimed, and nothing
-- spends money because it exists. A score is an assertion that unlocks spend.
-- The existing grants already encode that difference.
--
-- TWO ARGUMENTS, BOTH BOUNDED
--
-- `kind` is the main/secondary distinction migration 303 added to
-- service_offers, so the two buttons the notes ask for are one RPC with one
-- argument rather than two RPCs.
--
-- `source` is which input the agent compiles from. The notes name both: Offer
-- Strategy, which is a prior agent's output, and the micro-niche, which is a
-- field on the market opportunity. They produce different offers from the same
-- client, so the caller says which rather than the agent guessing.
--
-- Same narrow-writer shape as 304 and 306: one named thing, validated
-- arguments, one agent. enqueue_agent_job still takes no parameters, so no
-- other agent becomes steerable from a browser.

create or replace function public.request_offer_compile_v6(
  p_client_id uuid,
  p_kind text,
  p_source text,
  p_opportunity_id uuid default null
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_opportunity public.market_opportunities%rowtype;
  v_running integer;
begin
  if public.current_role_of() is null then
    raise exception 'A provisioned console account is required.' using errcode = '42501';
  end if;
  if p_client_id is null or not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('main', 'secondary') then
    raise exception 'An offer is a main offer or a secondary offer.' using errcode = 'P0001';
  end if;
  if p_source is null or p_source not in ('strategy', 'micro_niche') then
    raise exception 'Compile from offer strategy or from a micro-niche.' using errcode = 'P0001';
  end if;

  -- A micro-niche is a field on an opportunity, so compiling from one needs to
  -- be told which. Asking for that source without an opportunity is a request
  -- the agent could only satisfy by picking one itself.
  if p_source = 'micro_niche' then
    if p_opportunity_id is null then
      raise exception 'Compiling from a micro-niche needs the opportunity it belongs to.'
        using errcode = 'P0001';
    end if;
    select * into v_opportunity from public.market_opportunities
     where id = p_opportunity_id;
    if v_opportunity.id is null then
      raise exception 'No such opportunity.' using errcode = 'P0001';
    end if;
    if v_opportunity.client_id <> p_client_id then
      raise exception 'That opportunity belongs to another client.' using errcode = '42501';
    end if;
    if nullif(btrim(coalesce(v_opportunity.micro_market, '')), '') is null then
      raise exception 'That opportunity has no micro-niche to compile from.'
        using errcode = 'P0001';
    end if;
  elsif p_opportunity_id is not null then
    -- Compiling from strategy does not read an opportunity, so accepting one
    -- would record an input the run never used.
    raise exception 'Compiling from offer strategy does not take an opportunity.'
      using errcode = 'P0001';
  end if;

  -- One compile at a time per client and kind. Two concurrent runs produce two
  -- competing main offers from the same strategy, and the second to finish
  -- silently looks like the considered one.
  select count(*) into v_running from public.agent_jobs j
   where j.agent_key = 'offer_compile'
     and j.client_id = p_client_id
     and j.params ->> 'kind' = p_kind
     and j.status in ('queued', 'claimed', 'running');
  if v_running > 0 then
    raise exception 'A % offer is already being compiled for this client.', p_kind
      using errcode = 'P0001';
  end if;

  return public.enqueue_agent_job_internal(
    'offer_compile', p_client_id,
    case when p_opportunity_id is null then null else 'market_opportunities' end,
    p_opportunity_id,
    auth.uid(),
    jsonb_build_object('kind', p_kind, 'source', p_source),
    'Queued: compile a ' || p_kind || ' offer from ' ||
      case p_source when 'strategy' then 'offer strategy' else 'a micro-niche' end
  );
end $$;

comment on function public.request_offer_compile_v6(uuid, text, text, uuid) is
  'Queues one offer compile for this client: a main or secondary offer, from offer strategy or from an opportunity''s micro-niche. Narrow by design, like request_opportunity_discovery_v6 -- the generic enqueue_agent_job still takes no parameters.';

revoke all on function public.request_offer_compile_v6(uuid, text, text, uuid) from public, anon;
grant execute on function public.request_offer_compile_v6(uuid, text, text, uuid)
  to authenticated, service_role;

-- requires_input is false: compiling from strategy reads no input row, and the
-- micro-niche case passes one without needing the runner to demand it.
insert into public.agents (agent_key, name, initials, domain, description,
                           requires_upstream, requires_input)
values
  ('offer_compile', 'Offer Compiler', 'OC', 'strategy',
   'Assembles a main or secondary service offer from the client''s offer strategy, or from a market opportunity''s micro-niche. Writes a draft offer version for a person to review and claim; it does not make an offer live.',
   array['offer_strategy'], false)
on conflict (agent_key) do nothing;

select lock_down_definer_functions();
