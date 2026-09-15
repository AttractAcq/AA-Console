-- Building one thing a campaign needs, on purpose.
--
-- provision_campaign builds everything the plan asked for in one press. That is
-- the right shape for "make this campaign ready" and the wrong shape for a
-- person standing on the campaign page who wants a landing page now and has not
-- decided about a sales agent yet. "Build what it needs" cannot say what it is
-- about to do, and a button that will not say what it does is a button people
-- stop pressing.
--
-- So this builds exactly one named artifact, and says which one it built.
--
-- The sales agent is deliberately buildable even when the plan did not ask for
-- one. A planner's needs_sales_agent is its opinion at planning time; deciding
-- later that this campaign should have an agent is an ordinary thing to want,
-- and the alternative is re-planning the campaign, which would rewrite numbers
-- that readiness and provisioning have already acted on.

create or replace function provision_campaign_artifact(
  p_campaign_id uuid,
  p_kind        text
)
returns table (created text, artifact_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  c       client_campaigns%rowtype;
  v_page  uuid;
  v_agent uuid;
begin
  if p_kind not in ('landing_page', 'sales_agent') then
    raise exception 'Unknown thing to build: %', p_kind;
  end if;

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

  if p_kind = 'landing_page' then
    -- Already built, or already building. Returning the existing artifact
    -- rather than raising makes the button safe to press twice, which is what
    -- people do when an agent takes minutes and the page looks unchanged.
    select a.page_id into v_page
      from campaign_artifacts a
     where a.campaign_id = c.id and a.page_id is not null
     limit 1;
    if v_page is not null then
      created := 'already_exists'; artifact_id := v_page; return next; return;
    end if;

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

    -- A campaign that has a page now needs one, whatever the plan said. Without
    -- this, readiness would not count the page it just asked for.
    update client_campaigns
       set needs_landing_page = true, updated_at = now()
     where client_campaigns.id = c.id;

    perform enqueue_agent_job_internal('landing_page', c.client_id, 'client_pages', v_page, auth.uid());
    created := 'landing_page'; artifact_id := v_page; return next; return;
  end if;

  select a.sales_agent_id into v_agent
    from campaign_artifacts a
   where a.campaign_id = c.id and a.sales_agent_id is not null
   limit 1;
  if v_agent is not null then
    created := 'already_exists'; artifact_id := v_agent; return next; return;
  end if;

  -- Attached to the campaign's page when there is one. A sales agent with no
  -- page has nowhere to be deployed, but it is still worth building: the page
  -- may be built minutes later, and refusing here would force an ordering
  -- nobody asked for.
  select a.page_id into v_page
    from campaign_artifacts a
   where a.campaign_id = c.id and a.page_id is not null
   limit 1;

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

  update client_campaigns
     set needs_sales_agent = true, updated_at = now()
   where client_campaigns.id = c.id;

  perform enqueue_agent_job_internal('sales_agent', c.client_id, 'client_sales_agents', v_agent, auth.uid());
  created := 'sales_agent'; artifact_id := v_agent; return next;
end;
$$;

revoke execute on function provision_campaign_artifact(uuid, text) from public, anon;
grant execute on function provision_campaign_artifact(uuid, text) to authenticated, service_role;

comment on function provision_campaign_artifact(uuid, text) is
  'Builds one named artifact for a campaign — landing_page or sales_agent — and returns which one it built, or already_exists. Idempotent: a second press returns the existing artifact rather than creating a second one.';
