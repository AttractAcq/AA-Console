-- v6.1 / 0.1: a campaign may be paid, organic, or both.
--
-- Alex, 31 October: "i want to be able to run all of these: either just paid,
-- just organic or paid and organic together."
--
-- WHY THIS IS NOT A LOOSENED CHECK
--
-- Migration 203 made the route a property of the campaign and made it
-- immutable: `acquisition_mode` is one of legacy, organic or paid, with
-- `client_campaigns_acquisition_route_check` tying `paid_platform` to it, a
-- trigger refusing any later change, and `clone_campaign_for_route` refusing
-- to clone into the same mode "to keep independent distribution and results".
--
-- Every organic guard leans on the implication that follows: if the campaign
-- is organic then every asset beneath it is organic. B011's migration 290
-- blocks scheduling with
--
--   if v_campaign.acquisition_mode is distinct from 'organic'
--      or v_campaign.paid_platform is not null then
--
-- and its publisher claim requires `ca.acquisition_mode = 'organic'`.
--
-- For a campaign that runs both routes that implication is false. Relaxing
-- those predicates to accept it, without giving each asset its own route,
-- would make paid creative claimable by the organic publisher -- exactly the
-- leak B011 exists to close. So the route has to move down to the work item.
--
-- WHAT THIS MIGRATION DOES, AND DELIBERATELY DOES NOT
--
-- It adds the capability on the campaign and the route on the idea, and
-- nothing else. It does not touch a single guard. Every new column is
-- fail-closed: `client_ideas.acquisition_route` is null on all 547 existing
-- ideas, and the guard rewrite in the next migration treats null as blocked,
-- so this changes no behaviour for anything already in the database.
--
-- The guard rewrite is a separate reviewed migration because a predicate that
-- looks relaxed and is actually open is the failure mode here, and it deserves
-- its own tests proving a paid idea can never be claimed organically.
--
-- WHAT THE DATABASE SAYS TODAY
--
-- All 20 campaigns are `legacy`; none is organic or paid. So the organic claim
-- predicate matches no rows and campaign-bound organic distribution has never
-- run. `schedule_asset` also raises when an idea has no campaign, so there is
-- currently no path by which any asset can be scheduled at all. Enabling both
-- routes is therefore also what opens organic distribution for the first time,
-- which is a reason to keep the gate closed until the rewrite lands with its
-- tests.

-- ---------------------------------------------------------------------------
-- The campaign declares which routes it runs
-- ---------------------------------------------------------------------------

alter table public.client_campaigns
  add column runs_organic boolean not null default false,
  add column runs_paid boolean not null default false;

-- Deliberately no column for the market opportunity. The notes ask for a
-- campaign "linked to the offer and the market opportunity", and both links
-- already exist: offer_version_id on the row, and the opportunity_links table
-- with role 'campaign', which create_campaign_from_opportunity_v6 writes in
-- both directions. A column beside that table would be a second source of
-- truth for one relationship, and the two would drift.

comment on column public.client_campaigns.runs_organic is
  'Whether this campaign produces and distributes organic content. May be true together with runs_paid.';
comment on column public.client_campaigns.runs_paid is
  'Whether this campaign produces paid creative. May be true together with runs_organic.';
-- `acquisition_mode` stays the column every existing reader consults, and gains
-- 'both'. The two flags are the authority; the mode must agree with them, so a
-- reader that checks `= 'organic'` keeps working for an organic-only campaign
-- and *excludes* a both-campaign. That exclusion is deliberate and is the safe
-- direction: an unrewritten guard refuses a both-campaign rather than letting
-- paid work through it.
alter table public.client_campaigns
  drop constraint client_campaigns_acquisition_route_check;

alter table public.client_campaigns
  add constraint client_campaigns_acquisition_route_check check (
    (acquisition_mode = 'legacy' and not runs_organic and not runs_paid
       and paid_platform is null) or
    (acquisition_mode = 'organic' and runs_organic and not runs_paid
       and paid_platform is null) or
    -- `paid_platform in (...)` is NULL, not false, when the column is null, and
    -- a CHECK only rejects on false -- so the null test has to be explicit or a
    -- paid campaign with no platform satisfies the constraint by accident.
    -- Migration 203 carried exactly that hole; it never bit because no campaign
    -- has ever been paid.
    (acquisition_mode = 'paid' and runs_paid and not runs_organic
       and paid_platform is not null and paid_platform in ('meta', 'google')) or
    (acquisition_mode = 'both' and runs_organic and runs_paid
       and paid_platform is not null and paid_platform in ('meta', 'google'))
  );

comment on column public.client_campaigns.acquisition_mode is
  'legacy, organic, paid or both. Derived from runs_organic and runs_paid and kept in step with them by constraint; a reader that tests for ''organic'' deliberately excludes a both-campaign rather than admitting paid work.';

-- ---------------------------------------------------------------------------
-- Route and lineage stay immutable
-- ---------------------------------------------------------------------------

-- 203's reasoning holds for the new columns: a campaign whose route changed
-- under it would leave already-produced assets on the wrong side of a
-- distribution boundary. Clone instead.
create or replace function public.guard_campaign_acquisition_route()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.acquisition_mode is distinct from new.acquisition_mode
     or old.paid_platform is distinct from new.paid_platform
     or old.runs_organic is distinct from new.runs_organic
     or old.runs_paid is distinct from new.runs_paid
     or old.cloned_from_campaign_id is distinct from new.cloned_from_campaign_id then
    raise exception 'Campaign route and lineage are immutable. Clone this campaign into a new route.';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The idea carries the route
-- ---------------------------------------------------------------------------

-- One route per work item, even when its campaign runs both. Null means no
-- route has been chosen, which the guards must read as blocked.
alter table public.client_ideas
  add column acquisition_route text
    check (acquisition_route in ('organic', 'paid'));

comment on column public.client_ideas.acquisition_route is
  'The single route this idea''s content is produced for. Null means undecided, which every distribution guard must treat as blocked. A campaign running both routes has ideas of both kinds beneath it.';

create index client_ideas_acquisition_route_idx
  on public.client_ideas (campaign_id, acquisition_route)
  where acquisition_route is not null;

-- An idea cannot claim a route its campaign does not run. Checked on write
-- rather than by constraint because it reads the parent row.
create or replace function public.guard_idea_acquisition_route()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare
  v_runs_organic boolean;
  v_runs_paid boolean;
begin
  if new.acquisition_route is null then
    return new;
  end if;
  if new.campaign_id is null then
    -- The client's constant organic stream is not campaign-bound. It may say
    -- organic about itself, but nothing may call itself paid without a
    -- campaign that runs paid.
    if new.acquisition_route <> 'organic' then
      raise exception 'An idea with no campaign may only be organic.';
    end if;
    return new;
  end if;

  select c.runs_organic, c.runs_paid into v_runs_organic, v_runs_paid
    from public.client_campaigns c where c.id = new.campaign_id;
  if not found then
    raise exception 'That campaign no longer exists.';
  end if;
  if new.acquisition_route = 'organic' and not v_runs_organic then
    raise exception 'This campaign does not run an organic route.';
  end if;
  if new.acquisition_route = 'paid' and not v_runs_paid then
    raise exception 'This campaign does not run a paid route.';
  end if;
  return new;
end;
$$;

create trigger guard_idea_acquisition_route_write
  before insert or update of acquisition_route, campaign_id on public.client_ideas
  for each row execute function public.guard_idea_acquisition_route();

-- ---------------------------------------------------------------------------
-- Cloning into both routes
-- ---------------------------------------------------------------------------

create or replace function public.clone_campaign_for_route(
  p_source_campaign_id uuid,
  p_target_mode text,
  p_paid_platform text default null,
  p_name text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_source public.client_campaigns%rowtype;
  v_clone_id uuid;
  v_name text;
  v_organic boolean;
  v_paid boolean;
begin
  if auth.role() <> 'service_role' and not public.is_admin() then
    raise exception 'Only an admin can clone campaigns.';
  end if;
  if p_target_mode is null or p_target_mode not in ('organic', 'paid', 'both') then
    raise exception 'Choose organic, paid, or both.';
  end if;
  v_organic := p_target_mode in ('organic', 'both');
  v_paid := p_target_mode in ('paid', 'both');
  if v_paid and coalesce(p_paid_platform, '') not in ('meta', 'google') then
    raise exception 'A paid route needs Meta or Google.';
  end if;
  if not v_paid and p_paid_platform is not null then
    raise exception 'An organic-only campaign has no paid platform.';
  end if;

  select * into v_source from public.client_campaigns
    where id = p_source_campaign_id;
  if not found then raise exception 'Source campaign not found.'; end if;
  -- 203 refused a clone into the same mode to keep distribution and results
  -- independent. That reasoning applied when one campaign could hold only one
  -- route; a campaign that runs both is now a legitimate destination, so the
  -- refusal narrows to an exact duplicate of the source's own routes.
  if v_source.acquisition_mode <> 'legacy'
     and v_source.runs_organic = v_organic and v_source.runs_paid = v_paid then
    raise exception 'That campaign already runs exactly these routes. Clone into a different combination.';
  end if;
  v_name := coalesce(nullif(btrim(p_name), ''), v_source.name || ' · ' || initcap(p_target_mode));
  if length(v_name) > 200 then raise exception 'Campaign name is too long.'; end if;

  insert into public.client_campaigns (
    client_id, name, brief, acquisition_mode, paid_platform,
    runs_organic, runs_paid, cloned_from_campaign_id, ideate_on_plan,
    offer_version_id
  ) values (
    v_source.client_id, v_name, v_source.brief, p_target_mode, p_paid_platform,
    v_organic, v_paid, v_source.id, v_source.ideate_on_plan,
    v_source.offer_version_id
  ) returning id into v_clone_id;
  return v_clone_id;
end;
$$;

comment on function public.clone_campaign_for_route(uuid, text, text, text) is
  'Creates an unplanned campaign running organic, paid, or both from the source brief and offer. No ideas, assets, approvals, external IDs or results are copied.';

revoke execute on function public.clone_campaign_for_route(uuid, text, text, text)
  from public, anon;
grant execute on function public.clone_campaign_for_route(uuid, text, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Creating a both-route campaign from an opportunity
-- ---------------------------------------------------------------------------

-- 232's creator refuses anything but organic or paid, so the route Alex asked
-- for would have been unreachable from the place campaigns are actually meant
-- to start. Only the route handling changes here: the opportunity status gate,
-- the fresh readiness read, the per-route deduplication, the offer-version
-- lookup and both link writes are preserved exactly.
create or replace function public.create_campaign_from_opportunity_v6(
  p_opportunity_id uuid,
  p_acquisition_mode text,
  p_paid_platform text default null,
  p_name text default null
) returns public.client_campaigns
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_opportunity public.market_opportunities%rowtype;
  v_readiness record;
  v_offer_version uuid;
  v_existing public.client_campaigns%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_organic boolean;
  v_paid boolean;
begin
  select * into v_opportunity from public.market_opportunities where id = p_opportunity_id;
  if not found then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.can_shape_opportunity(v_opportunity.client_id) then
    raise exception 'Only an admin or assigned client manager can create a campaign from an opportunity.'
      using errcode = 'P0001';
  end if;

  if p_acquisition_mode not in ('organic', 'paid', 'both') then
    raise exception 'Choose an organic, paid, or both route.' using errcode = 'P0001';
  end if;
  v_organic := p_acquisition_mode in ('organic', 'both');
  v_paid := p_acquisition_mode in ('paid', 'both');
  if v_paid and coalesce(p_paid_platform, '') not in ('meta', 'google') then
    raise exception 'Choose Meta Ads or Google Ads for a paid campaign.' using errcode = 'P0001';
  end if;

  -- Approved onwards. Everything before that is still being worked out, and
  -- a campaign against it is money spent on a maybe.
  if v_opportunity.status not in ('approved', 'active', 'learning', 'scaling') then
    raise exception 'This opportunity is %. Approve it before building a campaign on it.',
      v_opportunity.status using errcode = 'P0001';
  end if;

  -- Readiness read now, not trusted from whenever the approval happened.
  select * into v_readiness from public.opportunity_readiness
   where opportunity_id = p_opportunity_id;
  if v_readiness.blocker is not null then
    raise exception '%', v_readiness.blocker using errcode = 'P0001';
  end if;

  -- One campaign per opportunity per route combination. 'both' is its own
  -- combination, so it does not collide with an existing organic or paid one.
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
    client_id, name, brief, acquisition_mode, paid_platform,
    runs_organic, runs_paid, offer_version_id)
  values (
    v_opportunity.client_id,
    coalesce(nullif(btrim(coalesce(p_name, '')), ''), v_opportunity.name),
    public.opportunity_brief_v6(p_opportunity_id),
    p_acquisition_mode,
    case when v_paid then p_paid_platform end,
    v_organic, v_paid,
    v_offer_version)
  returning * into v_campaign;

  -- Both directions, unchanged: the link table is the relational record and
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

select lock_down_definer_functions();
