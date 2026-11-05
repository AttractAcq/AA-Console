-- v6.1 / 1.2: the Evaluate and Strategise agents.
--
-- The notes ask for them: "add the agents (there are none today) for Evaluate
-- and Strategise". Going to build them turned up the reason they did not exist,
-- which #327 recorded: score_market_opportunity_v6 guards on
-- can_shape_opportunity, and that is false for the agent runtime because
-- is_admin() reads profiles.role for auth.uid() and the runtime has no uid.
--
-- WHY THE GUARD IS NOT WIDENED HERE
--
-- Scoring is the gate that lets money be spent against a hypothesis.
-- set_opportunity_status_v6 reads the readiness view on approval rather than
-- trusting the person, and readiness depends on the score. So letting an agent
-- score moves who may assert the thing that unlocks spend.
--
-- Asked directly on 4 November, Alex chose: the agent proposes and a human
-- accepts. So no guard moves in this migration. can_shape_opportunity is
-- untouched, score_market_opportunity_v6 is untouched, and the agent cannot
-- score. It writes a proposal; a human accepts it, and the acceptance IS the
-- existing human scoring act.
--
-- That also happens to be the shape the rest of the plan already has: agents
-- do the work, every flow stops before the committing act, a human commits.
--
-- WHAT THE AGENTS MAY ALREADY DO, WHICH I HAD WRONG IN #327
--
-- #327 said the agents are blocked by can_shape_opportunity. True of scoring
-- and status, but three of the shaping writers already carry a service-role
-- branch: link_opportunity_v6, set_opportunity_attributes_v6 and
-- set_opportunity_awareness_v6. So an agent shaping an opportunity is not
-- unprecedented, and the codebase already draws the line this migration keeps:
--
--   structured metadata   attributes, awareness mapping, links -- agent may write
--   commercial assertion  score, status, confidence, narrative fields -- human only
--
-- The Strategise agent therefore writes its attributes, awareness stages and
-- links directly through the paths that already permit it, and proposes only
-- the narrative fields, which do not. That split is respected rather than
-- flattened, because it is a real distinction and somebody made it on purpose.
--
-- WHY NOT A ROUTE ON THE APPROVAL SPINE
--
-- approval_requests_v6 exists with nine routes and would give these cards a
-- home in the Approval Inbox. Deliberately not used here. Every one of those
-- nine routes is a human decision about an OUTWARD act -- publish, spend, grant
-- access, cut a release -- and two of them are contained precisely because that
-- bar is high. A drafted evaluation is none of those: it goes nowhere, costs
-- nothing, and accepting it is just the human doing the scoring they could have
-- done unaided.
--
-- Routing it through the spine would equate "an agent wrote some analysis" with
-- "a human must authorise something irreversible", and that is the distinction
-- the spine is for. If it later belongs in the Inbox it becomes route ten then,
-- with a registrar and a resolver like the rest.

create table public.opportunity_proposals (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null
    references public.market_opportunities(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  -- 'score' carries factors for score_market_opportunity_v6; 'strategy'
  -- carries the narrative fields for set_opportunity_fields_v6.
  kind text not null check (kind in ('score', 'strategy')),
  payload jsonb not null,
  -- Not optional. A proposal a person cannot interrogate is a number to
  -- rubber-stamp, and the whole point of a human accepting is that they can
  -- disagree with the reasoning rather than only with the total.
  rationale text not null check (length(btrim(rationale)) between 1 and 8000),
  proposed_by text not null check (length(btrim(proposed_by)) between 1 and 120),
  proposed_by_job_id uuid references public.agent_jobs(id) on delete set null,
  proposed_at timestamptz not null default now(),
  resolution text not null default 'open'
    check (resolution in ('open', 'accepted', 'rejected', 'superseded')),
  -- profiles(id), matching opportunity_scores.scored_by rather than
  -- referencing auth.users directly: the console reads a person's name and
  -- role from profiles, and a resolver nobody can name is not much of an
  -- audit trail.
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  rejection_reason text,
  -- payload must be an object, so a proposal cannot carry a bare scalar that
  -- the accept path would then have to guess at.
  constraint opportunity_proposals_payload_object
    check (jsonb_typeof(payload) = 'object'),
  -- Open means unresolved, in both directions. Every column here is NOT NULL
  -- or compared with `is null`, so this cannot evaluate to NULL and pass by
  -- accident -- the hole migration 302 left in its own route CHECK.
  constraint opportunity_proposals_open_is_unresolved
    check ((resolution = 'open') = (resolved_at is null)),
  constraint opportunity_proposals_reason_only_when_rejected
    check (resolution = 'rejected' or rejection_reason is null)
);

comment on table public.opportunity_proposals is
  'What an agent proposes about an opportunity, for a human to accept or reject. An agent cannot score or set narrative fields directly -- can_shape_opportunity is false for the runtime and deliberately stays that way -- so it writes here and a person commits. Accepting a score proposal performs the ordinary human scoring act, attributed to that person.';
comment on column public.opportunity_proposals.rationale is
  'Why the agent proposed this. Required: a proposal nobody can argue with is a number to rubber-stamp.';
comment on column public.opportunity_proposals.resolution is
  'open until a person decides. superseded is for a later proposal of the same kind arriving first, so an old card does not sit decidable forever.';

create index opportunity_proposals_open_idx
  on public.opportunity_proposals (client_id, kind, proposed_at desc)
  where resolution = 'open';
create index opportunity_proposals_opportunity_idx
  on public.opportunity_proposals (opportunity_id, proposed_at desc);

alter table public.opportunity_proposals enable row level security;

-- Readable by anyone who can see the client. Not writable from a browser at
-- all: the agent inserts as service_role, and a person resolves through the
-- definer functions below, so there is no path by which a signed-in caller
-- writes a proposal and then accepts their own.
create policy opportunity_proposals_read on public.opportunity_proposals
  for select to authenticated
  using (public.can_access_client(client_id));

grant select on public.opportunity_proposals to authenticated;
grant select, insert, update on public.opportunity_proposals to service_role;

-- ---------------------------------------------------------------------------
-- Asking for the work
-- ---------------------------------------------------------------------------

create or replace function public.request_opportunity_evaluation_v6(
  p_client_id uuid,
  p_opportunity_id uuid
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
  select * into v_opportunity from public.market_opportunities
   where id = p_opportunity_id;
  if v_opportunity.id is null then
    raise exception 'No such opportunity.' using errcode = 'P0001';
  end if;
  if v_opportunity.client_id <> p_client_id then
    raise exception 'That opportunity belongs to another client.' using errcode = '42501';
  end if;

  -- One pass per opportunity at a time. Two concurrent evaluations produce two
  -- proposals from the same evidence and no way to say which one a person was
  -- looking at when they accepted.
  select count(*) into v_running from public.agent_jobs j
   where j.agent_key = 'opportunity_evaluate'
     and j.input_table = 'market_opportunities'
     and j.input_id = p_opportunity_id
     and j.status in ('queued', 'claimed', 'running');
  if v_running > 0 then
    raise exception 'An evaluation of this opportunity is already queued or running.'
      using errcode = 'P0001';
  end if;

  return public.enqueue_agent_job_internal(
    'opportunity_evaluate', p_client_id, 'market_opportunities', p_opportunity_id,
    auth.uid(), '{}'::jsonb,
    'Queued: evaluate ' || v_opportunity.name
  );
end $$;

comment on function public.request_opportunity_evaluation_v6(uuid, uuid) is
  'Queues one evaluation pass for an opportunity. The agent proposes a score; it cannot assert one.';

revoke all on function public.request_opportunity_evaluation_v6(uuid, uuid) from public, anon;
grant execute on function public.request_opportunity_evaluation_v6(uuid, uuid)
  to authenticated, service_role;

create or replace function public.request_opportunity_strategy_v6(
  p_client_id uuid,
  p_opportunity_id uuid
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
  select * into v_opportunity from public.market_opportunities
   where id = p_opportunity_id;
  if v_opportunity.id is null then
    raise exception 'No such opportunity.' using errcode = 'P0001';
  end if;
  if v_opportunity.client_id <> p_client_id then
    raise exception 'That opportunity belongs to another client.' using errcode = '42501';
  end if;

  select count(*) into v_running from public.agent_jobs j
   where j.agent_key = 'opportunity_strategise'
     and j.input_table = 'market_opportunities'
     and j.input_id = p_opportunity_id
     and j.status in ('queued', 'claimed', 'running');
  if v_running > 0 then
    raise exception 'A strategy pass for this opportunity is already queued or running.'
      using errcode = 'P0001';
  end if;

  return public.enqueue_agent_job_internal(
    'opportunity_strategise', p_client_id, 'market_opportunities', p_opportunity_id,
    auth.uid(), '{}'::jsonb,
    'Queued: strategise ' || v_opportunity.name
  );
end $$;

comment on function public.request_opportunity_strategy_v6(uuid, uuid) is
  'Queues one strategy pass for an opportunity. The agent writes attributes, awareness stages and links through the paths that already permit it, and proposes the narrative fields, which do not.';

revoke all on function public.request_opportunity_strategy_v6(uuid, uuid) from public, anon;
grant execute on function public.request_opportunity_strategy_v6(uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Deciding on it
-- ---------------------------------------------------------------------------

create or replace function public.accept_opportunity_score_proposal_v6(
  p_proposal_id uuid,
  p_note text default null
) returns public.opportunity_scores
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_proposal public.opportunity_proposals%rowtype;
  v_score public.opportunity_scores;
begin
  select * into v_proposal from public.opportunity_proposals
   where id = p_proposal_id for update;
  if v_proposal.id is null then
    raise exception 'No such proposal.' using errcode = 'P0001';
  end if;
  if v_proposal.kind <> 'score' then
    raise exception 'That proposal is not a score.' using errcode = 'P0001';
  end if;
  if v_proposal.resolution <> 'open' then
    raise exception 'That proposal was already %.', v_proposal.resolution
      using errcode = 'P0001';
  end if;

  -- The scoring function guards on can_shape_opportunity itself and records
  -- scored_by = auth.uid(), so the assertion is the accepting person's. This
  -- function deliberately adds no guard of its own: there is exactly one rule
  -- about who may score, and it lives in one place.
  v_score := public.score_market_opportunity_v6(
    v_proposal.opportunity_id,
    v_proposal.payload -> 'factors',
    coalesce(nullif(btrim(p_note), ''), v_proposal.rationale)
  );

  update public.opportunity_proposals
     set resolution = 'accepted', resolved_by = auth.uid(), resolved_at = now()
   where id = p_proposal_id;

  -- Where the numbers came from, kept separate from who asserted them. The
  -- scoring function already logged 'scored' with actor 'human'; this says a
  -- machine drafted it, which a reader of the history would otherwise have no
  -- way to tell.
  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (v_proposal.opportunity_id, v_proposal.client_id,
          'score_proposal_accepted', 'human',
          'drafted by ' || v_proposal.proposed_by);

  return v_score;
end $$;

comment on function public.accept_opportunity_score_proposal_v6(uuid, text) is
  'Accepts an agent-proposed score, exactly as proposed, as the calling person''s own scoring act. Adds no permission of its own: score_market_opportunity_v6 still decides who may score.';

revoke all on function public.accept_opportunity_score_proposal_v6(uuid, text) from public, anon;
grant execute on function public.accept_opportunity_score_proposal_v6(uuid, text)
  to authenticated, service_role;

create or replace function public.reject_opportunity_proposal_v6(
  p_proposal_id uuid,
  p_reason text
) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_proposal public.opportunity_proposals%rowtype;
begin
  select * into v_proposal from public.opportunity_proposals
   where id = p_proposal_id for update;
  if v_proposal.id is null then
    raise exception 'No such proposal.' using errcode = 'P0001';
  end if;
  if v_proposal.resolution <> 'open' then
    raise exception 'That proposal was already %.', v_proposal.resolution
      using errcode = 'P0001';
  end if;
  -- Rejecting is a judgement about the same thing accepting is, so it takes the
  -- same standing. Without this, anyone who can read a client could clear the
  -- queue they are not allowed to act on.
  if not public.can_shape_opportunity(v_proposal.client_id) then
    raise exception 'Only an admin or assigned client manager can decide on a proposal.'
      using errcode = 'P0001';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 1 then
    raise exception 'Say why it is rejected. A rejected proposal with no reason teaches the next pass nothing.'
      using errcode = 'P0001';
  end if;

  update public.opportunity_proposals
     set resolution = 'rejected', resolved_by = auth.uid(), resolved_at = now(),
         rejection_reason = btrim(p_reason)
   where id = p_proposal_id;

  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (v_proposal.opportunity_id, v_proposal.client_id,
          'proposal_rejected', 'human', btrim(p_reason));
end $$;

comment on function public.reject_opportunity_proposal_v6(uuid, text) is
  'Rejects an agent proposal with a stated reason, which the next pass can read.';

revoke all on function public.reject_opportunity_proposal_v6(uuid, text) from public, anon;
grant execute on function public.reject_opportunity_proposal_v6(uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The agents themselves
-- ---------------------------------------------------------------------------

-- requires_input is true for both: neither means anything without an
-- opportunity to work on, and the generic runner should refuse rather than
-- invent one.
insert into public.agents (agent_key, name, initials, domain, description,
                           requires_upstream, requires_input)
values
  ('opportunity_evaluate', 'Opportunity Evaluator', 'OE', 'strategy',
   'Scores an opportunity against the seven weighted factors and proposes the result for a person to accept. Cannot score directly: scoring is what unlocks spend against a hypothesis, so it stays a human assertion.',
   array['opportunity_discovery'], true),
  ('opportunity_strategise', 'Opportunity Strategist', 'OS', 'strategy',
   'Works out how to go at an opportunity: awareness stages, attributes and links it writes directly, positioning and the other narrative fields it proposes for a person to accept.',
   array['opportunity_discovery'], true)
on conflict (agent_key) do nothing;

select lock_down_definer_functions();
