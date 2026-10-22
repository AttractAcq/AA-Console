-- The loop migrations 225-227 left open.
--
-- The Micro-Market Opportunity Engine can find a buying situation, evidence
-- it, score it, say what it would have to prove, and have a person approve
-- it. Then a campaign is created on a different screen by typing a name and
-- a brief into a form, and nothing connects the two. `opportunity_links`
-- has had a `campaign` role since 225 and no way to write one, so the
-- engine's own comment -- "a campaign may exist without a recorded
-- commercial reason, for now" -- describes every campaign in the system.
--
-- That matters for a specific reason rather than a tidiness one. The whole
-- argument for the opportunity layer is that a campaign should exist because
-- somebody would buy something, and the way that argument dies is a person
-- approving an opportunity, opening Campaign Factory, and writing a brief
-- from memory. What they lose is not the paperwork: it is the problem, the
-- desired outcome, the trigger, the positioning and the proof requirements
-- that the opportunity work established.
--
-- So this creates the campaign from the opportunity, carries that reasoning
-- into the brief the planner reads, binds the offer the opportunity is
-- linked to, and records the link both ways.
--
-- WHAT IT REFUSES
--
-- An unapproved opportunity, because a campaign is money spent against a
-- hypothesis and approval is where that is decided. And an opportunity that
-- has stopped being ready since it was approved -- a claim that has lost its
-- proof, a score that has gone to reject -- because `opportunity_readiness`
-- is read now rather than trusted from whenever the approval happened. The
-- blocker sentence it returns is the one the Activate screen shows, so the
-- refusal and the screen say the same thing.
--
-- WHAT IT DOES NOT DO
--
-- It does not plan the campaign. The caller queues `campaign_plan` exactly
-- as the Campaign Factory form does, because planning is a job with a cost
-- and a creation that silently spends is a surprise. It also sets no budget
-- or dates: those are commercial decisions, and inventing them from a score
-- would be the engine pretending to know something it does not.

-- ---------------------------------------------------------------------------
-- The brief, from the reasoning
-- ---------------------------------------------------------------------------

-- Composed in SQL rather than in the browser so that every caller -- the
-- screen, the gateway, a future orchestrator -- gets the same brief from the
-- same opportunity. Only the parts that are filled in appear: a heading with
-- nothing under it reads as though somebody thought about it and had nothing
-- to say.
create function public.opportunity_brief_v6(p_opportunity_id uuid)
returns text language sql stable
set search_path = pg_catalog, public as $$
  with o as (
    select * from public.market_opportunities where id = p_opportunity_id
  ), lists as (
    select kind, string_agg('- ' || body, E'\n' order by position) as body
      from public.opportunity_attributes
     where opportunity_id = p_opportunity_id
     group by kind
  )
  select concat_ws(E'\n\n',
    'This campaign exists for one buying situation: ' || o.micro_market || '.',
    'The situation: ' || o.buying_situation,
    nullif('The problem: ' || coalesce(o.core_problem, ''), 'The problem: '),
    nullif('What they want instead: ' || coalesce(o.desired_outcome, ''), 'What they want instead: '),
    nullif('What makes now the moment: ' || coalesce(o.purchase_trigger, ''), 'What makes now the moment: '),
    nullif('How we position against it: ' || coalesce(o.positioning, ''), 'How we position against it: '),
    nullif('What we want them to do: ' || coalesce(o.conversion_action, ''), 'What we want them to do: '),
    (select E'What frustrates them:\n' || body from lists where kind = 'problem'),
    (select E'What they are trying to achieve:\n' || body from lists where kind = 'outcome'),
    (select E'What stops them:\n' || body from lists where kind = 'objection'),
    case when o.entry_awareness is not null
      then 'They usually arrive ' || replace(o.entry_awareness, '_', ' ') || '.' end
  ) from o;
$$;

comment on function public.opportunity_brief_v6(uuid) is
  'One opportunity''s reasoning as the brief a campaign planner reads. Composed in the database so every caller gets the same brief from the same opportunity.';

revoke all on function public.opportunity_brief_v6(uuid) from public, anon;
grant execute on function public.opportunity_brief_v6(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Creating the campaign
-- ---------------------------------------------------------------------------

create function public.create_campaign_from_opportunity_v6(
  p_opportunity_id uuid,
  p_acquisition_mode text,
  p_paid_platform text default null,
  p_name text default null
) returns public.client_campaigns
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_opportunity public.market_opportunities%rowtype;
  v_readiness record;
  v_offer_version uuid;
  v_existing public.client_campaigns%rowtype;
  v_campaign public.client_campaigns%rowtype;
begin
  select * into v_opportunity from public.market_opportunities where id = p_opportunity_id;
  if not found then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.can_shape_opportunity(v_opportunity.client_id) then
    raise exception 'Only an admin or assigned client manager can create a campaign from an opportunity.'
      using errcode = 'P0001';
  end if;

  -- The route, with 203's rule stated here rather than discovered through a
  -- check constraint violation.
  if p_acquisition_mode not in ('organic', 'paid') then
    raise exception 'Choose an organic or paid route.' using errcode = 'P0001';
  end if;
  if p_acquisition_mode = 'paid' and coalesce(p_paid_platform, '') not in ('meta', 'google') then
    raise exception 'Choose Meta Ads or Google Ads for a paid campaign.' using errcode = 'P0001';
  end if;

  -- Approved onwards. Everything before that is still being worked out, and
  -- a campaign against it is money spent on a maybe.
  if v_opportunity.status not in ('approved', 'active', 'learning', 'scaling') then
    raise exception 'This opportunity is %. Approve it before building a campaign on it.',
      v_opportunity.status using errcode = 'P0001';
  end if;

  -- Readiness read now, not trusted from whenever the approval happened. A
  -- claim can lose its proof, and a score can be redone as reject, in the
  -- weeks between.
  select * into v_readiness from public.opportunity_readiness
   where opportunity_id = p_opportunity_id;
  if v_readiness.blocker is not null then
    raise exception '%', v_readiness.blocker using errcode = 'P0001';
  end if;

  -- One campaign per opportunity per route. A second organic campaign for
  -- the same buying situation is almost always a double-pressed button, and
  -- the deliberate version of it is a clone, which carries its own lineage.
  select c.* into v_existing
    from public.client_campaigns c
    join public.opportunity_links l on l.campaign_id = c.id
   where l.opportunity_id = p_opportunity_id
     and l.role = 'campaign'
     and c.acquisition_mode = p_acquisition_mode
     and coalesce(c.paid_platform, '') = coalesce(p_paid_platform, '')
   order by c.created_at
   limit 1;
  if found then
    return v_existing;
  end if;

  -- The offer this opportunity is linked to, at its latest signed-off
  -- version. Nothing is invented: an opportunity with no linked offer makes
  -- a campaign with no bound offer, exactly as the form allows, and
  -- opportunity_readiness already refuses to call such a one ready.
  select v.id into v_offer_version
    from public.opportunity_links l
    join public.service_offer_versions v
      on v.offer_id = l.offer_id and v.client_id = l.client_id
    join public.service_offer_signoffs s
      on s.offer_version_id = v.id and s.client_id = v.client_id
   where l.opportunity_id = p_opportunity_id and l.role = 'offer'
   order by v.version desc
   limit 1;

  insert into public.client_campaigns (
    client_id, name, brief, acquisition_mode, paid_platform, offer_version_id)
  values (
    v_opportunity.client_id,
    coalesce(nullif(btrim(coalesce(p_name, '')), ''), v_opportunity.name),
    public.opportunity_brief_v6(p_opportunity_id),
    p_acquisition_mode,
    case when p_acquisition_mode = 'paid' then p_paid_platform end,
    v_offer_version)
  returning * into v_campaign;

  -- Both directions. The link table is the relational record 225 asked for;
  -- the event is what makes "why does this campaign exist" answerable from
  -- the opportunity's own history.
  insert into public.opportunity_links (opportunity_id, client_id, role, campaign_id)
  values (p_opportunity_id, v_opportunity.client_id, 'campaign', v_campaign.id)
  on conflict do nothing;

  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (p_opportunity_id, v_opportunity.client_id, 'linked',
          case when coalesce(auth.role(), '') = 'service_role' then 'agent' else 'human' end,
          'Campaign created: ' || v_campaign.name || ' (' || p_acquisition_mode
            || coalesce(' ' || p_paid_platform, '') || ').');

  return v_campaign;
end $$;

comment on function public.create_campaign_from_opportunity_v6(uuid, text, text, text) is
  'Creates one route-bound campaign from an approved, still-ready opportunity, carrying its reasoning into the brief and its linked offer version into the binding. Does not plan it: the caller queues campaign_plan, because planning costs money.';

revoke all on function public.create_campaign_from_opportunity_v6(uuid, text, text, text)
  from public, anon;
grant execute on function public.create_campaign_from_opportunity_v6(uuid, text, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reading it back the other way
-- ---------------------------------------------------------------------------

-- Campaign Factory needs one question answered -- why does this campaign
-- exist -- without learning the shape of five opportunity tables. A view
-- rather than a column on the campaign, so that the opportunity's current
-- status and confidence are what gets read: a campaign built on something
-- since paused should say so rather than carry a copy of how it looked in
-- October.
create or replace view campaign_origins with (security_invoker = true) as
select
  l.campaign_id,
  l.client_id,
  o.id as opportunity_id,
  o.name as opportunity_name,
  o.micro_market,
  o.buying_situation,
  o.status as opportunity_status,
  o.confidence,
  r.score,
  r.classification,
  r.open_proof_gaps,
  r.blocker as opportunity_blocker
from public.opportunity_links l
join public.market_opportunities o on o.id = l.opportunity_id
left join public.opportunity_readiness r on r.opportunity_id = o.id
where l.role = 'campaign' and l.campaign_id is not null;

comment on view campaign_origins is
  'Why each campaign exists: the opportunity it was created from, as that opportunity stands now rather than as it stood then.';

grant select on campaign_origins to authenticated;

select lock_down_definer_functions();
