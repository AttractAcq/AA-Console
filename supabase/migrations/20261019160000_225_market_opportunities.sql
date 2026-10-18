-- The Micro-Market Opportunity Engine: the object between intelligence and
-- campaigns.
--
-- Today the flow is business intelligence, then ideas, then campaigns. An
-- idea is a creative execution and a campaign is a coordinated effort, and
-- neither of them records the thing that should come first: the commercial
-- reason any of it should exist. "Affluent homeowners" is an ICP. "Homeowners
-- with an underused garage, mid-renovation, who want a private training space
-- and are worried about flooring and noise" is a reason to buy, and it is a
-- different reason from "families designing a new house", even though the
-- business installs the same gym for both.
--
-- One business. One core service. Many specific reasons to buy it.
--
-- WHAT THIS LINKS TO RATHER THAN RESTATES
--
-- Intelligence already exists as client_agent_records, keyed by domain --
-- icp, market, competitor, association and the rest. Offers exist as
-- service_offers with versions and sign-offs. Campaigns exist. Proof exists.
-- An opportunity points at all of them and copies none of them, so the day
-- somebody rewrites the ICP the opportunities built on it do not quietly
-- describe a market nobody researched.
--
-- AWARENESS IS NOT AUDIENCE STATE
--
-- This is the one distinction the whole design rests on, and getting it wrong
-- would have produced two stage models that fight.
--
-- The sixteen campaign templates already run on audience state: S0 stranger,
-- S1 watcher, S2 owned, S3 identified, S4 in conversation, S5 customer, S6
-- lapsed. Every template declares an entry and an exit on that scale, plus
-- its optimisation and destination. That axis is about reach: what
-- relationship we have with somebody and what a platform will let us do
-- about it.
--
-- Awareness is a different axis entirely: what the buyer understands about
-- their own problem. A stranger can be solution-aware. Somebody we already
-- own a channel to can be completely problem-unaware.
--
-- So awareness lives here, on the opportunity, and decides what an asset has
-- to say. Audience state stays where it is and decides what a campaign does.
-- Both hang off the same opportunity and neither is derived from the other.
--
-- A HYPOTHESIS IS NOT AN INSIGHT
--
-- Most of what this engine produces at first is a guess a model made from a
-- market record. Guesses that read like research are how a system becomes an
-- expensive idea generator, so confidence is a column of its own, separate
-- from the opportunity's score, and it starts at the bottom. A thing can be
-- commercially attractive and completely unevidenced at the same time; those
-- are two facts and the screen has to be able to show both.

-- ---------------------------------------------------------------------------
-- The lifecycle
-- ---------------------------------------------------------------------------

create type opportunity_status as enum (
  'discovered',   -- proposed, by a person or an agent
  'validated',    -- somebody checked the hypothesis holds up
  'approved',     -- cleared to have campaigns built for it
  'active',       -- campaigns are running against it
  'learning',     -- running, and results are being read back
  'scaling',      -- proven economics, taking more budget
  'paused',       -- stopped, may come back
  'rejected'      -- not worth pursuing, with a reason
);

comment on type opportunity_status is
  'Where an opportunity has got to. discovered through scaling is the path; paused and rejected are side exits that any stage can take.';

-- How sure we are that this describes a real buying situation, as opposed to
-- how attractive it would be if it did. Deliberately ordered, so "at least
-- researched" is a comparison rather than a list of strings.
create type opportunity_confidence as enum (
  'hypothesis',   -- a model proposed it from existing records
  'desk_research',-- somebody checked it against outside sources
  'conversation', -- real buyers or the client's sales calls say so
  'first_party',  -- the client's own CRM or customer data says so
  'proven'        -- campaigns against it have produced customers
);

comment on type opportunity_confidence is
  'How well evidenced the opportunity is, which is not the same question as how attractive it is. An AI hypothesis starts at the bottom and only real evidence moves it.';

-- ---------------------------------------------------------------------------
-- The opportunity
-- ---------------------------------------------------------------------------

create table public.market_opportunities (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,

  -- What somebody calls it on a screen: "Garage-to-Gym Conversion".
  name text not null check (length(btrim(name)) between 1 and 200),

  -- The seven dimensions. Singular, because each answers one question; the
  -- list-shaped knowledge (problems, outcomes, triggers, objections) hangs in
  -- opportunity_attributes where it can be ordered and cited individually.
  micro_market text not null check (length(btrim(micro_market)) between 1 and 2000),
  buying_situation text not null check (length(btrim(buying_situation)) between 1 and 2000),
  core_problem text check (core_problem is null or length(btrim(core_problem)) <= 2000),
  desired_outcome text check (desired_outcome is null or length(btrim(desired_outcome)) <= 2000),
  purchase_trigger text check (purchase_trigger is null or length(btrim(purchase_trigger)) <= 2000),
  entry_awareness text check (entry_awareness is null or entry_awareness in
    ('unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware')),
  positioning text check (positioning is null or length(btrim(positioning)) <= 2000),
  conversion_action text check (conversion_action is null or length(btrim(conversion_action)) <= 500),

  status opportunity_status not null default 'discovered',
  confidence opportunity_confidence not null default 'hypothesis',
  -- Why it was rejected or paused. Required for those, by the check below.
  status_note text,

  -- Who proposed it. An agent-proposed opportunity is not worth less, but it
  -- is worth knowing which is which when reading a list of thirty.
  proposed_by text not null default 'human' check (proposed_by in ('human', 'agent')),
  proposed_by_job_id uuid references public.agent_jobs(id) on delete set null,

  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 160),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (client_id, idempotency_key),
  unique (id, client_id),
  check (status not in ('rejected', 'paused') or nullif(btrim(status_note), '') is not null)
);

comment on table public.market_opportunities is
  'One specific reason somebody buys this client''s service: who, in what situation, with what problem, wanting what, triggered by what. The object between intelligence and campaigns -- an idea is a creative execution, a campaign is a coordinated effort, and this is why either should exist.';

create index market_opportunities_client_idx
  on public.market_opportunities (client_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- The list-shaped knowledge
-- ---------------------------------------------------------------------------

-- One table rather than four near-identical ones: a problem, an outcome, a
-- trigger and an objection are all an ordered line of text belonging to an
-- opportunity, and the only thing that differs is which question it answers.
create table public.opportunity_attributes (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.market_opportunities(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('problem', 'outcome', 'motivation', 'trigger', 'objection')),
  body text not null check (length(btrim(body)) between 1 and 2000),
  position integer not null check (position >= 1),
  created_at timestamptz not null default now(),
  unique (opportunity_id, kind, position)
);

comment on table public.opportunity_attributes is
  'The ordered lists an opportunity carries: what frustrates these people, what they want instead, what moves them, what makes now the moment, and what stops them. Ordered because the first objection is not the fifth.';

-- ---------------------------------------------------------------------------
-- What it is built on
-- ---------------------------------------------------------------------------

-- Exactly one target per row, the campaign_artifacts rule. A row pointing at
-- two things, or at none, is a row nobody can act on.
create table public.opportunity_links (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.market_opportunities(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  role text not null check (role in (
    'parent_icp', 'market', 'competitor', 'association', 'offer', 'campaign')),

  record_id uuid references public.client_agent_records(id) on delete cascade,
  offer_id uuid references public.service_offers(id) on delete cascade,
  campaign_id uuid references public.client_campaigns(id) on delete cascade,
  constraint opportunity_link_one_target
    check (num_nonnulls(record_id, offer_id, campaign_id) = 1),
  -- The role has to match the kind of thing it points at, or "parent_icp"
  -- could name a campaign.
  constraint opportunity_link_role_matches_target check (
    (role in ('parent_icp', 'market', 'competitor', 'association') and record_id is not null)
    or (role = 'offer' and offer_id is not null)
    or (role = 'campaign' and campaign_id is not null)),

  created_at timestamptz not null default now(),
  unique (opportunity_id, role, record_id, offer_id, campaign_id)
);

comment on table public.opportunity_links is
  'What an opportunity is built on and what it produced, by reference. Intelligence, offers and campaigns are not copied in: the day somebody rewrites the ICP, every opportunity built on it points at the new text rather than quietly describing a market nobody researched. A campaign link is optional -- a campaign may exist without a recorded commercial reason, for now.';

-- ---------------------------------------------------------------------------
-- The awareness journey
-- ---------------------------------------------------------------------------

-- What this person already believes, and what they have to understand before
-- they buy. Not every customer walks all five: entry_awareness on the
-- opportunity says where these people usually join, and this says what each
-- stage has to do for them.
create table public.opportunity_awareness_stages (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.market_opportunities(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  stage text not null check (stage in
    ('unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware')),
  mindset text not null check (length(btrim(mindset)) between 1 and 1000),
  message text not null check (length(btrim(message)) between 1 and 1000),
  asset_direction text check (asset_direction is null or length(btrim(asset_direction)) <= 2000),
  distribution_note text check (distribution_note is null or length(btrim(distribution_note)) <= 1000),
  created_at timestamptz not null default now(),
  unique (opportunity_id, stage)
);

comment on table public.opportunity_awareness_stages is
  'What an asset has to say at each step of this buyer''s understanding. Deliberately NOT the sixteen templates'' S0-S6 audience state: that axis is about reach and what a platform will let us do, this one is about what the buyer knows. A stranger can be solution-aware.';

-- ---------------------------------------------------------------------------
-- The proof it would need
-- ---------------------------------------------------------------------------

-- A requirement with no proof against it is a gap, and a gap is a job rather
-- than a silence. This is what lets the engine refuse to ship a claim the
-- client cannot substantiate.
create table public.opportunity_proof_requirements (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.market_opportunities(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  requirement text not null check (length(btrim(requirement)) between 1 and 1000),
  proof_id uuid references public.client_proof_assets(id) on delete set null,
  satisfied_at timestamptz,
  created_at timestamptz not null default now(),
  check ((proof_id is null) = (satisfied_at is null))
);

comment on table public.opportunity_proof_requirements is
  'What this opportunity has to be able to prove, and what proves it. A row with no proof_id is a gap: the thing to capture before a campaign makes the claim.';

create index opportunity_proof_requirements_gap_idx
  on public.opportunity_proof_requirements (client_id, opportunity_id) where proof_id is null;

-- ---------------------------------------------------------------------------
-- Scoring
-- ---------------------------------------------------------------------------

-- The weights are data, not a formula in a function, because they are a guess
-- that has to be calibrated against what actually converts. A weight nobody
-- can change without a migration is a weight nobody changes.
create table public.opportunity_score_factors (
  factor text primary key check (factor in (
    'economic_value', 'commercial_urgency', 'reachability', 'available_proof',
    'offer_fit', 'competitive_opportunity', 'delivery_capacity')),
  label text not null,
  weight numeric(4,3) not null check (weight > 0 and weight <= 1),
  note text not null
);

insert into public.opportunity_score_factors (factor, label, weight, note) values
  ('economic_value', 'Economic value', 0.20,
   'Customer value, margins and the acquisition economics we expect.'),
  ('commercial_urgency', 'Commercial urgency', 0.15,
   'How strongly the problem is felt, and how much reason there is to act now.'),
  ('reachability', 'Reachability', 0.15,
   'Whether we can actually get in front of these people on a channel we have.'),
  ('available_proof', 'Available proof', 0.15,
   'Case studies, results, footage and testimonials that speak to this situation.'),
  ('offer_fit', 'Offer fit', 0.15,
   'How well what the client sells solves this particular problem.'),
  ('competitive_opportunity', 'Competitive opportunity', 0.10,
   'Demand nobody is serving well, and room to say something different.'),
  ('delivery_capacity', 'Delivery capacity', 0.10,
   'Whether the client can serve more of these customers profitably.')
on conflict (factor) do update
  set label = excluded.label, weight = excluded.weight, note = excluded.note;

-- The weights are meant to be adjusted, and a set that does not add up to one
-- makes every score incomparable with every earlier score. Checked as a whole
-- rather than per row, because no single row is wrong on its own.
create or replace function public.check_opportunity_weights()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare v_total numeric;
begin
  select sum(weight) into v_total from public.opportunity_score_factors;
  if round(v_total, 3) <> 1.000 then
    raise exception 'Opportunity score weights must add up to 1. They add up to %.', round(v_total, 3);
  end if;
  return null;
end $$;

create constraint trigger opportunity_weights_total
  after insert or update or delete on public.opportunity_score_factors
  deferrable initially deferred
  for each row execute function public.check_opportunity_weights();

-- One row per scoring, kept rather than overwritten: the interesting question
-- six weeks in is which way a score moved and what somebody believed when
-- they moved it.
create table public.opportunity_scores (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.market_opportunities(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  factors jsonb not null check (jsonb_typeof(factors) = 'object'),
  total numeric(5,2) not null check (total >= 0 and total <= 100),
  classification text not null check (classification in ('scale', 'test', 'research', 'reject')),
  note text,
  scored_by uuid references public.profiles(id) on delete set null,
  scored_at timestamptz not null default now()
);

comment on table public.opportunity_scores is
  'A scoring, kept. Scores are overwritten nowhere: which way a score moved, and what somebody believed when they moved it, is the useful part six weeks later.';

create index opportunity_scores_latest_idx
  on public.opportunity_scores (opportunity_id, scored_at desc);

-- ---------------------------------------------------------------------------
-- Which moves are legal
-- ---------------------------------------------------------------------------

create table public.opportunity_transitions (
  from_status opportunity_status not null,
  to_status opportunity_status not null,
  note text,
  primary key (from_status, to_status)
);

insert into public.opportunity_transitions (from_status, to_status, note) values
  ('discovered', 'validated', 'Somebody checked the hypothesis holds up.'),
  ('discovered', 'rejected',  'Not worth pursuing.'),
  ('validated',  'approved',  'Cleared to have campaigns built for it.'),
  ('validated',  'rejected',  'Checked, and not worth pursuing after all.'),
  ('approved',   'active',    'Campaigns are running against it.'),
  ('active',     'learning',  'Results are coming back and being read.'),
  ('learning',   'scaling',   'The economics hold. Give it more.'),
  ('learning',   'active',    'Back to running while something is changed.'),
  ('scaling',    'learning',  'Still reading results at the larger size.'),
  -- Anything in flight can stop, and anything stopped can start again at the
  -- stage it stopped from. Rejection is the only one-way door.
  ('discovered', 'paused', null), ('validated', 'paused', null),
  ('approved',   'paused', null), ('active',    'paused', null),
  ('learning',   'paused', null), ('scaling',   'paused', null),
  ('paused', 'discovered', null), ('paused', 'validated', null),
  ('paused', 'approved',   null), ('paused', 'active',    null),
  ('paused', 'learning',   null), ('paused', 'scaling',   null),
  ('paused', 'rejected', 'Stopped, and then written off.'),
  ('approved', 'rejected', 'Approved, then thought better of before anything ran.')
on conflict (from_status, to_status) do nothing;

create or replace function public.guard_opportunity_status()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.client_id <> old.client_id then
    raise exception 'An opportunity cannot move between clients.';
  end if;
  if new.status is distinct from old.status
     and not exists (select 1 from public.opportunity_transitions t
                     where t.from_status = old.status and t.to_status = new.status) then
    raise exception 'An opportunity cannot go from % to %.', old.status, new.status;
  end if;
  -- Confidence is evidence. It is not a thing an edit should be able to
  -- invent, and it never goes up on its own.
  if new.confidence <> old.confidence and new.proposed_by = 'agent'
     and auth.role() = 'service_role' and new.confidence > old.confidence then
    raise exception 'An agent cannot raise its own opportunity''s confidence.';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger opportunity_status_guard before update on public.market_opportunities
  for each row execute function public.guard_opportunity_status();

-- ---------------------------------------------------------------------------
-- What happened
-- ---------------------------------------------------------------------------

create table public.opportunity_events (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.market_opportunities(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  event text not null check (event in (
    'proposed', 'edited', 'scored', 'status_changed', 'linked', 'unlinked',
    'proof_required', 'proof_satisfied', 'confidence_changed')),
  actor text not null check (actor in ('human', 'agent', 'system')),
  detail text,
  occurred_at timestamptz not null default now()
);

create index opportunity_events_idx
  on public.opportunity_events (opportunity_id, occurred_at desc);

create or replace function public.guard_opportunity_event_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  raise exception 'Opportunity events are a record of what happened. They are not edited.';
end $$;

create trigger opportunity_events_append_only
  before update or delete on public.opportunity_events
  for each row execute function public.guard_opportunity_event_append_only();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.market_opportunities enable row level security;
alter table public.opportunity_attributes enable row level security;
alter table public.opportunity_links enable row level security;
alter table public.opportunity_awareness_stages enable row level security;
alter table public.opportunity_proof_requirements enable row level security;
alter table public.opportunity_scores enable row level security;
alter table public.opportunity_events enable row level security;
alter table public.opportunity_transitions enable row level security;
alter table public.opportunity_score_factors enable row level security;

create policy market_opportunities_read on public.market_opportunities
  for select to authenticated using (public.can_access_client(client_id));
create policy opportunity_attributes_read on public.opportunity_attributes
  for select to authenticated using (public.can_access_client(client_id));
create policy opportunity_links_read on public.opportunity_links
  for select to authenticated using (public.can_access_client(client_id));
create policy opportunity_awareness_read on public.opportunity_awareness_stages
  for select to authenticated using (public.can_access_client(client_id));
create policy opportunity_proof_read on public.opportunity_proof_requirements
  for select to authenticated using (public.can_access_client(client_id));
create policy opportunity_scores_read on public.opportunity_scores
  for select to authenticated using (public.can_access_client(client_id));
create policy opportunity_events_read on public.opportunity_events
  for select to authenticated using (public.can_access_client(client_id));
create policy opportunity_transitions_read on public.opportunity_transitions
  for select to authenticated using (true);
create policy opportunity_score_factors_read on public.opportunity_score_factors
  for select to authenticated using (true);

grant select on public.market_opportunities, public.opportunity_attributes,
  public.opportunity_links, public.opportunity_awareness_stages,
  public.opportunity_proof_requirements, public.opportunity_scores,
  public.opportunity_events, public.opportunity_transitions,
  public.opportunity_score_factors to authenticated;

grant all on public.market_opportunities, public.opportunity_attributes,
  public.opportunity_links, public.opportunity_awareness_stages,
  public.opportunity_proof_requirements, public.opportunity_scores,
  public.opportunity_events, public.opportunity_transitions,
  public.opportunity_score_factors to service_role;
