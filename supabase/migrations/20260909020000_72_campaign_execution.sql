-- Campaign Execution Builder: the tool that turns a strategy into a launched
-- campaign by invoking the other tools.
--
-- The `campaigns` table already here is an ad-platform tracker — target_role,
-- daily_spend, external_id. That is where money is recorded, not where a
-- campaign is planned, and conflating the two would mean a campaign could not
-- exist before somebody had opened an ad account. So the plan gets its own
-- table and links to the ad campaign when one exists.
--
-- The idea worth protecting here: **readiness is derived, never stored.** A
-- campaign that reports itself ready because somebody ticked a box is worth
-- less than no campaign at all, because it is trusted. Every requirement below
-- is computed from the real artifact — a page with HTML in it, a sales agent
-- that is built and live, content that exists — so "ready" cannot drift from
-- the truth and cannot be asserted by hand.

create table client_campaigns (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients (id) on delete cascade,
  name          text not null,
  brief         text not null,
  status        text not null default 'planning'
                  check (status in ('planning', 'live', 'complete', 'cancelled')),

  -- Written by the planning agent, not by a person.
  objective       text,
  audience        text,
  offer_summary   text,
  core_message    text,
  channels        text[] not null default '{}',
  budget          numeric,
  starts_on       date,
  ends_on         date,
  kpi_metric      text,
  kpi_target      numeric,

  -- What the plan says has to exist before this can run. These drive the
  -- readiness check, so a plan that asks for nothing is ready for nothing.
  content_count       integer not null default 0 check (content_count >= 0),
  needs_landing_page  boolean not null default false,
  needs_sales_agent   boolean not null default false,

  -- Where the money is recorded, once there is an ad account behind this.
  ad_campaign_id uuid references campaigns (id) on delete set null,

  built_at    timestamptz,
  launched_at timestamptz,
  job_id      uuid references agent_jobs (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index client_campaigns_client_idx on client_campaigns (client_id, created_at desc);

comment on table client_campaigns is
  'A campaign plan and its execution state. Distinct from `campaigns`, which is the ad-platform spend tracker — a campaign is planned here long before there is an ad account behind it.';
comment on column client_campaigns.brief is
  'The operator''s ask. The only free text a person writes; the plan is generated from it plus the client''s intelligence.';
comment on column client_campaigns.status is
  'planning, live, complete or cancelled. Deliberately has no "ready" value — readiness is derived from the artifacts by campaign_readiness(), so it cannot be set by hand.';
comment on column client_campaigns.content_count is
  'How many pieces of content the plan calls for. Readiness counts what actually exists against this.';

-- What this campaign is made of.
--
-- One row per real artifact, with a real foreign key rather than a
-- (table_name, id) pair, so a deleted page cannot leave a campaign pointing at
-- nothing while still reporting itself ready.
create table campaign_artifacts (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references client_campaigns (id) on delete cascade,
  client_id      uuid not null references clients (id) on delete cascade,
  kind           text not null check (kind in ('content', 'landing_page', 'sales_agent', 'post')),

  brief_id       uuid references client_briefs (id) on delete cascade,
  asset_id       uuid references client_media_assets (id) on delete cascade,
  page_id        uuid references client_pages (id) on delete cascade,
  sales_agent_id uuid references client_sales_agents (id) on delete cascade,
  post_id        uuid references scheduled_posts (id) on delete cascade,

  created_at     timestamptz not null default now(),

  -- Exactly one target. A row pointing at two things, or at none, is a row
  -- nobody can act on.
  constraint campaign_artifacts_one_target
    check (num_nonnulls(brief_id, asset_id, page_id, sales_agent_id, post_id) = 1)
);

create index campaign_artifacts_campaign_idx on campaign_artifacts (campaign_id, kind);
create unique index campaign_artifacts_page_uniq on campaign_artifacts (campaign_id, page_id)
  where page_id is not null;
create unique index campaign_artifacts_agent_uniq on campaign_artifacts (campaign_id, sales_agent_id)
  where sales_agent_id is not null;
create unique index campaign_artifacts_brief_uniq on campaign_artifacts (campaign_id, brief_id)
  where brief_id is not null;

comment on table campaign_artifacts is
  'The real rows a campaign is made of, one per artifact with a real foreign key — so a deleted page cannot leave a campaign reporting itself ready.';

-- Is this campaign actually ready, and if not, what is missing?
--
-- Every row is computed from the artifact itself. "Have" counts what exists in
-- a usable state, not what has been requested: a page with no HTML has not
-- been built, and a sales agent that is built but still a draft is not
-- answering anyone, so neither counts.
create or replace function campaign_readiness(p_campaign_id uuid)
returns table (
  requirement text,
  required    integer,
  have        integer,
  met         boolean,
  detail      text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  c client_campaigns%rowtype;
begin
  select * into c from client_campaigns where client_campaigns.id = p_campaign_id;
  if c.id is null then
    raise exception 'That campaign no longer exists.';
  end if;
  if not (auth.role() = 'service_role' or can_access_client(c.client_id)) then
    raise exception 'Not permitted for this client';
  end if;

  -- The plan itself. Nothing else can be judged until this exists, because
  -- every requirement below is a number the plan supplied.
  return query
  select 'Plan'::text,
         1,
         (c.built_at is not null)::integer,
         c.built_at is not null,
         case when c.built_at is not null then 'Written by the planner.'
              else 'The planner has not written this campaign yet.' end;

  -- Content: a brief counts once it has actually been written, and an asset
  -- counts once it has been approved. A queued brief is an intention.
  if c.content_count > 0 then
    return query
    with have as (
      select count(*)::integer n
        from campaign_artifacts a
        left join client_briefs b on b.id = a.brief_id
        left join client_media_assets m on m.id = a.asset_id
       where a.campaign_id = c.id
         and a.kind = 'content'
         and (b.body is not null or m.review_status = 'approved')
    )
    select 'Content'::text, c.content_count, h.n, h.n >= c.content_count,
           format('%s of %s pieces written or approved.', h.n, c.content_count)
      from have h;
  end if;

  -- A landing page counts when it has HTML. A page row with a brief on it is
  -- a request, not a page.
  if c.needs_landing_page then
    return query
    with have as (
      select count(*)::integer n
        from campaign_artifacts a
        join client_pages p on p.id = a.page_id
       where a.campaign_id = c.id and p.html is not null
    )
    select 'Landing page'::text, 1, h.n, h.n >= 1,
           case when h.n >= 1 then 'Built.'
                else 'No page with any HTML in it is attached to this campaign.' end
      from have h;
  end if;

  -- A sales agent counts when it is built AND live. Built but draft is the
  -- state that would otherwise launch a campaign pointing at an agent nobody
  -- turned on.
  if c.needs_sales_agent then
    return query
    with have as (
      select count(*)::integer n
        from campaign_artifacts a
        join client_sales_agents s on s.id = a.sales_agent_id
       where a.campaign_id = c.id and s.built_at is not null and s.status = 'live'
    )
    select 'Sales agent'::text, 1, h.n, h.n >= 1,
           case when h.n >= 1 then 'Built and live.'
                else 'No built, live sales agent is attached. A draft agent answers nobody.' end
      from have h;
  end if;
end;
$$;

revoke execute on function campaign_readiness(uuid) from public, anon;
grant  execute on function campaign_readiness(uuid) to authenticated, service_role;

comment on function campaign_readiness(uuid) is
  'Every requirement computed from the real artifact. A page counts when it has HTML; a sales agent counts when it is built and live. Readiness is never stored, so it cannot drift from the truth.';

-- Create the things this campaign needs, and remember that it created them.
--
-- This is the orchestration the tool exists for: one call turns a plan into
-- real rows in tools 2 and 3, with their agents queued. Idempotent — it will
-- not create a second page for a campaign that already has one, because the
-- common way to break this is to press the button twice.
create or replace function provision_campaign(p_campaign_id uuid)
returns table (created text, artifact_id uuid)
language plpgsql
security definer
set search_path to 'public'
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

revoke execute on function provision_campaign(uuid) from public, anon;
grant  execute on function provision_campaign(uuid) to authenticated, service_role;

comment on function provision_campaign(uuid) is
  'Turns a plan into real rows in tools 2 and 3 with their agents queued, recording each as a campaign artifact. Idempotent: pressing it twice creates nothing twice.';

-- Launch, but only if it is genuinely ready.
--
-- The refusal names the specific requirement that is missing, because "not
-- ready" tells whoever pressed the button nothing they can act on.
create or replace function launch_campaign(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c       client_campaigns%rowtype;
  missing text;
begin
  select * into c from client_campaigns where client_campaigns.id = p_campaign_id;
  if c.id is null then
    raise exception 'That campaign no longer exists.';
  end if;
  if not (auth.role() = 'service_role' or can_access_client(c.client_id)) then
    raise exception 'Not permitted for this client';
  end if;
  if c.status = 'live' then
    return;  -- Already live. Launching twice is not an error, it is a no-op.
  end if;

  select r.detail into missing
    from campaign_readiness(p_campaign_id) r
   where not r.met
   order by r.requirement
   limit 1;

  if missing is not null then
    raise exception 'Not ready to launch: %', missing;
  end if;

  update client_campaigns
     set status = 'live', launched_at = now(), updated_at = now()
   where client_campaigns.id = p_campaign_id;
end;
$$;

revoke execute on function launch_campaign(uuid) from public, anon;
grant  execute on function launch_campaign(uuid) to authenticated, service_role;

comment on function launch_campaign(uuid) is
  'Marks a campaign live only when every derived requirement is met, and names the specific missing one when it refuses.';

alter table client_campaigns enable row level security;
alter table campaign_artifacts enable row level security;

create policy cc_admin_all on client_campaigns
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cc_client_read on client_campaigns
  for select to authenticated using (is_client_user(client_id));

create policy cart_admin_all on campaign_artifacts
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cart_client_read on campaign_artifacts
  for select to authenticated using (is_client_user(client_id));

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values ('campaign_plan', 'Campaign Planner', 'CP', 'conversion',
        'Turns a campaign brief into an executable plan: objective, audience, message, channels, budget, dates, KPIs and what has to be built.',
        '{offer_strategy,icp}', true)
on conflict (agent_key) do nothing;
