-- Which content pillars a campaign runs within.
--
-- The paid side picks one of sixteen templates; the organic side picks this
-- brand's pillars. They are not alternatives — a campaign can have a template
-- AND pillars, because the same asset can run as an ad and sit on the feed.
-- So this is its own table rather than a column competing with template.
--
-- Many-to-many. A campaign usually runs one or two pillars, occasionally all
-- of them, and a pillar carries many campaigns over its life.

create table campaign_content_pillars (
  campaign_id uuid not null references client_campaigns (id) on delete cascade,
  pillar_id   uuid not null references client_content_pillars (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (campaign_id, pillar_id)
);

create index campaign_content_pillars_pillar_idx
  on campaign_content_pillars (pillar_id);

comment on table campaign_content_pillars is
  'The content pillars a campaign generates within. Empty means the campaign is not pillar-scoped, which is every campaign planned before pillars existed.';

alter table campaign_content_pillars enable row level security;

create policy ccpil_admin_all on campaign_content_pillars
  for all to authenticated using (is_admin()) with check (is_admin());
create policy ccpil_scoped_read on campaign_content_pillars
  for select to authenticated using (
    exists (
      select 1 from client_campaigns c
       where c.id = campaign_id and can_access_client(c.client_id)
    )
  );

-- The plan commit carries a pillar per idea.
--
-- This is migration 77's function with the pillar handling added and nothing
-- else touched — the idempotency marker, the re-plan path, the 0-30 content
-- bound, the title length cap and the ordinality iteration are all as they
-- were. Same argument list, so it replaces rather than overloads.

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
  v_pillar uuid;
  v_pillar_name text;
  allowed uuid[];
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

  -- The pillars this campaign runs within. Empty for every campaign planned
  -- before pillars existed, which is the unchanged path below.
  select coalesce(array_agg(pillar_id), '{}') into allowed
    from campaign_content_pillars where campaign_id = c.id;

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

    v_pillar := nullif(btrim(coalesce(idea->>'pillar_id', '')), '')::uuid;
    -- A pillar the campaign is not running is refused rather than nulled: an
    -- idea filed under somebody else's pillar lands in their calendar share
    -- and nothing flags it, which is worse than an unfiled idea.
    if array_length(allowed, 1) is not null and v_pillar is null then
      raise exception 'Campaign idea % was not assigned a content pillar.', pos;
    end if;
    if v_pillar is not null and not (v_pillar = any (allowed)) then
      raise exception 'Campaign idea % was assigned a pillar this campaign is not running.', pos;
    end if;
    v_pillar_name := null;
    if v_pillar is not null then
      select name into v_pillar_name from client_content_pillars where id = v_pillar;
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
      strategic_reason,
      pillar_id
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
      -- The pillar's own name where there is one. Letting anything restate
      -- it is how "Continuity and certainty" became "Continuity and Certainty".
      coalesce(v_pillar_name, 'Campaign: ' || c.name),
      v_channel,
      v_reason,
      v_pillar
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
  'Agent-runtime-only commit point for campaign plans and their exact campaign-specific idea batch. Idempotent after the batch marker is set. Where the campaign names content pillars, every idea must be assigned one of them.';
