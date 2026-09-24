-- The paid path's last mile: what a build needs, and the one way to start it.
--
-- Everything that turns an approved asset into a paused Meta ad already
-- existed in agent-runtime/src/meta — payloads, transport, the idempotent
-- build plan — and nothing called it. The audit of 22 September found the
-- paid half of the product complete in code and never run once. This adds
-- the inputs an ad set cannot be built without, and the job that runs it.
--
-- Nothing here can make anything live. The runtime creates campaigns, ad
-- sets and ads PAUSED and has no code path that sets ACTIVE; launching stays
-- a person in Ads Manager.

-- The Facebook page an ad runs from, and the pixel a conversion goal counts
-- against. Both belong to the ad account rather than to one campaign, so they
-- live on the Meta integration. Numeric strings, because they are Meta's ids.
--
-- Currency is deliberately not stored. The budget is sent in the account's
-- own currency, and the runtime reads that from Meta at build time: a stored
-- copy that drifted from the account would send a budget a hundred times too
-- large, which is the one mistake here that costs real money.
alter table client_integrations
  add column meta_page_id  text
    constraint client_integrations_meta_page_shape
      check (meta_page_id is null or meta_page_id ~ '^[0-9]+$'),
  add column meta_pixel_id text
    constraint client_integrations_meta_pixel_shape
      check (meta_pixel_id is null or meta_pixel_id ~ '^[0-9]+$');

comment on column client_integrations.meta_page_id is
  'Meta only: the Facebook page ads run from. Every ad creative needs one.';
comment on column client_integrations.meta_pixel_id is
  'Meta only: the pixel conversion and landing-page-view goals count against.';

-- budget is the campaign total and has always been prose-adjacent planning
-- data. An ad set spends per day, so the build needs that number on its own,
-- chosen by a person rather than divided out of a total by the runtime.
alter table client_campaigns
  add column daily_budget numeric
    constraint client_campaigns_daily_budget_positive
      check (daily_budget is null or daily_budget > 0),
  add column target_countries text[] not null default '{}'
    constraint client_campaigns_target_countries_shape
      check (array_to_string(target_countries, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'),
  add column conversion_event text
    constraint client_campaigns_conversion_event_known
      check (conversion_event is null or conversion_event in (
        'LEAD', 'PURCHASE', 'COMPLETE_REGISTRATION', 'CONTACT', 'SCHEDULE',
        'SUBMIT_APPLICATION', 'INITIATED_CHECKOUT', 'ADD_TO_CART', 'SUBSCRIBE',
        'START_TRIAL', 'CONTENT_VIEW'
      ));

comment on column client_campaigns.daily_budget is
  'What the ad set may spend per day, in the ad account''s currency. Required to build in Meta.';
comment on column client_campaigns.target_countries is
  'ISO 3166 two-letter country codes the ad set runs in. Required to build in Meta.';
comment on column client_campaigns.conversion_event is
  'The pixel event an OFFSITE_CONVERSIONS goal counts. Only read when the goal needs one.';

-- The runner. requires_input keeps it out of "Run all agents": a master run
-- has no campaign to hand it, and building ads is never a side effect.
insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values
  ('meta_build', 'Meta Builder', 'MB', 'conversion',
   'Builds a campaign''s approved assets into a paused Meta campaign, ad set and ads. Creates nothing live; launching is done in Ads Manager.',
   '{}', true)
on conflict (agent_key) do nothing;

-- The one way the console starts a build.
--
-- The build is idempotent against itself run twice in a row — every Meta id
-- is written back the moment it comes back — but not against itself run twice
-- at once: two runners reading the same empty meta_campaign_id would both
-- create a campaign. So a second request while one is queued or running is
-- refused, under a lock on the campaign row so two presses cannot both pass
-- the check.
create or replace function request_meta_build(p_campaign_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c     client_campaigns%rowtype;
  v_job uuid;
begin
  select * into c from client_campaigns where id = p_campaign_id for update;
  if c.id is null then
    raise exception 'That campaign no longer exists.';
  end if;
  if not (auth.role() = 'service_role' or can_access_client(c.client_id)) then
    raise exception 'Not permitted for this client';
  end if;

  if exists (
    select 1 from agent_jobs j
     where j.agent_key = 'meta_build'
       and j.input_table = 'client_campaigns'
       and j.input_id = c.id
       and j.status in ('queued', 'claimed', 'running')
  ) then
    raise exception 'A Meta build for this campaign is already queued or running.';
  end if;

  v_job := enqueue_agent_job_internal(
    'meta_build', c.client_id, 'client_campaigns', c.id, auth.uid(),
    '{}'::jsonb, 'Queued: build in Meta, paused'
  );
  return v_job;
end;
$$;

revoke execute on function request_meta_build(uuid) from public, anon;
grant  execute on function request_meta_build(uuid) to authenticated, service_role;

comment on function request_meta_build(uuid) is
  'Queues a paused Meta build for one campaign. Refuses while another build of the same campaign is queued or running.';
