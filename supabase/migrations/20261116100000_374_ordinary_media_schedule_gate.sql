-- Manual scheduling cannot treat a historical timestamp as exact creative
-- authority. The Engine's own approve_slot transaction is a separate route.
begin;
create or replace function public.schedule_asset(
  p_asset_id uuid,
  p_date date,
  p_channel public.post_channel default 'organic'::public.post_channel,
  p_platform public.post_platform default null::public.post_platform,
  p_time time default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_asset public.client_media_assets%rowtype;
  v_brief public.client_briefs%rowtype;
  v_idea public.client_ideas%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in console user must schedule this asset.' using errcode = '42501';
  end if;
  if p_date is null then
    raise exception 'Choose a date before scheduling.' using errcode = 'P0001';
  end if;
  if p_channel is distinct from 'organic'::public.post_channel then
    raise exception 'Paid scheduling uses the Ads Studio route, not organic distribution.' using errcode = 'P0001';
  end if;

  -- FOR SHARE conflicts with updates to approval, client and lineage fields.
  -- The validated chain cannot be edited between this read and the insert.
  select * into v_asset from public.client_media_assets
   where id = p_asset_id for share;
  if not found then
    raise exception 'Asset not found.' using errcode = 'P0001';
  end if;
  if public.can_access_client(v_asset.client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode = '42501';
  end if;
  if v_asset.review_status is distinct from 'approved'::public.review_status then
    raise exception 'Asset must be approved before it can be scheduled.' using errcode = 'P0001';
  end if;
  if v_asset.human_approved_at is null then
    raise exception 'That asset has not been approved by a person yet. Approve it in Approvals before scheduling it.' using errcode = 'P0001';
  end if;
  if v_asset.media_type in ('image','text')
    and v_asset.content_format='single' and v_asset.render_path is null
    and not public.ordinary_media_signoff_current_v6(v_asset.id) then
    raise exception 'The exact creative signoff is missing or stale. Review a new version before scheduling.'
      using errcode='P0001';
  end if;
  if v_asset.brief_id is null then
    raise exception 'Scheduling blocked: this asset has no verified organic campaign brief.' using errcode = 'P0001';
  end if;

  select * into v_brief from public.client_briefs
   where id = v_asset.brief_id for share;
  if not found or v_brief.client_id is distinct from v_asset.client_id
     or v_brief.source_idea_id is null then
    raise exception 'Scheduling blocked: the asset brief has no same-client campaign idea.' using errcode = 'P0001';
  end if;

  select * into v_idea from public.client_ideas
   where id = v_brief.source_idea_id for share;
  if not found or v_idea.client_id is distinct from v_asset.client_id
     or v_idea.campaign_id is null then
    raise exception 'Scheduling blocked: the brief idea has no same-client campaign.' using errcode = 'P0001';
  end if;

  select * into v_campaign from public.client_campaigns
   where id = v_idea.campaign_id for share;
  if not found or v_campaign.client_id is distinct from v_asset.client_id then
    raise exception 'Scheduling blocked: the campaign belongs to another client or is missing.' using errcode = 'P0001';
  end if;
  if v_campaign.acquisition_mode = 'paid' then
    raise exception 'Scheduling blocked: this asset belongs to a paid campaign. Use Ads Studio.' using errcode = 'P0001';
  end if;
  if v_campaign.acquisition_mode is distinct from 'organic' or v_campaign.paid_platform is not null then
    raise exception 'Scheduling blocked: this campaign has no explicit organic route.' using errcode = 'P0001';
  end if;

  -- A missing time is still the current contract: the existing BEFORE
  -- trigger applies the client's default 09:00 local time.
  insert into public.scheduled_posts
    (asset_id, scheduled_for, scheduled_at, channel, platform, created_by)
  values (
    p_asset_id, p_date,
    case when p_time is null then null
         else (p_date + p_time) at time zone public.client_timezone(v_asset.client_id) end,
    p_channel, p_platform, auth.uid()
  ) returning id into v_id;
  return v_id;
end
$function$;
comment on function public.schedule_asset(uuid,date,public.post_channel,public.post_platform,time) is
  'Manual organic scheduling requires a current exact creative signoff for single-file image/text assets, plus the same-client campaign chain. Outward publication retains its own package approval gate.';
select public.lock_down_definer_functions();
commit;
