-- Prepare a client's daily production inputs without enabling automation.
-- Activation is a separate Dashboard governance decision.
create function public.configure_daily_package_settings_v1(
  p_client_id uuid,p_campaign_id uuid,p_pillar_id uuid,
  p_platform public.post_platform,p_story_media_type public.media_type,
  p_approval_cutoff time without time zone
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare existing public.client_daily_package_settings%rowtype;
  campaign public.client_campaigns%rowtype;
  pillar public.client_content_pillars%rowtype;
  client public.clients%rowtype;
  saved public.client_daily_package_settings%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service daily package setup only.' using errcode='42501';
  end if;
  if p_client_id is null or p_campaign_id is null or p_pillar_id is null
    or p_platform not in ('facebook','instagram')
    or p_story_media_type not in ('image','video')
    or p_approval_cutoff is null then
    raise exception 'Choose a client, built campaign, active pillar, Meta destination and cutoff.'
      using errcode='22023';
  end if;
  select * into client from public.clients where id=p_client_id for share;
  select * into campaign from public.client_campaigns
    where id=p_campaign_id and client_id=p_client_id for share;
  select * into pillar from public.client_content_pillars
    where id=p_pillar_id and client_id=p_client_id for share;
  select * into existing from public.client_daily_package_settings
    where client_id=p_client_id for update;
  if client.id is null or campaign.id is null or pillar.id is null
    or not pillar.active or campaign.status not in ('planning','live')
    or campaign.built_at is null or campaign.archived_at is not null
    or nullif(btrim(coalesce(campaign.audience,'')),'') is null
    or nullif(btrim(coalesce(campaign.offer_summary,'')),'') is null then
    raise exception 'Daily setup needs this client built campaign and active content pillar.'
      using errcode='23514';
  end if;
  if existing.enabled then
    raise exception 'Switch daily production off before changing its campaign or pillar.'
      using errcode='23514';
  end if;
  insert into public.client_daily_package_settings
    (client_id,campaign_id,pillar_id,platform,story_media_type,
      approval_cutoff,enabled,updated_at)
  values(p_client_id,p_campaign_id,p_pillar_id,p_platform,p_story_media_type,
    p_approval_cutoff,false,now())
  on conflict(client_id) do update set
    campaign_id=excluded.campaign_id,pillar_id=excluded.pillar_id,
    platform=excluded.platform,story_media_type=excluded.story_media_type,
    approval_cutoff=excluded.approval_cutoff,updated_at=now()
    where not public.client_daily_package_settings.enabled
  returning * into saved;
  if saved.client_id is null then
    raise exception 'Daily production changed during setup. Review the current switch.'
      using errcode='23514';
  end if;
  return jsonb_build_object('client_id',saved.client_id,
    'campaign_id',saved.campaign_id,'pillar_id',saved.pillar_id,
    'platform',saved.platform,'story_media_type',saved.story_media_type,
    'approval_cutoff',saved.approval_cutoff,'enabled',saved.enabled);
end $$;
revoke all on function public.configure_daily_package_settings_v1(
  uuid,uuid,uuid,public.post_platform,public.media_type,time without time zone)
  from public,anon,authenticated,service_role;
grant execute on function public.configure_daily_package_settings_v1(
  uuid,uuid,uuid,public.post_platform,public.media_type,time without time zone)
  to service_role;
comment on function public.configure_daily_package_settings_v1(
  uuid,uuid,uuid,public.post_platform,public.media_type,time without time zone) is
  'Saves same-client daily production inputs while the daily switch is off; it cannot enable production or publish.';
