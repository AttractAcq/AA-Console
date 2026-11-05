-- v6.1 / 2.7: a plan is reviewed before the agents run.
--
-- The notes ask for a "plan review gate -- correctable in the Inbox or in the
-- campaign, before the agent runs".
--
-- WHAT "BEFORE THE AGENT RUNS" MEANS HERE
--
-- provision_campaign is the moment. It refuses only when there is no plan at
-- all, and then it writes a landing page row, writes a sales agent row, and
-- enqueues the landing_page and sales_agent jobs. That is the agents running.
--
-- And the plan it runs from was approved by nobody: save_campaign_plan_only and
-- save_campaign_plan_with_ideas set built_at themselves, so the planner marks
-- its own work approved. The prompt even calls a built_at row an "EXISTING
-- APPROVED CAMPAIGN PLAN". Nothing stands between a model's plan and the work
-- it causes.
--
-- AN APPROVAL HAS TO NAME THE PLAN IT APPROVED
--
-- A flag would not be a gate. Approve a plan, then correct it -- which is
-- exactly what the notes ask to be possible -- and a bare plan_approved_at
-- would still be set, so the corrected plan would provision on the strength of
-- a decision made about different text.
--
-- So the approval records a fingerprint of the planned fields, and
-- provision_campaign refuses when the current fingerprint differs. Correcting a
-- plan therefore un-approves it, which is the behaviour the notes describe:
-- correctable before the agents run, and re-reviewed if corrected.
--
-- This is the same idea the rest of the system already uses -- an offer
-- approval names the hash of the bytes, the approval spine carries an
-- artifact_hash -- applied to a plan.
--
-- md5 over a jsonb object is stable: Postgres normalises jsonb key order, so
-- the same plan hashes the same way regardless of how it was written.

alter table public.client_campaigns
  add column if not exists plan_approved_at timestamptz,
  add column if not exists plan_approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists plan_approved_fingerprint text,
  add column if not exists plan_review_note text;

comment on column public.client_campaigns.plan_approved_at is
  'When a person approved this plan for building. Null means the planner has written a plan that nobody has reviewed, which provision_campaign refuses.';
comment on column public.client_campaigns.plan_approved_fingerprint is
  'The fingerprint of the plan that was approved. provision_campaign refuses when the current plan no longer matches, so correcting a plan un-approves it.';

alter table public.client_campaigns
  drop constraint if exists client_campaigns_plan_approval_check;
alter table public.client_campaigns
  add constraint client_campaigns_plan_approval_check check (
    -- All three move together. An approval with no fingerprint could not be
    -- checked against the plan, and a fingerprint with no approval is a hash
    -- of nothing anybody decided.
    (plan_approved_at is null
       and plan_approved_by is null
       and plan_approved_fingerprint is null)
    or (plan_approved_at is not null
       and plan_approved_fingerprint is not null)
  );

-- The planned fields, and only those. Deliberately excludes ad_campaign_id,
-- launched_at, status and the meta_* columns: those change as a campaign runs,
-- and a plan should not need re-approving because something downstream of it
-- moved.
create or replace function public.campaign_plan_fingerprint(
  p_campaign public.client_campaigns
) returns text
language sql immutable
set search_path = pg_catalog, public
as $$
  select md5(jsonb_build_object(
    'objective', p_campaign.objective,
    'audience', p_campaign.audience,
    'offer_summary', p_campaign.offer_summary,
    'core_message', p_campaign.core_message,
    'channels', to_jsonb(coalesce(p_campaign.channels, array[]::text[])),
    'budget', p_campaign.budget,
    'starts_on', p_campaign.starts_on,
    'ends_on', p_campaign.ends_on,
    'kpi_metric', p_campaign.kpi_metric,
    'kpi_target', p_campaign.kpi_target,
    'content_count', p_campaign.content_count,
    'organic_content_count', p_campaign.organic_content_count,
    'paid_content_count', p_campaign.paid_content_count,
    'needs_landing_page', p_campaign.needs_landing_page,
    'needs_sales_agent', p_campaign.needs_sales_agent,
    'offer_version_id', p_campaign.offer_version_id
  )::text)
$$;

comment on function public.campaign_plan_fingerprint(public.client_campaigns) is
  'A stable hash of the planned fields, so an approval can name the plan it approved. Excludes anything that moves while a campaign runs.';

create or replace function public.approve_campaign_plan_v6(
  p_campaign_id uuid,
  p_note text default null
) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  c public.client_campaigns%rowtype;
  v_fingerprint text;
begin
  select * into c from public.client_campaigns where id = p_campaign_id;
  if c.id is null then
    raise exception 'That campaign no longer exists.' using errcode = 'P0001';
  end if;
  -- Approving a plan releases real work: pages written, agents built, content
  -- briefed. It takes the standing the rest of a campaign's shape needs, and
  -- deliberately no service_role branch -- the whole point is that a machine
  -- does not approve its own plan.
  if auth.role() is distinct from 'authenticated'
     or not public.can_access_client(c.client_id) then
    raise exception 'Only a person with access to this client can approve its plan.'
      using errcode = 'P0001';
  end if;
  if c.built_at is null then
    raise exception 'This campaign has no plan yet. There is nothing to approve.'
      using errcode = 'P0001';
  end if;

  v_fingerprint := public.campaign_plan_fingerprint(c);
  if c.plan_approved_at is not null and c.plan_approved_fingerprint = v_fingerprint then
    raise exception 'This exact plan is already approved.' using errcode = 'P0001';
  end if;

  update public.client_campaigns
     set plan_approved_at = now(),
         plan_approved_by = auth.uid(),
         plan_approved_fingerprint = v_fingerprint,
         plan_review_note = nullif(btrim(p_note), ''),
         updated_at = now()
   where id = p_campaign_id;
end $$;

comment on function public.approve_campaign_plan_v6(uuid, text) is
  'Approves a campaign plan for building, recording which plan was approved. No service_role branch: a machine does not approve its own plan.';

revoke all on function public.approve_campaign_plan_v6(uuid, text) from public, anon, service_role;
grant execute on function public.approve_campaign_plan_v6(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The gate itself
-- ---------------------------------------------------------------------------
--
-- provision_campaign reproduced with two refusals added and nothing else
-- changed. Reproduced in full rather than patched because that is how this
-- repository defines a function, and a reader of this migration should see
-- exactly what runs rather than a diff against something they have to go and
-- find.

create or replace function public.provision_campaign(p_campaign_id uuid)
returns table (created text, artifact_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  c        client_campaigns%rowtype;
  v_page   uuid;
  v_agent  uuid;
begin
  select * into c from client_campaigns where client_campaigns.id = p_campaign_id;
  if c.id is null then
    raise exception 'That campaign no longer exists.';
  end if;
  if not (auth.role() = 'service_role' or can_access_client(c.client_id)) then
    raise exception 'Not permitted for this client';
  end if;
  if c.built_at is null then
    raise exception 'This campaign has no plan yet. There is nothing to build from.';
  end if;

  -- THE PLAN REVIEW GATE (migration 309).
  if c.plan_approved_at is null then
    raise exception 'This plan has not been reviewed. Approve it before the agents build from it.'
      using errcode = 'P0001';
  end if;
  -- An approval names the plan it approved, so a plan corrected after approval
  -- is not approved. This is the half that makes the gate a gate rather than a
  -- flag somebody set once.
  if c.plan_approved_fingerprint is distinct from campaign_plan_fingerprint(c) then
    raise exception 'This plan changed after it was approved. Review the change and approve it again.'
      using errcode = 'P0001';
  end if;

  if c.needs_landing_page
     and not exists (select 1 from campaign_artifacts a
                      where a.campaign_id = c.id and a.page_id is not null) then
    insert into client_pages (client_id, page_type, title, brief, status)
    values (c.client_id, 'landing', c.name || ' — landing page',
            concat_ws(E'\n\n',
              'Built for the campaign "' || c.name || '".',
              nullif(c.objective, ''),
              nullif(c.offer_summary, ''),
              nullif(c.core_message, ''),
              nullif(c.audience, '')),
            'draft')
    returning client_pages.id into v_page;

    insert into campaign_artifacts (campaign_id, client_id, kind, page_id)
    values (c.id, c.client_id, 'landing_page', v_page);

    perform enqueue_agent_job_internal('landing_page', c.client_id, 'client_pages', v_page, auth.uid());
    created := 'landing_page'; artifact_id := v_page; return next;
  end if;

  if c.needs_sales_agent
     and not exists (select 1 from campaign_artifacts a
                      where a.campaign_id = c.id and a.sales_agent_id is not null) then
    insert into client_sales_agents (client_id, page_id, name, purpose)
    values (c.client_id, v_page, c.name || ' — sales agent',
            concat_ws(E'\n\n',
              'Built for the campaign "' || c.name || '".',
              nullif(c.objective, ''),
              nullif(c.audience, ''),
              nullif(c.offer_summary, '')))
    returning client_sales_agents.id into v_agent;

    insert into campaign_artifacts (campaign_id, client_id, kind, sales_agent_id)
    values (c.id, c.client_id, 'sales_agent', v_agent);

    perform enqueue_agent_job_internal('sales_agent', c.client_id, 'client_sales_agents', v_agent, auth.uid());
    created := 'sales_agent'; artifact_id := v_agent; return next;
  end if;

  update client_campaigns set updated_at = now() where client_campaigns.id = c.id;
  return;
end;
$$;

comment on function public.provision_campaign(uuid) is
  'Creates the artifacts a plan requires and queues their agents. Refuses an unreviewed plan, and refuses one that changed after it was approved.';

select lock_down_definer_functions();
