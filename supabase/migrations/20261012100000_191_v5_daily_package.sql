-- Daily production demand is distinct from the posting calendar. This is
-- explicitly opted in per client and never enables publication.
create table client_daily_package_settings (
  client_id uuid primary key references clients(id) on delete cascade,
  enabled boolean not null default false,
  campaign_id uuid not null references client_campaigns(id),
  pillar_id uuid not null references client_content_pillars(id),
  platform post_platform not null default 'instagram',
  story_media_type media_type not null default 'image'
    check (story_media_type in ('image', 'video')),
  approval_cutoff time not null default '09:00',
  updated_at timestamptz not null default now()
);

create table daily_packages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references workflow_runs(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  package_day date not null,
  cutoff_at timestamptz not null,
  platform post_platform not null,
  story_media_type media_type not null,
  created_at timestamptz not null default now(),
  unique (client_id, package_day)
);
create index daily_packages_client_day_idx on daily_packages (client_id, package_day desc);

create table daily_package_items (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references daily_packages(id) on delete cascade,
  role text not null check (role in ('reel', 'story', 'static_a', 'static_b')),
  content_format content_format not null,
  media_type media_type not null,
  campaign_id uuid not null references client_campaigns(id),
  pillar_id uuid not null references client_content_pillars(id),
  proof_id uuid references client_proof_assets(id) on delete set null,
  final_step_id uuid not null references workflow_steps(id) on delete cascade,
  asset_id uuid references client_media_assets(id) on delete set null,
  slot_id uuid unique references content_slots(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (package_id, role),
  unique (final_step_id),
  check ((role = 'reel' and content_format = 'reel' and media_type = 'video')
    or (role = 'story' and content_format = 'story' and media_type in ('image', 'video'))
    or (role in ('static_a', 'static_b') and content_format = 'single' and media_type = 'image'))
);
create index daily_package_items_package_idx on daily_package_items (package_id, role);

alter table client_daily_package_settings enable row level security;
alter table daily_packages enable row level security;
alter table daily_package_items enable row level security;
create policy daily_settings_read on client_daily_package_settings for select to authenticated
  using (can_access_client(client_id));
create policy daily_packages_read on daily_packages for select to authenticated
  using (can_access_client(client_id));
create policy daily_package_items_read on daily_package_items for select to authenticated
  using (exists (select 1 from daily_packages p where p.id = package_id
    and can_access_client(p.client_id)));
grant select on client_daily_package_settings, daily_packages, daily_package_items to authenticated;

create function daily_item_accepts_final_asset() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.artifact_kind = 'asset' then
    update daily_package_items set asset_id = new.record_id
      where final_step_id = new.step_id;
  end if;
  return new;
end;
$$;
create trigger daily_item_final_asset after insert on workflow_artifacts
  for each row execute function daily_item_accepts_final_asset();

create function daily_package_readiness(p_package_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_package daily_packages; v_run workflow_runs;
  v_accepted integer; v_roles integer;
begin
  select * into v_package from daily_packages where id = p_package_id;
  if not found then raise exception 'No such daily package.'; end if;
  if auth.role() <> 'service_role' and not can_access_client(v_package.client_id) then
    raise exception 'Not permitted for this client.';
  end if;
  select * into v_run from workflow_runs where id = v_package.run_id;
  select count(*), count(*) filter (where i.asset_id is not null and s.status = 'completed')
    into v_roles, v_accepted
  from daily_package_items i join workflow_steps s on s.id = i.final_step_id
  where i.package_id = p_package_id;
  return jsonb_build_object(
    'package_id', p_package_id, 'run_id', v_package.run_id,
    'required_count', 4, 'planned_count', v_roles,
    'accepted_count', v_accepted,
    'ready_for_review', v_roles = 4 and v_accepted = 4
      and v_run.status = 'awaiting_human_approval',
    'cutoff_met', v_roles = 4 and v_accepted = 4 and now() <= v_package.cutoff_at,
    'run_status', v_run.status, 'blocker', v_run.blocker);
end;
$$;

-- One transaction freezes the campaign/offer/audience context, creates the
-- exact four roles and seals all agent dependencies before the worker sees it.
create function plan_daily_package(p_client_id uuid, p_day date)
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
    v_idea := add_workflow_agent_step(v_run.id, v_role || '_idea', '{}',
      'ideation', 'clients', p_client_id,
      jsonb_build_object('target_platform', v_settings.platform,
        'content_format', v_format, 'media_type', v_media, 'idea_count', 1,
        'campaign_id', v_campaign.id, 'pillar_id', v_pillar.id));
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

revoke all on function plan_daily_package(uuid, date) from public, anon, authenticated;
grant execute on function plan_daily_package(uuid, date) to service_role;
revoke all on function daily_item_accepts_final_asset() from public, anon, authenticated;
revoke all on function daily_package_readiness(uuid) from public, anon;
grant execute on function daily_package_readiness(uuid) to authenticated, service_role;
select lock_down_definer_functions();
