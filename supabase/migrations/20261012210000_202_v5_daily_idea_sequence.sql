-- Sequence the four daily ideas so each later role can avoid accepted earlier angles.
create or replace function plan_daily_package(p_client_id uuid, p_day date)
returns daily_packages
language plpgsql security definer set search_path to 'public' as $$
declare
  v_settings client_daily_package_settings;
  v_campaign client_campaigns;
  v_pillar client_content_pillars;
  v_zone text;
  v_cutoff timestamptz;
  v_snapshot jsonb;
  v_run workflow_runs;
  v_package daily_packages;
  v_role text;
  v_format content_format;
  v_media media_type;
  v_idea workflow_steps;
  v_brief workflow_steps;
  v_create workflow_steps;
  v_motion workflow_steps;
  v_final workflow_steps;
  v_previous_idea text;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_settings from client_daily_package_settings
    where client_id = p_client_id for update;
  if not found or not v_settings.enabled then raise exception 'Daily package is not enabled.'; end if;
  if p_day is null then raise exception 'Package day is required.'; end if;
  select timezone into v_zone from clients where id = p_client_id;
  v_cutoff := (p_day + v_settings.approval_cutoff) at time zone v_zone;
  if v_cutoff <= now() then raise exception 'Package approval cutoff has passed.'; end if;
  -- One authority during the pilot: the legacy planner must not make a
  -- parallel batch of slots for the same client-day.
  if exists (select 1 from client_engine_settings
    where client_id = p_client_id and enabled) then
    raise exception 'Disable legacy engine planning before daily package pilot.';
  end if;
  select * into v_campaign from client_campaigns
    where id = v_settings.campaign_id and client_id = p_client_id
      and status in ('planning', 'live');
  select * into v_pillar from client_content_pillars
    where id = v_settings.pillar_id and client_id = p_client_id and active;
  if v_campaign.id is null or v_pillar.id is null
     or nullif(btrim(v_campaign.audience), '') is null
     or nullif(btrim(v_campaign.offer_summary), '') is null then
    raise exception 'A same-client active pillar and a campaign with audience and offer are required.';
  end if;
  v_snapshot := jsonb_build_object(
    'package_day', p_day, 'platform', v_settings.platform,
    'story_media_type', v_settings.story_media_type,
    'campaign_id', v_campaign.id, 'campaign_name', v_campaign.name,
    'audience', v_campaign.audience, 'offer', v_campaign.offer_summary,
    'core_message', v_campaign.core_message,
    'pillar_id', v_pillar.id, 'pillar_premise', v_pillar.premise,
    'cutoff_at', v_cutoff, 'required_roles',
    jsonb_build_array('reel', 'story', 'static_a', 'static_b'));
  v_run := create_workflow_run(
    p_client_id, 'daily_content_package', 'v5.daily.1', p_day::text,
    v_snapshot, v_cutoff, v_campaign.id);
  insert into daily_packages (run_id, client_id, package_day, cutoff_at,
    platform, story_media_type)
  values (v_run.id, p_client_id, p_day, v_cutoff,
    v_settings.platform, v_settings.story_media_type)
  on conflict (client_id, package_day) do nothing returning * into v_package;
  if not found then
    select * into v_package from daily_packages
      where client_id = p_client_id and package_day = p_day;
    if v_package.run_id <> v_run.id then raise exception 'idempotency_conflict'; end if;
  end if;

  foreach v_role in array array['reel', 'story', 'static_a', 'static_b'] loop
    v_format := case v_role when 'reel' then 'reel'::content_format
      when 'story' then 'story'::content_format else 'single'::content_format end;
    v_media := case v_role when 'reel' then 'video'::media_type
      when 'story' then v_settings.story_media_type else 'image'::media_type end;
    v_idea := add_workflow_agent_step(v_run.id, v_role || '_idea',
      case when v_previous_idea is null then '{}'::text[] else array[v_previous_idea] end,
      'ideation', 'clients', p_client_id,
      jsonb_build_object('target_platform', v_settings.platform,
        'content_format', v_format, 'media_type', v_media, 'idea_count', 1,
        'campaign_id', v_campaign.id, 'pillar_id', v_pillar.id));
    v_previous_idea := v_role || '_idea';
    v_brief := add_workflow_agent_step(v_run.id, v_role || '_brief',
      array[v_role || '_idea'], 'brief', 'client_ideas', null,
      '{}'::jsonb, v_role || '_idea');
    v_create := add_workflow_agent_step(v_run.id, v_role || '_create',
      array[v_role || '_brief'], 'creative_build', 'client_briefs', null,
      '{}'::jsonb, v_role || '_brief');
    v_final := v_create;
    if v_role = 'reel' or (v_role = 'story' and v_media = 'video') then
      v_motion := add_workflow_agent_step(v_run.id, v_role || '_motion',
        array[v_role || '_brief', v_role || '_create'],
        'video_build', 'client_briefs', null, '{}'::jsonb, v_role || '_brief');
      v_final := add_workflow_agent_step(v_run.id, v_role || '_edit',
        array[v_role || '_motion'], 'video_edit', 'client_media_assets',
        null, '{}'::jsonb, v_role || '_motion');
    end if;
    insert into daily_package_items (package_id, role, content_format, media_type,
      campaign_id, pillar_id, final_step_id)
    values (v_package.id, v_role, v_format, v_media,
      v_campaign.id, v_pillar.id, v_final.id)
    on conflict (package_id, role) do nothing;
  end loop;
  perform seal_workflow_run(v_run.id);
  return v_package;
end;
$$;
select lock_down_definer_functions();
