-- All four ideation entries share one destination/shape. AI runs may also
-- target a built campaign; generated ideas are positioned when written.
create function enqueue_scoped_ideation(
  p_client_id uuid,
  p_target_platform post_platform,
  p_media_type media_type,
  p_content_format content_format,
  p_campaign_id uuid,
  p_idea_count integer,
  p_input_table text,
  p_input_id uuid
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_formats text[];
begin
  if p_client_id is null or not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if p_target_platform is null or p_media_type is null or p_content_format is null then
    raise exception 'Choose a destination, media type and format';
  end if;
  v_formats := case p_target_platform
    when 'instagram' then array['single', 'carousel', 'story', 'reel']
    when 'facebook' then array['single', 'carousel', 'story', 'reel']
    when 'tiktok' then array['single', 'carousel', 'reel']
    when 'linkedin' then array['single', 'carousel']
    when 'youtube' then array['single', 'reel']
  end;
  if not p_content_format::text = any(v_formats)
     or not format_fits_media(p_content_format, p_media_type) then
    raise exception 'That media type and format are not supported for this destination';
  end if;
  if p_idea_count is not null and (p_idea_count < 1 or p_idea_count > 60) then
    raise exception 'Choose between 1 and 60 ideas';
  end if;
  if (p_input_table is null) <> (p_input_id is null)
     or p_input_table is not null and p_input_table not in ('client_content_pillars', 'client_proof_assets') then
    raise exception 'Invalid ideation source';
  end if;
  if p_input_table = 'client_content_pillars' and not exists (
    select 1 from client_content_pillars where id = p_input_id and client_id = p_client_id
  ) then raise exception 'Pillar not found for this client'; end if;
  if p_input_table = 'client_proof_assets' and not exists (
    select 1 from client_proof_assets where id = p_input_id and client_id = p_client_id
  ) then raise exception 'Proof not found for this client'; end if;
  if p_campaign_id is not null and not exists (
    select 1 from client_campaigns where id = p_campaign_id and client_id = p_client_id
      and built_at is not null and archived_at is null
  ) then raise exception 'Campaign is not built or available for this client'; end if;
  return enqueue_agent_job_internal(
    'ideation', p_client_id, p_input_table, p_input_id, auth.uid(),
    jsonb_build_object('target_platform', p_target_platform, 'media_type', p_media_type,
      'content_format', p_content_format, 'campaign_id', p_campaign_id, 'idea_count', p_idea_count),
    'Queued: scoped ideation'
  );
end;
$$;
revoke execute on function enqueue_scoped_ideation(uuid, post_platform, media_type, content_format, uuid, integer, text, uuid) from public, anon;
grant execute on function enqueue_scoped_ideation(uuid, post_platform, media_type, content_format, uuid, integer, text, uuid) to authenticated;

create function assign_generated_idea_campaign()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_campaign uuid;
  v_reserved integer;
begin
  if new.job_id is null or new.campaign_id is not null then return new; end if;
  select nullif(params->>'campaign_id', '')::uuid into v_campaign
    from agent_jobs where id = new.job_id and agent_key = 'ideation' and client_id = new.client_id;
  if v_campaign is null then return new; end if;
  select case when content_ideas_generated_at is null then content_count else 0 end
    into v_reserved
    from client_campaigns
   where id = v_campaign and client_id = new.client_id and built_at is not null and archived_at is null
   for update;
  if not found then raise exception 'Ideation campaign is no longer available'; end if;
  new.campaign_id := v_campaign;
  select greatest(coalesce(v_reserved, 0), coalesce(max(campaign_position), 0)) + 1
    into new.campaign_position from client_ideas where campaign_id = v_campaign;
  return new;
end;
$$;
create trigger assign_generated_idea_campaign_before_insert
before insert on client_ideas for each row execute function assign_generated_idea_campaign();
