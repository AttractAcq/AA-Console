-- G06: which of the sixteen fits this awareness stage.
--
-- The matrix has existed since the paid campaigns were built, in two
-- TypeScript files -- one for the picker, one for the planner. Both are
-- correct and neither is reachable from SQL, so the one question the
-- opportunity work actually asks could not be answered by a join:
--
--   this stage is product_aware. Which template moves them?
--
-- Both halves of that join already existed and had nothing between them. An
-- awareness stage records one of the five awareness levels. A template
-- records the audience state it enters at, S0 to S6. Nothing said which
-- audience state a product_aware person is in, so picking a template was
-- tribal knowledge: the person who knew the matrix picked well and nobody
-- else could check them.
--
-- SO: TWO TABLES OF DATA, AND THE JOIN FALLS OUT
--
-- `campaign_template_matrix` is the sixteen as rows, seeded from
-- agent-runtime/src/campaigns/templates.ts, which stays the source of truth.
-- A test asserts the two agree, because a matrix that has drifted from the
-- planner's copy is worse than no matrix: it would recommend a template
-- whose optimisation event the builder would then refuse.
--
-- `awareness_audience_map` is the missing link: which audience states a
-- person at each awareness level occupies, and why. It is deliberately
-- many-to-many, because a problem_aware person may never have heard of this
-- client (S0) or may have been watching them for a month (S1), and the
-- honest answer is both.
--
-- The consequence worth having: every awareness stage already recorded gets
-- recommendations immediately, with no new data entry. A person can still
-- override the mapping per stage where their niche does not behave like the
-- general case.
--
-- WHAT THE MAP CANNOT COVER, AND SAYS SO
--
-- Awareness is about the problem; the customer templates are about the
-- relationship. C1, C2 and C3 serve S5 and S6 -- customers and lapsed
-- customers -- and no awareness level describes somebody who has already
-- bought. Those three are reachable from no awareness stage, which is a real
-- fact about the matrix and not a hole in the map, so `customer_lifecycle`
-- marks them rather than inventing a stage to hang them from.
--
-- WHAT THIS DOES NOT DO
--
-- It does not choose. `recommended_template` is written by a person, with a
-- rationale, and the view beside it shows what else was available. A
-- recommendation that silently became the decision would move the judgement
-- out of the strategist's hands and into a join, and the matrix is a library
-- of trade-offs, not a lookup.

-- ---------------------------------------------------------------------------
-- The sixteen, as rows
-- ---------------------------------------------------------------------------

create table if not exists public.campaign_template_matrix (
  code campaign_template primary key,
  name text not null,

  -- build adds people to a pool, spend converts one, learn buys information.
  -- An account that only spends reports excellent numbers until the pool
  -- runs out, which is why this is a column and not a comment.
  fn text not null check (fn in ('build', 'spend', 'learn')),

  entry_state text not null check (entry_state in ('S0','S1','S2','S3','S4','S5','S6')),
  exit_state  text not null check (exit_state  in ('S0','S1','S2','S3','S4','S5','S6')),

  objective text,
  optimisation text,
  ctas text[] not null default '{}',
  destination text not null check (destination in (
    'profile', 'instant_form', 'message', 'page', 'post', 'none')),

  kpi text not null,
  purpose text not null,
  -- The way this template is most often got wrong. Shown beside the
  -- recommendation, because the trade-off is the useful half.
  guardrail text not null,
  -- Null means it can run for a client with no history.
  prerequisite text,
  mirrors boolean not null default false
);

comment on table public.campaign_template_matrix is
  'The sixteen campaign templates as data, so an awareness stage can be joined to the templates that move its audience. Seeded from agent-runtime/src/campaigns/templates.ts, which remains the source of truth; a test asserts they agree.';

comment on column public.campaign_template_matrix.entry_state is
  'The audience state a person is in when this template reaches them. This is the column the awareness-stage recommendation joins on.';

insert into public.campaign_template_matrix (
  code, name, fn, entry_state, exit_state, objective, optimisation, ctas,
  destination, kpi, purpose, guardrail, prerequisite, mirrors) values
('P1'::campaign_template, 'Prospect to follow', 'build', 'S0', 'S2', 'OUTCOME_ENGAGEMENT', 'PROFILE_VISIT', array['LEARN_MORE']::text[], 'profile', 'Cost per engaged follower at 30 days', 'Buys a channel we can reach them through for free, forever.', 'Page-likes optimisation buys followers who never come back. Score engaged followers, not the count.', null, false),
  ('P2'::campaign_template, 'Prospect to direct lead', 'build', 'S0', 'S3', 'OUTCOME_LEADS', 'LEAD_GENERATION', array['SIGN_UP','BOOK_NOW','GET_QUOTE']::text[], 'instant_form', 'Cost per lead and lead-to-booked rate, together', 'The fast cycle: skips the nurture where intent is already high.', 'Cost per lead on its own rewards junk. A form with no qualifying question halves quality.', null, false),
  ('P3'::campaign_template, 'Prospect to DM', 'build', 'S0', 'S3', 'OUTCOME_ENGAGEMENT', 'CONVERSATIONS', array['SEND_MESSAGE']::text[], 'message', 'Cost per replied conversation', 'Lowest-friction identity capture: a conversation costs less than a form.', 'Worthless without something answering out of hours. Check that before spending.', null, false),
  ('P4'::campaign_template, 'Attention prime', 'build', 'S0', 'S1', 'OUTCOME_AWARENESS', 'THRUPLAY', '{}'::text[], 'none', 'Cost per 15-second view, and pool size', 'Cheap reach whose only job is filling the pools the retargeting templates spend.', 'Deliberately no CTA. Asking for the click here defeats the purpose.', null, false),
  ('P5'::campaign_template, 'Lead magnet', 'build', 'S0', 'S3', 'OUTCOME_LEADS', 'LEAD_GENERATION', array['DOWNLOAD','SIGN_UP']::text[], 'page', 'Cost per lead that opened the asset', 'Buys contact details with value rather than with an offer.', 'A magnet nobody opens produced contact details, not interest. Never score on leads captured.', 'A magnet and the page that gates it.', false),
  ('R1'::campaign_template, 'Retarget to next step', 'spend', 'S1', 'S3', 'OUTCOME_LEADS', 'OFFSITE_CONVERSIONS', array['BOOK_NOW','SHOP_NOW','LEARN_MORE']::text[], 'page', 'Return on ad spend, and how fast the pool is drawn down', 'The highest return in the account, capped by whatever P1 and P4 refill.', 'Cannot outrun what feeds it. Watch frequency above 3.', 'P1 or P4 running 14 days or more.', false),
  ('R2'::campaign_template, 'Objection answering', 'spend', 'S3', 'S5', 'OUTCOME_SALES', 'OFFSITE_CONVERSIONS', array['BOOK_NOW','LEARN_MORE']::text[], 'page', 'Close rate across the sequence', 'One objection per ad, sequenced. Where the proof bank earns its keep.', 'An ad answering three objections answers none of them.', 'Leads that did not convert.', false),
  ('R3'::campaign_template, 'Abandon recovery', 'spend', 'S3', 'S4', 'OUTCOME_SALES', 'OFFSITE_CONVERSIONS', array['BOOK_NOW']::text[], 'page', 'Recovery rate', 'Catches the ones who got most of the way and stopped.', 'One to three days, then stop. Past a week it is just annoying.', 'A pixel recording the step they left.', false),
  ('R4'::campaign_template, 'Proof seeding', 'build', 'S1', 'S1', 'OUTCOME_ENGAGEMENT', 'POST_ENGAGEMENT', '{}'::text[], 'post', 'Comments per pound', 'Loads a post with real comments before it is scaled.', 'Scale the same post by ID afterwards, or the proof does not carry over.', 'A post worth seeding.', false),
  ('C1'::campaign_template, 'Customer expansion', 'spend', 'S5', 'S5', 'OUTCOME_SALES', 'OFFSITE_CONVERSIONS', array['SHOP_NOW','BOOK_NOW']::text[], 'page', 'Revenue per existing customer reached', 'The cheapest revenue in the account: the acquisition is already paid for.', 'Exclude anyone mid-purchase.', 'A customer list.', false),
  ('C2'::campaign_template, 'Reactivation', 'spend', 'S6', 'S5', 'OUTCOME_SALES', 'OFFSITE_CONVERSIONS', array['GET_OFFER','BOOK_NOW']::text[], 'page', 'Reactivation rate', 'Brings back the ones who bought once and went quiet.', 'Needs a reason the gap should end. "We miss you" is not one.', 'A lapsed customer list.', false),
  ('C3'::campaign_template, 'Referral', 'build', 'S5', 'S0', 'OUTCOME_TRAFFIC', 'LANDING_PAGE_VIEWS', array['LEARN_MORE']::text[], 'page', 'Referrals per customer reached', 'Customers introduce strangers at close to no acquisition cost.', 'Customers only, and a small budget. The audience is tiny by definition.', 'A customer list and something worth referring.', false),
  ('O1'::campaign_template, 'Promotional', 'spend', 'S2', 'S5', 'OUTCOME_SALES', 'OFFSITE_CONVERSIONS', array['GET_OFFER','SHOP_NOW']::text[], 'page', 'Revenue inside the window', 'The deadline does the work, not the discount.', 'A deadline that moves never works again. People learn it in one cycle.', 'A real offer with a real end date.', false),
  ('O2'::campaign_template, 'Event or webinar', 'build', 'S0', 'S3', 'OUTCOME_LEADS', 'LEAD_GENERATION', array['SIGN_UP']::text[], 'page', 'Attendance, not registrations', 'A date creates urgency an offer cannot.', 'Registrations are free to give and free to skip. Optimising to them fills an empty room.', 'A date.', false),
  ('X1'::campaign_template, 'Lookalike scale', 'spend', 'S0', 'S3', null, null, '{}'::text[], 'page', 'Cost per acquisition against the template it scales', 'Takes a template that works and points it at people like the best pool we own.', 'A 1% lookalike seeded on customers beats a 5% seeded on visitors.', 'A seed of 100 or more, ideally 1,000.', true),
  ('X2'::campaign_template, 'Test', 'learn', 'S0', 'S0', null, null, '{}'::text[], 'page', 'Confidence, not cost per acquisition', 'Buys information about one creative, audience or offer.', 'One variable, a fixed budget, and it stops on the date rather than on a feeling.', null, true)
on conflict (code) do update set
  name = excluded.name, fn = excluded.fn, entry_state = excluded.entry_state,
  exit_state = excluded.exit_state, objective = excluded.objective,
  optimisation = excluded.optimisation, ctas = excluded.ctas,
  destination = excluded.destination, kpi = excluded.kpi, purpose = excluded.purpose,
  guardrail = excluded.guardrail, prerequisite = excluded.prerequisite,
  mirrors = excluded.mirrors;

alter table public.campaign_template_matrix enable row level security;
drop policy if exists campaign_template_matrix_read on public.campaign_template_matrix;
create policy campaign_template_matrix_read on public.campaign_template_matrix
  for select to authenticated using (true);
grant select on public.campaign_template_matrix to authenticated;
grant all on public.campaign_template_matrix to service_role;

-- ---------------------------------------------------------------------------
-- The missing link: where a person at each awareness level stands
-- ---------------------------------------------------------------------------

create table if not exists public.awareness_audience_map (
  awareness_level text not null check (awareness_level in
    ('unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware')),
  audience_state text not null check (audience_state in ('S0','S1','S2','S3','S4','S5','S6')),
  -- Why somebody at this awareness level is in this state. Read beside the
  -- recommendation, because the reason is what a strategist argues with.
  note text not null,
  primary key (awareness_level, audience_state)
);

comment on table public.awareness_audience_map is
  'Which audience states a person at each of the five awareness levels occupies. Many-to-many on purpose: a problem_aware person may never have heard of this client or may have been watching for a month, and both are true of different people in the same niche.';

insert into public.awareness_audience_map (awareness_level, audience_state, note) values
  ('unaware', 'S0',
   'Does not know the problem has a name, so by definition has no relationship with anybody solving it.'),

  ('problem_aware', 'S0',
   'Feels the problem and has not started looking. Still a stranger to this client.'),
  ('problem_aware', 'S1',
   'Feels the problem and has seen the client in passing, which is what makes the cheap reach templates worth running before the expensive ones.'),

  ('solution_aware', 'S1',
   'Knows solutions exist and is watching a few providers without committing to any.'),
  ('solution_aware', 'S2',
   'Followed the client while comparing approaches. The state the nurture layer is built to create.'),

  ('product_aware', 'S2',
   'Knows this client specifically and is following them while deciding.'),
  ('product_aware', 'S3',
   'Has identified themselves -- a form, a magnet, a message -- and is weighing it up.'),

  ('most_aware', 'S3',
   'Ready, and waiting for a reason to act now rather than later.'),
  ('most_aware', 'S4',
   'Already in conversation. The templates that help here are the ones that remove a last objection.')
on conflict (awareness_level, audience_state) do update set note = excluded.note;

alter table public.awareness_audience_map enable row level security;
drop policy if exists awareness_audience_map_read on public.awareness_audience_map;
create policy awareness_audience_map_read on public.awareness_audience_map
  for select to authenticated using (true);
grant select on public.awareness_audience_map to authenticated;
grant all on public.awareness_audience_map to service_role;

-- The three the map cannot reach, said out loud rather than left as an
-- absence somebody rediscovers.
create or replace view customer_lifecycle_templates with (security_invoker = true) as
select
  t.code,
  t.name,
  t.fn,
  t.entry_state,
  t.exit_state,
  t.prerequisite,
  t.purpose,
  'Serves a customer or a lapsed customer. No awareness level describes somebody who has already bought, so this template is chosen from the client''s customer list rather than from an awareness journey.'::text as why_unmapped
from public.campaign_template_matrix t
where not exists (
  select 1 from public.awareness_audience_map m where m.audience_state = t.entry_state);

comment on view customer_lifecycle_templates is
  'The templates no awareness stage can recommend, because they enter at an audience state awareness does not describe: C1 and C3 at S5, C2 at S6. A real fact about the matrix, not a gap in the map.';

grant select on customer_lifecycle_templates to authenticated;

-- ---------------------------------------------------------------------------
-- Per-stage override, and the choice
-- ---------------------------------------------------------------------------

alter table public.opportunity_awareness_stages
  add column if not exists audience_state_override text
    check (audience_state_override is null
           or audience_state_override in ('S0','S1','S2','S3','S4','S5','S6')),
  add column if not exists recommended_template campaign_template
    references public.campaign_template_matrix(code) on delete set null,
  add column if not exists template_rationale text;

comment on column public.opportunity_awareness_stages.audience_state_override is
  'Set only where this niche does not behave like the general case -- a trade where everybody who feels the problem is already following somebody, for instance. Null means use awareness_audience_map, which is the normal case.';

comment on column public.opportunity_awareness_stages.recommended_template is
  'The template a person chose for this stage. Written by a person with a rationale, never by the recommendation view.';

-- ---------------------------------------------------------------------------
-- The join that did not exist
-- ---------------------------------------------------------------------------

create or replace view awareness_stage_templates with (security_invoker = true) as
select
  a.id as stage_id,
  a.opportunity_id,
  a.client_id,
  a.stage as awareness_level,
  a.mindset,
  a.audience_state_override,
  st.audience_state,
  (a.audience_state_override is not null) as state_overridden,
  st.note as state_note,
  a.recommended_template,
  t.code as candidate_template,
  t.name as candidate_name,
  t.fn,
  t.entry_state,
  t.exit_state,
  t.destination,
  t.optimisation,
  t.kpi,
  t.purpose,
  t.guardrail,
  t.prerequisite,
  (a.recommended_template is not null and a.recommended_template = t.code) as chosen,
  -- What this template would do to somebody in this stage, said plainly, so
  -- the reason to pick it survives being read six weeks later.
  'Moves ' || t.entry_state || ' to ' || t.exit_state || ' via ' || t.destination
    || case when t.prerequisite is null then '. No prerequisite.'
            else '. Needs: ' || t.prerequisite end as fit
from public.opportunity_awareness_stages a
cross join lateral (
  -- The override replaces the map entirely for this stage; otherwise every
  -- state the map gives this awareness level is a candidate.
  select a.audience_state_override as audience_state, null::text as note
  where a.audience_state_override is not null
  union all
  select m.audience_state, m.note
  from public.awareness_audience_map m
  where a.audience_state_override is null and m.awareness_level = a.stage
) st
join public.campaign_template_matrix t on t.entry_state = st.audience_state;

comment on view awareness_stage_templates is
  'Every awareness stage beside the templates that enter where its audience stands, with each template''s prerequisite and the way it is most often got wrong. Works from the awareness level already recorded, so a journey written months ago gets recommendations without being touched. The recommendation, not the decision: `chosen` marks what a person actually picked.';

grant select on awareness_stage_templates to authenticated;

-- ---------------------------------------------------------------------------
-- What is still missing before a campaign can be briefed from this journey
-- ---------------------------------------------------------------------------

create or replace view opportunity_template_readiness with (security_invoker = true) as
select
  o.id as opportunity_id,
  o.client_id,
  o.name,
  count(a.id)::int as stages,
  count(a.recommended_template)::int as stages_with_template,
  count(distinct a.stage)::int as awareness_levels_covered,
  case
    when count(a.id) = 0
      then 'No awareness journey, so there is nothing to recommend a template for.'
    when count(a.recommended_template) = 0
      then 'Templates are available for every stage and nobody has chosen one yet.'
    when count(a.recommended_template) < count(a.id)
      then (count(a.id) - count(a.recommended_template))::text
           || ' stage(s) still have no chosen template.'
    else null
  end as blocker
from public.market_opportunities o
left join public.opportunity_awareness_stages a on a.opportunity_id = o.id
group by o.id, o.client_id, o.name;

comment on view opportunity_template_readiness is
  'Per opportunity, how much of its awareness journey has been turned into chosen campaigns. Deliberately separate from opportunity_readiness: not having chosen templates yet does not make an opportunity unapprovable, it makes it unbriefed.';

grant select on opportunity_template_readiness to authenticated;

-- ---------------------------------------------------------------------------
-- Recording the choice
-- ---------------------------------------------------------------------------

create or replace function public.set_awareness_stage_template_v6(
  p_stage_id uuid,
  p_template campaign_template default null,
  p_rationale text default null,
  p_audience_state_override text default null)
returns public.opportunity_awareness_stages
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_stage public.opportunity_awareness_stages%rowtype;
  v_entry text;
  v_states text[];
begin
  select * into v_stage from public.opportunity_awareness_stages
   where id = p_stage_id for update;
  if not found then raise exception 'No such awareness stage.' using errcode = 'P0001'; end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.can_access_client(v_stage.client_id), false)) then
    raise exception 'Only an admin or somebody on this client can shape its awareness journey.'
      using errcode = 'P0001';
  end if;

  if p_audience_state_override is not null
     and p_audience_state_override not in ('S0','S1','S2','S3','S4','S5','S6') then
    raise exception 'An audience state is one of S0 to S6.' using errcode = 'P0001';
  end if;

  -- A template that does not enter where this stage's people stand would be
  -- pointed at the wrong audience, which is the mistake this migration
  -- exists to make impossible rather than merely visible.
  if p_template is not null then
    select entry_state into v_entry from public.campaign_template_matrix where code = p_template;

    if coalesce(p_audience_state_override, v_stage.audience_state_override) is not null then
      v_states := array[coalesce(p_audience_state_override, v_stage.audience_state_override)];
    else
      select array_agg(m.audience_state) into v_states
        from public.awareness_audience_map m where m.awareness_level = v_stage.stage;
    end if;

    if v_entry is null or not (v_entry = any (coalesce(v_states, '{}'::text[]))) then
      raise exception 'Template % enters at %, and a % audience is at %. Pick a template that enters where they are, or set an override saying why this niche differs.',
        p_template, coalesce(v_entry, 'an unknown state'), v_stage.stage,
        array_to_string(coalesce(v_states, '{}'::text[]), ' or ')
        using errcode = 'P0001';
    end if;

    if nullif(btrim(coalesce(p_rationale, v_stage.template_rationale, '')), '') is null then
      raise exception 'Say why this template fits this stage.' using errcode = 'P0001';
    end if;
  end if;

  update public.opportunity_awareness_stages
     set audience_state_override =
           coalesce(p_audience_state_override, audience_state_override),
         recommended_template = coalesce(p_template, recommended_template),
         template_rationale =
           coalesce(nullif(btrim(coalesce(p_rationale, '')), ''), template_rationale)
   where id = p_stage_id
   returning * into v_stage;
  return v_stage;
end $$;

comment on function public.set_awareness_stage_template_v6(uuid, campaign_template, text, text) is
  'Records which template a person chose for an awareness stage, refusing one that does not enter where that stage''s audience stands unless an override says why this niche differs.';

revoke all on function public.set_awareness_stage_template_v6(uuid, campaign_template, text, text)
  from public, anon;
grant execute on function public.set_awareness_stage_template_v6(uuid, campaign_template, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What the journey implies, in order
-- ---------------------------------------------------------------------------

create or replace view opportunity_campaign_plan with (security_invoker = true) as
select
  a.opportunity_id,
  a.client_id,
  o.name as opportunity,
  a.id as stage_id,
  a.stage as awareness_level,
  a.recommended_template as template,
  t.name as template_name,
  t.fn,
  t.entry_state,
  t.exit_state,
  t.destination,
  t.prerequisite,
  a.template_rationale,
  a.message,
  a.asset_direction,
  a.distribution_note,
  -- Awareness order, not the order somebody happened to type the stages in.
  row_number() over (
    partition by a.opportunity_id
    order by array_position(
      array['unaware','problem_aware','solution_aware','product_aware','most_aware'],
      a.stage), a.created_at) as step
from public.opportunity_awareness_stages a
join public.market_opportunities o on o.id = a.opportunity_id
left join public.campaign_template_matrix t on t.code = a.recommended_template;

comment on view opportunity_campaign_plan is
  'The campaigns an approved opportunity implies, in awareness order: which template, for which stage, carrying which message. The sequence a person builds from, rather than a list of stages they re-derive it from every time.';

grant select on opportunity_campaign_plan to authenticated;

select lock_down_definer_functions();
