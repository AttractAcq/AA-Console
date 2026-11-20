-- A coordinated campaign is reported fully live only when both routes have
-- recorded activity. This view does not verify provider receipts or read-back.
-- A single observed route is partial, and missing provider coverage stays unknown.

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

  -- This legacy live flag is based on recorded post and spend rows per route.
  -- It is not proof of provider read-back, and an approval alone never sets it.
  case
    when c.acquisition_mode = 'organic' then ev.posts_published > 0
    when c.acquisition_mode = 'paid' then ev.spending_days > 0
    when c.acquisition_mode = 'both' then
      ev.posts_published > 0 and ev.spending_days > 0
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
    when c.acquisition_mode = 'both' and not ev.spend_bindable
      then 'Organic posts: ' || ev.posts_published::text ||
        '. Paid account binding is missing, so paid live state is unknown. Bind and verify the paid route.'
    when c.acquisition_mode = 'both' and ev.posts_published > 0 and ev.spending_days > 0
      then 'Both routes have recorded activity: ' || ev.posts_published::text ||
        ' post(s) marked published and spend recorded on ' || ev.spending_days::text || ' day(s). Provider read-back is separate.'
    when c.acquisition_mode = 'both' and ev.posts_published > 0
      then 'Partially live: organic posts are recorded. No paid spending day is recorded; verify paid account coverage and activation.'
    when c.acquisition_mode = 'both' and ev.spending_days > 0
      then 'Partially live: paid spend is recorded. No organic post is recorded; inspect publish_due.'
    when c.acquisition_mode = 'both'
      then 'Neither route has recorded external activity. Check organic publication and paid account coverage.'
    when c.acquisition_mode = 'paid' and not ev.spend_bindable
      then 'Everything approved, and no external campaign id is bound, so whether it is spending cannot be known from here. Bind the id.'
    when c.acquisition_mode = 'paid' and ev.spending_days > 0
      then 'Live: spend on ' || ev.spending_days::text || ' day(s)'
           || case when ev.leads_attributed > 0
                   then ' and ' || ev.leads_attributed::text || ' lead(s) attributed.' else '.' end
    when c.acquisition_mode = 'paid'
      then 'No paid spending day is recorded. Verify account coverage and activation before calling this route live.'
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
                       when c.acquisition_mode = 'both' then
                         ev.posts_published > 0 and ev.spending_days > 0
                       else false end)
      then 'This campaign is marked live without recorded activity for every required route. That status came from an internal checklist; verify publication and provider accounts.'
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
