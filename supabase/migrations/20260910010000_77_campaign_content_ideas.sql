-- Campaign content production should start from campaign-specific ideas, then
-- flow through the normal idea -> brief -> production chain.

alter table client_campaigns
  add column if not exists content_ideas_generated_at timestamptz;

alter table client_ideas
  add column if not exists campaign_id uuid,
  add column if not exists campaign_position integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'client_campaigns_id_client_uniq'
  ) then
    alter table client_campaigns
      add constraint client_campaigns_id_client_uniq unique (id, client_id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'client_ideas_campaign_client_fkey'
  ) then
    alter table client_ideas
      add constraint client_ideas_campaign_client_fkey
      foreign key (campaign_id, client_id)
      references client_campaigns (id, client_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'client_ideas_campaign_position_pair'
  ) then
    alter table client_ideas
      add constraint client_ideas_campaign_position_pair
      check (
        (campaign_id is null and campaign_position is null)
        or (campaign_id is not null and campaign_position between 1 and 30)
      );
  end if;
end $$;

create unique index if not exists client_ideas_campaign_position_uniq
  on client_ideas (campaign_id, campaign_position)
  where campaign_id is not null;

create index if not exists client_ideas_campaign_idx
  on client_ideas (client_id, campaign_id, campaign_position)
  where campaign_id is not null;

create unique index if not exists campaign_artifacts_asset_uniq
  on campaign_artifacts (campaign_id, asset_id)
  where asset_id is not null;

comment on column client_campaigns.content_ideas_generated_at is
  'Set once the Campaign Planner has saved the exact campaign-specific idea batch. Used for idempotent retries.';
comment on column client_ideas.campaign_id is
  'When set, this idea belongs to a specific campaign plan and is produced from the campaign page.';
comment on column client_ideas.campaign_position is
  'One-based position in the campaign content batch. Unique per campaign so retries cannot duplicate ideas.';

create or replace function save_campaign_plan_with_ideas(
  p_campaign_id uuid,
  p_client_id uuid,
  p_job_id uuid,
  p_plan jsonb,
  p_ideas jsonb
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c client_campaigns%rowtype;
  expected integer;
  existing integer;
  idea jsonb;
  pos integer;
  v_title text;
  v_body text;
  v_media_type text;
  v_channel text;
  v_reason text;
  seen_titles text[] := '{}';
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the agent runtime may save a campaign plan with ideas.';
  end if;

  select * into c
    from client_campaigns
   where id = p_campaign_id
     and client_id = p_client_id
   for update;

  if c.id is null then
    raise exception 'That campaign no longer exists.';
  end if;

  if not exists (
    select 1
      from agent_jobs j
     where j.id = p_job_id
       and j.client_id = p_client_id
       and j.input_table = 'client_campaigns'
       and j.input_id = p_campaign_id
       and j.agent_key = 'campaign_plan'
  ) then
    raise exception 'Invalid campaign planning job.';
  end if;

  if c.content_ideas_generated_at is not null then
    select count(*)::integer into existing
      from client_ideas
     where campaign_id = c.id
       and client_id = c.client_id;
    return existing;
  end if;

  if c.built_at is null then
    expected := coalesce(floor((p_plan->>'content_count')::numeric), 0);
    if expected < 0 or expected > 30 then
      raise exception 'The campaign content count must be between 0 and 30.';
    end if;

    update client_campaigns
       set objective = nullif(btrim(p_plan->>'objective'), ''),
           audience = nullif(btrim(p_plan->>'audience'), ''),
           offer_summary = nullif(btrim(p_plan->>'offer_summary'), ''),
           core_message = nullif(btrim(p_plan->>'core_message'), ''),
           channels = coalesce(array(select jsonb_array_elements_text(p_plan->'channels')), '{}'),
           budget = case when p_plan ? 'budget' and p_plan->>'budget' <> '' then (p_plan->>'budget')::numeric else null end,
           starts_on = case when p_plan ? 'starts_on' and p_plan->>'starts_on' <> '' then (p_plan->>'starts_on')::date else null end,
           ends_on = case when p_plan ? 'ends_on' and p_plan->>'ends_on' <> '' then (p_plan->>'ends_on')::date else null end,
           kpi_metric = nullif(btrim(p_plan->>'kpi_metric'), ''),
           kpi_target = case when p_plan ? 'kpi_target' and p_plan->>'kpi_target' <> '' then (p_plan->>'kpi_target')::numeric else null end,
           content_count = expected,
           needs_landing_page = coalesce((p_plan->>'needs_landing_page')::boolean, false),
           needs_sales_agent = coalesce((p_plan->>'needs_sales_agent')::boolean, false),
           built_at = now(),
           job_id = p_job_id,
           updated_at = now()
     where id = c.id
     returning * into c;
  else
    expected := c.content_count;
  end if;

  if jsonb_typeof(p_ideas) is distinct from 'array' or jsonb_array_length(p_ideas) <> expected then
    raise exception 'The campaign needs exactly % distinct ideas.', expected;
  end if;

  for idea, pos in
    select value, ordinality::integer
      from jsonb_array_elements(p_ideas) with ordinality
  loop
    v_title := nullif(btrim(idea->>'title'), '');
    v_body := nullif(btrim(idea->>'body'), '');
    v_media_type := nullif(btrim(idea->>'media_type'), '');
    v_channel := nullif(btrim(idea->>'channel'), '');
    v_reason := nullif(btrim(idea->>'strategic_reason'), '');

    if v_title is null
       or length(v_title) > 300
       or v_body is null
       or v_media_type not in ('image', 'text', 'video')
       or v_channel is null
       or v_reason is null
       or lower(v_title) = any(seen_titles) then
      raise exception 'Each campaign idea needs a distinct title, angle, channel, media type and reason.';
    end if;
    seen_titles := seen_titles || lower(v_title);

    insert into client_ideas (
      client_id,
      title,
      body,
      media_type,
      source,
      status,
      job_id,
      campaign_id,
      campaign_position,
      content_territory,
      source_question,
      strategic_reason
    )
    values (
      c.client_id,
      v_title,
      concat_ws(E'\n\n',
        'Campaign: ' || c.name,
        'Operator brief: ' || c.brief,
        'Objective: ' || coalesce(c.objective, ''),
        'Audience: ' || coalesce(c.audience, ''),
        'Offer: ' || coalesce(c.offer_summary, ''),
        'Message: ' || coalesce(c.core_message, ''),
        'Channels: ' || array_to_string(c.channels, ', '),
        format('Campaign piece %s of %s.', pos, expected),
        'Intended channel: ' || v_channel,
        'Angle: ' || v_body,
        'Why this exists: ' || v_reason
      ),
      v_media_type::media_type,
      'auto',
      'draft',
      p_job_id,
      c.id,
      pos,
      'Campaign: ' || c.name,
      v_channel,
      v_reason
    );
  end loop;

  update client_campaigns
     set content_ideas_generated_at = now(),
         updated_at = now()
   where id = c.id;

  return expected;
end;
$$;

revoke execute on function save_campaign_plan_with_ideas(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function save_campaign_plan_with_ideas(uuid, uuid, uuid, jsonb, jsonb) to service_role;

comment on function save_campaign_plan_with_ideas(uuid, uuid, uuid, jsonb, jsonb) is
  'Agent-runtime-only commit point for campaign plans and their exact campaign-specific idea batch. Idempotent after the batch marker is set.';

create or replace function link_campaign_brief_artifact()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_campaign_id uuid;
  v_client_id uuid;
begin
  if new.source_idea_id is null then
    return new;
  end if;

  select campaign_id, client_id
    into v_campaign_id, v_client_id
    from client_ideas
   where id = new.source_idea_id;

  if v_campaign_id is null then
    return new;
  end if;

  if v_client_id <> new.client_id then
    raise exception 'Campaign idea and brief client mismatch.';
  end if;

  insert into campaign_artifacts (campaign_id, client_id, kind, brief_id)
  values (v_campaign_id, new.client_id, 'content', new.id)
  on conflict do nothing;

  return new;
end;
$$;

revoke execute on function link_campaign_brief_artifact() from public, anon, authenticated;
grant execute on function link_campaign_brief_artifact() to service_role;

drop trigger if exists link_campaign_brief_artifact_insert on client_briefs;
create trigger link_campaign_brief_artifact_insert
  after insert or update of source_idea_id, client_id on client_briefs
  for each row
  execute function link_campaign_brief_artifact();

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

  return query
  select 'Plan'::text,
         1,
         (c.built_at is not null)::integer,
         c.built_at is not null,
         case when c.built_at is not null then 'Written by the planner.'
              else 'The planner has not written this campaign yet.' end;

  if c.content_count > 0 then
    return query
    with ready as (
      select distinct coalesce(
             'idea:' || i.id::text,
             'brief:' || b.id::text,
             'asset:' || m.id::text
           ) as production_key
        from campaign_artifacts a
        join client_media_assets m
          on (a.asset_id is not null and m.id = a.asset_id)
          or (a.brief_id is not null and m.brief_id = a.brief_id)
        left join client_briefs b
          on b.id = m.brief_id
         and b.client_id = c.client_id
        left join client_ideas i
          on i.id = b.source_idea_id
         and i.client_id = c.client_id
         and i.campaign_id = c.id
       where a.campaign_id = c.id
         and a.client_id = c.client_id
         and a.kind = 'content'
         and m.client_id = c.client_id
         and m.review_status = 'approved'
         and nullif(m.storage_path, '') is not null
    ),
    have as (
      select count(*)::integer n from ready
    )
    select 'Content'::text, c.content_count, h.n, h.n >= c.content_count,
           format('%s of %s pieces ready to distribute.', h.n, c.content_count)
      from have h;
  end if;

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
  'Every requirement computed from the real artifact. Content counts approved finished assets ready to distribute, not merely written briefs.';
