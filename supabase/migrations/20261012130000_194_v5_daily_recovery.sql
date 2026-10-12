-- A reserve is usable only after a human has approved its exact asset, with
-- compatible campaign, pillar, destination, format and finished copy.
create unique index daily_package_one_asset_per_role
  on daily_package_items (package_id, asset_id) where asset_id is not null;

create function validate_daily_workflow_artifact() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_step workflow_steps; v_item daily_package_items; v_package daily_packages;
  v_ok boolean;
begin
  select * into v_step from workflow_steps where id = new.step_id;
  select i.* into v_item from daily_package_items i
    join daily_packages p on p.id = i.package_id
    where p.run_id = new.run_id
      and v_step.step_key like i.role || '\_%' escape '\'
    limit 1;
  if not found then return new; end if;
  select * into v_package from daily_packages where id = v_item.package_id;
  v_ok := case new.artifact_kind
    when 'idea' then exists (select 1 from client_ideas a
      where a.id = new.record_id and a.client_id = v_package.client_id
        and a.campaign_id = v_item.campaign_id and a.pillar_id = v_item.pillar_id
        and a.target_platform = v_package.platform
        and a.content_format = v_item.content_format and a.media_type = v_item.media_type)
    when 'brief' then exists (select 1 from client_briefs b
      join client_ideas a on a.id = b.source_idea_id
      where b.id = new.record_id and b.client_id = v_package.client_id
        and a.campaign_id = v_item.campaign_id and a.pillar_id = v_item.pillar_id
        and b.content_format = v_item.content_format and b.media_type = v_item.media_type
        and b.target_platform = v_package.platform)
    when 'asset' then exists (select 1 from client_media_assets m
      join client_briefs b on b.id = m.brief_id
      join client_ideas a on a.id = b.source_idea_id
      where m.id = new.record_id and m.client_id = v_package.client_id
        and a.campaign_id = v_item.campaign_id and a.pillar_id = v_item.pillar_id
        and a.target_platform = v_package.platform
        and m.content_format = v_item.content_format and m.media_type = v_item.media_type
        and (m.media_type <> 'video' or nullif(btrim(m.render_path), '') is not null
          or v_step.agent_key in ('creative_build', 'video_build')))
    else false end;
  if not v_ok then
    raise exception 'Daily package artefact does not match its role, campaign, pillar or destination.';
  end if;
  return new;
end;
$$;
create trigger workflow_artifact_daily_match before insert on workflow_artifacts
  for each row execute function validate_daily_workflow_artifact();

create table daily_package_recoveries (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null unique references daily_package_items(id) on delete cascade,
  reserve_asset_id uuid not null unique references client_media_assets(id),
  reason text not null check (length(btrim(reason)) > 0),
  selected_at timestamptz not null default now()
);
create table daily_package_recovery_alerts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references daily_package_items(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index daily_package_alerts_open_idx on daily_package_recovery_alerts (created_at)
  where resolved_at is null;
create unique index daily_package_one_open_alert
  on daily_package_recovery_alerts (item_id) where resolved_at is null;
alter table daily_package_recoveries enable row level security;
alter table daily_package_recovery_alerts enable row level security;
create policy daily_recoveries_read on daily_package_recoveries for select to authenticated
  using (exists (select 1 from daily_package_items i
    join daily_packages p on p.id = i.package_id
    where i.id = item_id and can_access_client(p.client_id)));
create policy daily_recovery_alerts_read on daily_package_recovery_alerts for select to authenticated
  using (exists (select 1 from daily_package_items i
    join daily_packages p on p.id = i.package_id
    where i.id = item_id and can_access_client(p.client_id)));
grant select on daily_package_recoveries, daily_package_recovery_alerts to authenticated;

create function recover_daily_package_item(p_item_id uuid, p_reason text)
returns daily_package_recoveries
language plpgsql security definer set search_path to 'public' as $$
declare v_item daily_package_items; v_package daily_packages;
  v_run workflow_runs; v_step workflow_steps; v_asset client_media_assets;
  v_recovery daily_package_recoveries; v_version text;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'Recovery reason is required.'; end if;
  select * into v_item from daily_package_items where id = p_item_id for update;
  if not found then raise exception 'No such package item.'; end if;
  select * into v_package from daily_packages where id = v_item.package_id for update;
  select * into v_run from workflow_runs where id = v_package.run_id for update;
  select * into v_recovery from daily_package_recoveries where item_id = p_item_id;
  if found then
    if v_recovery.reason = btrim(p_reason) then return v_recovery; end if;
    raise exception 'idempotency_conflict';
  end if;
  select * into v_step from workflow_steps where id = v_item.final_step_id for update;
  if v_step.status <> 'blocked' or v_item.asset_id is not null then
    raise exception 'Only a blocked, unfinished final step may use a reserve.';
  end if;
  if exists (select 1 from workflow_steps s
    where s.run_id = v_run.id and v_step.step_key = any(s.dependencies)) then
    raise exception 'A step with dependents cannot be replaced by a reserve.';
  end if;
  select m.* into v_asset
  from client_media_assets m
  join client_briefs b on b.id = m.brief_id
  join client_ideas i on i.id = b.source_idea_id
  where m.client_id = v_package.client_id
    and i.client_id = v_package.client_id
    and i.campaign_id = v_item.campaign_id
    and i.pillar_id = v_item.pillar_id
    and i.target_platform = v_package.platform
    and m.content_format = v_item.content_format
    and m.media_type = v_item.media_type
    and m.review_status = 'approved'
    and m.human_approved_at is not null
    and m.created_at < v_package.created_at
    and (m.media_type <> 'video' or nullif(btrim(m.render_path), '') is not null)
    and exists (select 1 from post_copy pc where pc.asset_id = m.id
      and pc.platform = v_package.platform and nullif(btrim(pc.caption), '') is not null)
    and not exists (select 1 from daily_package_recoveries r where r.reserve_asset_id = m.id)
    and not exists (select 1 from daily_package_items used where used.asset_id = m.id)
  order by m.human_approved_at, m.id
  for update of m skip locked limit 1;
  if not found then
    insert into daily_package_recovery_alerts (item_id, reason)
    values (p_item_id, 'No compatible human-approved reserve: ' || btrim(p_reason))
    on conflict (item_id) where resolved_at is null do nothing;
    update workflow_runs set status = 'blocked',
      blocker = 'No compatible human-approved reserve for ' || v_item.role || '.',
      updated_at = now() where id = v_run.id;
    return null;
  end if;
  v_version := coalesce(nullif(btrim(v_asset.render_path), ''), v_asset.storage_path);
  insert into daily_package_recoveries (item_id, reserve_asset_id, reason)
  values (p_item_id, v_asset.id, btrim(p_reason)) returning * into v_recovery;
  insert into workflow_artifacts (run_id, step_id, artifact_kind, record_id,
    version_key, qa_evidence)
  values (v_run.id, v_step.id, 'asset', v_asset.id, v_version,
    jsonb_build_object('result', 'pass', 'checks', jsonb_build_array('preapproved_reserve'),
      'recovery_id', v_recovery.id, 'human_approved_at', v_asset.human_approved_at));
  update workflow_steps set status = 'completed', blocker = null,
    completed_at = now(), updated_at = now() where id = v_step.id;
  update daily_package_items set asset_id = v_asset.id where id = p_item_id;
  update workflow_runs set status = case
      when not exists (select 1 from workflow_steps s
        where s.run_id = v_run.id and s.status <> 'completed')
      then 'awaiting_human_approval' else 'needs_internal_qa' end,
    blocker = null, updated_at = now() where id = v_run.id;
  update daily_package_recovery_alerts set resolved_at = now()
    where item_id = p_item_id and resolved_at is null;
  return v_recovery;
end;
$$;

-- Readiness is measured at the time the fourth output was accepted, not at
-- the time a manager opens the package later in the day.
create or replace function daily_package_readiness(p_package_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_package daily_packages; v_run workflow_runs;
  v_accepted integer; v_roles integer; v_last_accepted timestamptz;
begin
  select * into v_package from daily_packages where id = p_package_id;
  if not found then raise exception 'No such daily package.'; end if;
  if auth.role() <> 'service_role' and not can_access_client(v_package.client_id) then
    raise exception 'Not permitted for this client.';
  end if;
  select * into v_run from workflow_runs where id = v_package.run_id;
  select count(*), count(*) filter (where i.asset_id is not null and s.status = 'completed'),
    max(a.accepted_at)
    into v_roles, v_accepted, v_last_accepted
  from daily_package_items i
  join workflow_steps s on s.id = i.final_step_id
  left join workflow_artifacts a on a.step_id = s.id and a.artifact_kind = 'asset'
  where i.package_id = p_package_id;
  return jsonb_build_object(
    'package_id', p_package_id, 'run_id', v_package.run_id,
    'required_count', 4, 'planned_count', v_roles,
    'accepted_count', v_accepted,
    'ready_for_review', v_roles = 4 and v_accepted = 4
      and v_run.status = 'awaiting_human_approval',
    'cutoff_met', v_roles = 4 and v_accepted = 4
      and v_last_accepted is not null and v_last_accepted <= v_package.cutoff_at,
    'last_accepted_at', v_last_accepted,
    'run_status', v_run.status, 'blocker', v_run.blocker);
end;
$$;

-- Seven future client-days need seven reels, seven stories and fourteen
-- statics. This is supply coverage, not a promise that future work is done.
create function daily_reserve_coverage(p_client_id uuid)
returns table (role text, target integer, available integer, shortfall integer)
language plpgsql security definer set search_path to 'public' as $$
declare v_settings client_daily_package_settings; v_role text; v_target integer;
  v_format content_format; v_media media_type; v_count integer;
begin
  if auth.role() <> 'service_role' and not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client.';
  end if;
  select * into v_settings from client_daily_package_settings where client_id = p_client_id;
  if not found then raise exception 'Daily package settings are missing.'; end if;
  foreach v_role in array array['reel', 'story', 'static'] loop
    v_target := case when v_role = 'static' then 14 else 7 end;
    v_format := case v_role when 'reel' then 'reel'::content_format
      when 'story' then 'story'::content_format else 'single'::content_format end;
    v_media := case v_role when 'reel' then 'video'::media_type
      when 'story' then v_settings.story_media_type else 'image'::media_type end;
    select count(*)::integer into v_count
    from client_media_assets m
    join client_briefs b on b.id = m.brief_id
    join client_ideas i on i.id = b.source_idea_id
    where m.client_id = p_client_id and i.client_id = p_client_id
      and i.campaign_id = v_settings.campaign_id
      and i.pillar_id = v_settings.pillar_id
      and i.target_platform = v_settings.platform
      and m.content_format = v_format and m.media_type = v_media
      and m.review_status = 'approved' and m.human_approved_at is not null
      and (m.media_type <> 'video' or nullif(btrim(m.render_path), '') is not null)
      and exists (select 1 from post_copy pc where pc.asset_id = m.id
        and pc.platform = v_settings.platform and nullif(btrim(pc.caption), '') is not null)
      and not exists (select 1 from daily_package_recoveries r where r.reserve_asset_id = m.id)
      and not exists (select 1 from daily_package_items used where used.asset_id = m.id);
    role := v_role; target := v_target; available := v_count;
    shortfall := greatest(0, v_target - v_count);
    return next;
  end loop;
end;
$$;

revoke all on function recover_daily_package_item(uuid, text) from public, anon, authenticated;
grant execute on function recover_daily_package_item(uuid, text) to service_role;
revoke all on function daily_reserve_coverage(uuid) from public, anon;
grant execute on function daily_reserve_coverage(uuid) to authenticated, service_role;
select lock_down_definer_functions();
