-- G08: is this campaign actually live.
--
-- `campaign_launch` has sat in the executor registry since 230 with the note
-- "a launch is every other action having happened, not an action of its own".
-- That is true, and it left nobody able to answer the question. A campaign
-- reads `active`, its Meta objects exist, its page is published -- and none
-- of that is evidence that money is moving or that anybody has seen it.
--
-- The confusion worth killing is between two different facts:
--
--   we did our part   every external action the route needs was approved
--                     and executed
--   it is live        something outside the building actually happened
--
-- A campaign can be the first without being the second for a fortnight,
-- because the last step of every paid route is a person switching ads on in
-- Ads Manager and no code path here can do it or see it directly.
--
-- SO THE GATE IS TWO VIEWS AND A SENTENCE
--
-- `campaign_launch_readiness` reads the manifest -- the campaign's own
-- statement of which deliverables need an external action -- and says which
-- of those have an approval that actually executed. That is our part.
--
-- `campaign_live_evidence` counts what was observed outside: published
-- posts, recorded spend, a published and probed page, leads carrying this
-- campaign as their source. That is the world's part.
--
-- `campaign_launch_due` puts the two together in one sentence.
--
-- WHY "NO SPEND OBSERVED" IS NOT ONE ANSWER
--
-- Spend reaches us through `metrics_daily`, which joins the older
-- `campaigns` spend tracker rather than the operational campaign. The bridge
-- is `client_campaigns.ad_campaign_id`, or the external id matching
-- `meta_campaign_id`. If neither is bound then there is no path from this
-- campaign to any spend row, and the honest report is that we cannot know --
-- which is a different problem from a campaign that is bound and spending
-- nothing. Those two get different sentences, because one is fixed by
-- binding an id and the other by looking at Ads Manager.
--
-- THE LEGACY `live` STATUS IS THE REASON THIS IS NEEDED
--
-- `launch_campaign` from migration 72 sets status to 'live' and stamps
-- `launched_at` once `campaign_readiness` is satisfied. Every requirement it
-- checks is internal. So a campaign can read 'live' with no post published,
-- no spend recorded and no external object bound -- which is the exact
-- confusion the v6 plan warned about when it said campaign `live` is not
-- proof of live spend or a tested conversion path.
--
-- That status is not changed here. Other things read it and rewriting what
-- it means would be a migration pretending to be a bug fix. Instead
-- `status_claims_live` surfaces the disagreement, and the warning says which
-- of the two to believe.
--
-- CAMPAIGN_LAUNCH STAYS UNSUPPORTED, DELIBERATELY
--
-- It is not promoted to a supported action. Nothing executes a launch, and
-- marking it supported would put a button in front of a person that cannot
-- do what its name says. Its registry note now names the view that answers
-- the question instead.

update public.campaign_action_executors
   set note = 'A launch is every other action having happened, not an action of its own, and the last step of a paid route is a person in Ads Manager. `campaign_launch_due` answers whether a campaign is live, separating the actions we executed from the evidence observed outside. Nothing executes a launch.'
 where action_key = 'campaign_launch';

-- Dropped in reverse dependency order before being created. `create or
-- replace view` cannot insert a column into the middle of an existing view's
-- column list, so a migration that is ever re-applied -- to staging, or in a
-- rehearsal -- fails on the second run without this. On a first apply the
-- drops are no-ops.
drop view if exists campaign_launch_due;
drop view if exists campaign_live_evidence;
drop view if exists campaign_launch_readiness;
drop view if exists campaign_route_actions;

-- ---------------------------------------------------------------------------
-- Which external actions this campaign's route needs
-- ---------------------------------------------------------------------------

-- Read from the manifest rather than re-derived from mode and platform: the
-- manifest is the campaign's own statement of what it needs, and deriving it
-- again here would be a second opinion that could disagree with the thing
-- readiness is actually judged against.
create or replace view campaign_route_actions with (security_invoker = true) as
select
  m.campaign_id,
  m.client_id,
  m.id as manifest_id,
  m.version as manifest_version,
  m.acquisition_mode,
  m.paid_platform,
  i.item_key,
  i.module_key,
  i.required,
  case i.item_key
    when 'website' then 'page_deploy'
    when 'proof_distribution' then 'proof_publish'
    when 'distribution' then
      case
        when m.acquisition_mode = 'organic' then 'organic_publish'
        when m.paid_platform = 'meta' then 'meta_ad_build'
        when m.paid_platform = 'google' then 'google_ad_build'
        else null
      end
    else null
  end as action_key
from public.campaign_manifest_versions m
join public.campaign_manifest_items i on i.manifest_id = m.id
where i.external_activation
  -- The current manifest only. An older version's requirements are history.
  and not exists (
    select 1 from public.campaign_manifest_versions later
     where later.campaign_id = m.campaign_id and later.version > m.version);

comment on view campaign_route_actions is
  'The external actions the current manifest requires of a campaign, one row per externally-activated deliverable, with the action key that satisfies it. Organic routes resolve distribution to organic_publish, which executes through the publish sweep rather than the campaign executor.';

grant select on campaign_route_actions to authenticated;

-- ---------------------------------------------------------------------------
-- Our part: approved, and executed
-- ---------------------------------------------------------------------------

create or replace view campaign_launch_readiness with (security_invoker = true) as
select
  r.campaign_id,
  r.client_id,
  r.manifest_id,
  r.manifest_version,
  r.acquisition_mode,
  r.paid_platform,
  r.item_key,
  r.action_key,
  r.required,
  e.supported as action_supported,
  a.id as approval_id,
  a.status as approval_status,
  x.status as execution_status,
  x.executed_at,
  x.external_id,
  x.attempts,
  x.last_error,
  case
    when r.action_key is null
      then 'This deliverable needs an external action that no route resolves to. Check the manifest.'
    when r.action_key = 'organic_publish'
      then 'Organic distribution executes through the publish sweep, not this gate. Read publish_due.'
    when e.supported is not true
      then 'No adapter performs ' || r.action_key || '. ' || coalesce(e.note, '')
    when a.id is null then 'Nobody has asked for ' || r.action_key || ' yet.'
    when a.status = 'rejected'
      then 'The ' || r.action_key || ' request was rejected' ||
           coalesce(': ' || a.rejection_reason, '') || '.'
    when a.status <> 'approved'
      then 'The ' || r.action_key || ' request is ' || a.status || '.'
    when x.id is null then 'Approved. It runs on the next sweep.'
    when x.status = 'failed'
      then 'The ' || r.action_key || ' execution failed: ' ||
           coalesce(x.last_error, 'no error recorded') || '.'
    when x.status = 'abandoned'
      then 'The ' || r.action_key || ' execution was abandoned after ' ||
           x.attempts::text || ' attempts.'
    when x.status = 'executed' then null
    else 'The ' || r.action_key || ' execution is ' || x.status || '.'
  end as blocker
from campaign_route_actions r
left join public.campaign_action_executors e on e.action_key = r.action_key
left join lateral (
  -- The newest decision for this action on this manifest. An older approval
  -- against a superseded package is not evidence about this one.
  select a2.* from public.campaign_action_approvals a2
   where a2.campaign_id = r.campaign_id
     and a2.action_key = r.action_key
     and a2.manifest_id = r.manifest_id
   order by a2.requested_at desc limit 1) a on true
left join public.campaign_action_executions x on x.approval_id = a.id;

comment on view campaign_launch_readiness is
  'Per externally-activated deliverable, whether our part is done: asked, approved, executed. A null blocker means this one action is complete. It says nothing about whether the campaign is live.';

grant select on campaign_launch_readiness to authenticated;

-- ---------------------------------------------------------------------------
-- The world's part: what was actually observed
-- ---------------------------------------------------------------------------

create or replace view campaign_live_evidence with (security_invoker = true) as
select
  c.id as campaign_id,
  c.client_id,
  c.acquisition_mode,
  c.paid_platform,
  c.ad_campaign_id,
  c.meta_campaign_id,

  -- Organic: a post that actually went out, reached through the asset's
  -- brief and the idea that carries the campaign.
  (select count(*) from public.scheduled_posts sp
     join public.client_media_assets ma on ma.id = sp.asset_id
     join public.client_briefs b on b.id = ma.brief_id
     join public.client_ideas i on i.id = b.source_idea_id
    where i.campaign_id = c.id and sp.published_at is not null) as posts_published,

  -- Paid: whether there is any path at all from this campaign to a spend row.
  (c.ad_campaign_id is not null or c.meta_campaign_id is not null) as spend_bindable,

  (select coalesce(sum(m.spend), 0) from public.metrics_daily m
    where m.client_id = c.client_id
      and ((c.ad_campaign_id is not null and m.campaign_id = c.ad_campaign_id)
        or (c.meta_campaign_id is not null and m.entity_type = 'campaign'
            and m.external_id = c.meta_campaign_id))) as spend_observed,

  (select count(distinct m.metric_date) from public.metrics_daily m
    where m.client_id = c.client_id
      and coalesce(m.spend, 0) > 0
      and ((c.ad_campaign_id is not null and m.campaign_id = c.ad_campaign_id)
        or (c.meta_campaign_id is not null and m.entity_type = 'campaign'
            and m.external_id = c.meta_campaign_id))) as spending_days,

  -- A page that is published and whose form was proved to work.
  (select count(*) from public.campaign_page_publications p
     join public.campaign_action_approvals pa on pa.id = p.approval_id
    where pa.campaign_id = c.id) as pages_published,
  (select count(*) from public.campaign_page_publications p
     join public.campaign_action_approvals pa on pa.id = p.approval_id
    where pa.campaign_id = c.id and p.probe_status = 'passed') as pages_probed,

  -- Proof actually placed somewhere a buyer could see it.
  (select count(*) from public.proof_placements pp
    where pp.campaign_id = c.id and pp.status in ('placed', 'verified')) as proof_placed,

  -- The only evidence that matters commercially: somebody arrived.
  (select count(*) from public.client_leads l
    where l.source_client_campaign_id = c.id and not l.is_probe) as leads_attributed
from public.client_campaigns c
where c.archived_at is null;

comment on view campaign_live_evidence is
  'What was observed outside the building for each campaign: posts that went out, spend recorded, pages published and probed, proof placed, leads attributed. Counts of facts, with no verdict attached.';

grant select on campaign_live_evidence to authenticated;

-- ---------------------------------------------------------------------------
-- The gate
-- ---------------------------------------------------------------------------

create or replace view campaign_launch_due with (security_invoker = true) as
select
  c.id as campaign_id,
  c.client_id,
  c.name,
  c.acquisition_mode,
  c.paid_platform,
  c.template,
  c.status,
  ready.required_actions,
  ready.actions_done,
  ready.first_blocker,
  ev.posts_published,
  ev.spend_bindable,
  ev.spend_observed,
  ev.spending_days,
  ev.pages_published,
  ev.pages_probed,
  ev.proof_placed,
  ev.leads_attributed,

  -- Live means something happened outside, per route. Organic is live when a
  -- post went out; paid is live when money moved. Neither is implied by an
  -- approval.
  case
    when c.acquisition_mode = 'organic' then ev.posts_published > 0
    when c.acquisition_mode = 'paid' then ev.spending_days > 0
    else false
  end as live,

  -- What the campaign row says about itself, which migration 72's
  -- launch_campaign sets from an internal checklist alone.
  (c.status = 'live') as status_claims_live,

  case
    -- Our part first: an unfinished action is the actionable answer.
    when ready.required_actions = 0
      then 'This campaign has no manifest, so there is nothing to launch. Package it first.'
    when ready.first_blocker is not null then ready.first_blocker
    when coalesce(ces.campaign_actions_enabled, false) is false
      then 'Every action is approved and external campaign actions are off for this client.'
    -- Then the world's part.
    when c.acquisition_mode = 'organic' and ev.posts_published > 0
      then 'Live: ' || ev.posts_published::text || ' post(s) published'
           || case when ev.leads_attributed > 0
                   then ' and ' || ev.leads_attributed::text || ' lead(s) attributed.' else '.' end
    when c.acquisition_mode = 'organic'
      then 'Everything approved. Nothing has published yet, so nothing is live. Read publish_due.'
    when c.acquisition_mode = 'paid' and not ev.spend_bindable
      then 'Everything approved, and no external campaign id is bound, so whether it is spending cannot be known from here. Bind the id.'
    when c.acquisition_mode = 'paid' and ev.spending_days > 0
      then 'Live: spend on ' || ev.spending_days::text || ' day(s)'
           || case when ev.leads_attributed > 0
                   then ' and ' || ev.leads_attributed::text || ' lead(s) attributed.' else '.' end
    when c.acquisition_mode = 'paid'
      then 'Everything approved and the objects exist, paused. No spend observed, so a person has not switched them on in Ads Manager.'
    else 'This campaign has no mode, so it has no route to launch.'
  end as verdict,

  -- Published without a passing probe is the quiet failure: a live page
  -- whose form reaches nobody looks identical to one that works.
  case
    -- The dangerous disagreement: the row says live and nothing outside
    -- agrees. `launch_campaign` only ever checked internal readiness, so the
    -- status is a claim and the evidence is not.
    when c.status = 'live'
         and not (case when c.acquisition_mode = 'organic' then ev.posts_published > 0
                       when c.acquisition_mode = 'paid' then ev.spending_days > 0
                       else false end)
      then 'This campaign is marked live and nothing has been observed outside. That status came from an internal checklist, not from evidence. Believe the evidence.'
    when ev.pages_published > ev.pages_probed
      then (ev.pages_published - ev.pages_probed)::text
           || ' published page(s) have no passing form probe.'
    else null
  end as warning
from public.client_campaigns c
left join campaign_live_evidence ev on ev.campaign_id = c.id
left join public.client_engine_settings ces on ces.client_id = c.client_id
left join lateral (
  select
    count(*)::int as required_actions,
    count(*) filter (where blocker is null)::int as actions_done,
    -- One blocker, in manifest order, so the answer is the next thing to do
    -- rather than a list to triage.
    (array_remove(array_agg(blocker order by item_key), null))[1] as first_blocker
  from campaign_launch_readiness lr
  where lr.campaign_id = c.id and lr.required
    -- organic_publish is not this gate's business; it has its own sweep.
    and coalesce(lr.action_key, '') <> 'organic_publish') ready on true
where c.archived_at is null;

comment on view campaign_launch_due is
  'The one place that answers whether a campaign is live, separating the external actions we executed from the evidence observed outside. `live` is a fact about the world: a published post for organic, recorded spend for paid. An approval is never evidence of either.';

grant select on campaign_launch_due to authenticated;
