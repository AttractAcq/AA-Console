-- Choosing between the candidates, and approving one without a person.
--
-- M3.6 and M3.7 together, because the selector's last act is a policy
-- approval and splitting them would mean shipping a function with nothing to
-- call it or a caller with nothing to call.
--
-- The selector is arithmetic, not a model. The build plan allows either --
-- "an agent (idea_select) or a scorer" -- and every criterion it names is
-- measurable: how different an idea is from what this client has already
-- published, whether there is proof to stand it up, and whether the idea
-- arrived complete. A model asked to rank four ideas on those three things
-- would be a model asked to do arithmetic, once an hour, per slot, for every
-- client, and charged for. The reasons it records are the components of the
-- score, so "each pick shows its reasons" is true by construction rather
-- than by asking a model to explain itself.
--
-- The policy approval is the part that needs care. It approves an *idea* so
-- the brief can be written. It does not, and must not, touch
-- human_approved_at on anything: that stays the one human commit, and a
-- chain approved entirely by policy still cannot be scheduled for publishing
-- until a person signs the asset off. There is a test for exactly that.

-- ---------------------------------------------------------------------------
-- How alike two titles are
-- ---------------------------------------------------------------------------

-- pg_trgm is not installed, so similarity() is not available and installing
-- an extension to rank four strings would be a heavy answer to a light
-- question. This is word overlap: the share of the candidate's significant
-- words that also appear in the other title. Immutable and deterministic,
-- which is what the rest of the engine is built on.
create or replace function public.title_overlap(p_candidate text, p_other text)
returns numeric
language sql
immutable
set search_path to 'public'
as $$
  with words as (
    select
      array(select distinct w from unnest(
        regexp_split_to_array(lower(coalesce(p_candidate, '')), '[^a-z0-9]+')) as w
        where length(w) > 3) as a,
      array(select distinct w from unnest(
        regexp_split_to_array(lower(coalesce(p_other, '')), '[^a-z0-9]+')) as w
        where length(w) > 3) as b
  )
  select case
    when coalesce(array_length(a, 1), 0) = 0 then 0::numeric
    else round(
      (select count(*) from unnest(a) as x where x = any(b))::numeric
      / array_length(a, 1), 4)
  end
  from words;
$$;

comment on function public.title_overlap(text, text) is
  'The share of the first title''s significant words that appear in the second. Words of four letters or more, so "the" and "and" do not make everything look alike.';

-- ---------------------------------------------------------------------------
-- What the engine decided, and why
-- ---------------------------------------------------------------------------

create table if not exists engine_decisions (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references content_slots(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null,
  -- What it chose. An idea for a selection; later a brief for M3.7's other
  -- half, when the brief approval needs recording the same way.
  idea_id uuid references client_ideas(id) on delete set null,
  brief_id uuid references client_briefs(id) on delete set null,
  score numeric(6, 2),
  -- The components, in words. A pick that cannot say why it was a pick is
  -- a pick nobody can argue with, which is worse than one they can.
  reasons jsonb not null default '[]'::jsonb,
  -- Everything that was considered and not chosen, with its score, so the
  -- ones that lost are still visible.
  considered jsonb not null default '[]'::jsonb,
  decided_at timestamptz not null default now(),
  constraint ed_kind check (kind in ('idea_selected', 'brief_approved'))
);

comment on table engine_decisions is
  'Every decision the engine made on a client''s behalf, with its score, its reasons and what it passed over. Attributed to the engine, never to a person.';

create index if not exists engine_decisions_slot_idx on engine_decisions (slot_id, decided_at desc);

alter table engine_decisions enable row level security;

drop policy if exists ed_scoped_read on engine_decisions;
create policy ed_scoped_read on engine_decisions
  for select to authenticated using (can_access_client(client_id));

grant select on engine_decisions to authenticated;

-- ---------------------------------------------------------------------------
-- Scoring the candidates
-- ---------------------------------------------------------------------------

-- Out of 100, from three parts that are each worth saying out loud:
--
--   novelty      0-50  How unlike this client's published work the idea is.
--                      The engine's whole purpose is content that compounds,
--                      and publishing the same idea again does not compound.
--   proof        0-30  Whether there is proof on file to stand it up. Not
--                      fatal to lack it -- plenty of good content makes no
--                      claim -- so the floor is 10 rather than 0.
--   completeness 0-20  Whether the idea arrived with the question it answers
--                      and a reason it matters, rather than just a title.
create or replace function public.score_slot_ideas(p_slot_id uuid)
returns table (
  idea_id uuid,
  title text,
  score numeric,
  novelty numeric,
  proof numeric,
  completeness numeric,
  reasons jsonb
)
language sql
stable
set search_path to 'public'
as $$
  with slot as (
    select s.id, s.client_id from content_slots s where s.id = p_slot_id
  ),
  candidates as (
    select i.id, i.title, i.body, i.source_question, i.strategic_reason, i.content_territory
    from client_ideas i, slot
    where i.slot_id = slot.id
      and i.status = 'draft'
      and i.archived_at is null
  ),
  -- The closest thing this client has already published. No archive at all
  -- means nothing to repeat, which is full marks rather than none.
  closest as (
    select c.id,
           coalesce(max(greatest(
             title_overlap(c.title, a.idea_title),
             title_overlap(c.title, a.title))), 0) as overlap
    from candidates c
    left join content_archive a on a.client_id = (select client_id from slot)
    group by c.id
  ),
  has_proof as (
    select exists (
      select 1 from client_proof_assets p
      where p.client_id = (select client_id from slot)
    ) as any_proof
  ),
  scored as (
    select
      c.id,
      c.title,
      round((1 - cl.overlap) * 50, 2) as novelty,
      case when hp.any_proof then 30::numeric else 10::numeric end as proof,
      (case when length(coalesce(c.source_question, '')) > 10 then 10 else 0 end
       + case when length(coalesce(c.strategic_reason, '')) > 20 then 10 else 0 end)::numeric
        as completeness,
      cl.overlap
    from candidates c
    join closest cl on cl.id = c.id
    cross join has_proof hp
  )
  select
    s.id,
    s.title,
    s.novelty + s.proof + s.completeness as score,
    s.novelty,
    s.proof,
    s.completeness,
    jsonb_build_array(
      case
        when s.overlap = 0 then 'Nothing like it in this client''s archive.'
        else format('Shares %s%% of its words with something already published.', round(s.overlap * 100))
      end,
      case when s.proof >= 30 then 'There is proof on file to stand it up.'
           else 'No proof on file; the idea has to carry itself.' end,
      case when s.completeness = 20 then 'Arrived with the question it answers and a reason it matters.'
           when s.completeness = 0 then 'Arrived as little more than a title.'
           else 'Arrived partly explained.' end
    ) as reasons
  from scored s
  -- Deterministic all the way down: ties break on the title, then the id,
  -- so the same candidates always produce the same winner.
  order by (s.novelty + s.proof + s.completeness) desc, s.title, s.id;
$$;

comment on function public.score_slot_ideas(uuid) is
  'Every undecided candidate for a slot, scored out of 100 on novelty, proof and completeness, best first. Deterministic, including the tie-break.';

grant execute on function public.score_slot_ideas(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Approving an idea without a person
-- ---------------------------------------------------------------------------

-- The policy variant of approve_idea_and_generate_brief. Three differences,
-- all deliberate:
--
--   It does not enqueue the brief. The tick queues work for a slot that is
--   ready, and a second path into the queue would be a second answer to
--   "what is this slot waiting for".
--
--   It leaves the idea at 'approved' rather than moving it on to 'briefed',
--   because no brief has been written yet and saying otherwise would make
--   the idea bank lie about what exists.
--
--   It touches nothing a person is supposed to decide. There is no path from
--   here to human_approved_at.
create or replace function public.approve_idea_by_policy(
  p_idea_id uuid,
  p_slot_id uuid,
  p_score numeric default null,
  p_reasons jsonb default '[]'::jsonb,
  p_considered jsonb default '[]'::jsonb
)
returns engine_decisions
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot content_slots;
  v_idea client_ideas;
  v_settings client_engine_settings;
  v_decision engine_decisions;
begin
  -- The engine only. A person approving an idea uses
  -- approve_idea_and_generate_brief, which records it as theirs.
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Policy approvals are the engine''s. A person approves an idea with approve_idea_and_generate_brief.'
      using errcode = 'P0001';
  end if;

  select * into v_slot from content_slots where id = p_slot_id for update;
  if not found then
    raise exception 'No such slot: %.', p_slot_id using errcode = 'P0001';
  end if;

  select * into v_idea from client_ideas where id = p_idea_id;
  if not found then
    raise exception 'No such idea: %.', p_idea_id using errcode = 'P0001';
  end if;
  if v_idea.client_id <> v_slot.client_id then
    raise exception 'That idea belongs to a different client than the slot.' using errcode = 'P0001';
  end if;
  if v_idea.slot_id is distinct from p_slot_id then
    -- An idea generated for another slot is not a candidate for this one.
    raise exception 'That idea was not generated for this slot.' using errcode = 'P0001';
  end if;

  -- The client has to have asked for this. auto_approve_ideas off means a
  -- person wanted to choose, and the engine choosing anyway would be the
  -- engine overruling the setting that exists to stop it.
  select * into v_settings from client_engine_settings where client_id = v_slot.client_id;
  if not coalesce(v_settings.auto_approve_ideas, false) then
    raise exception 'This client has not switched on policy approval of ideas.' using errcode = 'P0001';
  end if;

  update client_ideas set status = 'approved' where id = p_idea_id;

  insert into engine_decisions (slot_id, client_id, kind, idea_id, score, reasons, considered)
  values (p_slot_id, v_slot.client_id, 'idea_selected', p_idea_id, p_score,
          coalesce(p_reasons, '[]'::jsonb), coalesce(p_considered, '[]'::jsonb))
  returning * into v_decision;

  -- The slot moves, and carries the idea with it, so "an idea was chosen"
  -- and "the slot is past ideating" cannot disagree.
  perform advance_slot(
    p_slot_id, 'idea_selected', 'policy',
    format('Chose "%s" (%s/100).', left(v_idea.title, 120), coalesce(round(p_score), 0)),
    'idea_select', null, null, p_idea_id);

  return v_decision;
end;
$$;

comment on function public.approve_idea_by_policy is
  'Approve an idea for a slot on the engine''s behalf. service_role only, refuses a client that has not switched on policy approval, and never touches human_approved_at.';

revoke all on function public.approve_idea_by_policy(uuid, uuid, numeric, jsonb, jsonb) from public;
grant execute on function public.approve_idea_by_policy(uuid, uuid, numeric, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Doing both at once
-- ---------------------------------------------------------------------------

-- Score, pick the best, approve it, record what lost. One call, because the
-- selector agent has nothing else to do and a round trip per candidate would
-- be a round trip to compute a number that was already computed.
create or replace function public.select_idea_for_slot(p_slot_id uuid)
returns engine_decisions
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_best record;
  v_considered jsonb;
begin
  select * into v_best from score_slot_ideas(p_slot_id) limit 1;
  if not found then
    raise exception 'There are no undecided ideas for this slot to choose between.'
      using errcode = 'P0001';
  end if;

  -- Everything that lost, with its score. Rejected candidates stay in the
  -- bank as drafts; this is the record of them having been weighed.
  select coalesce(jsonb_agg(jsonb_build_object(
           'idea_id', s.idea_id, 'title', s.title, 'score', s.score) order by s.score desc), '[]'::jsonb)
    into v_considered
    from score_slot_ideas(p_slot_id) s
   where s.idea_id <> v_best.idea_id;

  return approve_idea_by_policy(v_best.idea_id, p_slot_id, v_best.score, v_best.reasons, v_considered);
end;
$$;

comment on function public.select_idea_for_slot(uuid) is
  'Score the slot''s candidates, approve the best by policy, and record what it passed over. The losers stay in the bank as drafts.';

revoke all on function public.select_idea_for_slot(uuid) from public;
grant execute on function public.select_idea_for_slot(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Wiring it into the tick
-- ---------------------------------------------------------------------------

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values (
  'idea_select', 'Idea Selector', 'IS', 'content',
  'Scores the candidates generated for a slot and approves the best one by policy. Arithmetic, not a model.',
  array[]::text[], true)
on conflict (agent_key) do nothing;

-- A slot resting at ideating with nothing running is one whose ideas have
-- arrived and need choosing between.
insert into slot_pipeline (stage, format, agent_key, enter_stage, note)
values ('ideating', null, 'idea_select', null, 'Choose between the candidates.')
on conflict (stage, format) do nothing;

-- ---------------------------------------------------------------------------
-- Seeing the decision
-- ---------------------------------------------------------------------------

create or replace view slot_decisions with (security_invoker = true) as
select
  d.slot_id,
  d.client_id,
  d.kind,
  d.score,
  d.reasons,
  d.considered,
  d.decided_at,
  i.title as chosen_title,
  jsonb_array_length(d.considered) as passed_over
from engine_decisions d
left join client_ideas i on i.id = d.idea_id;

comment on view slot_decisions is
  'What the engine chose for each slot, why, and how many it passed over. What the approval card shows a person before they sign anything off.';

grant select on slot_decisions to authenticated;
