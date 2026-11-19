-- Require current exact source approval when preparing and claiming organic
-- image/text publication packages. Old human_approved_at alone is insufficient.
begin;
create function public.organic_creative_source_current_v8(p_post_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public,storage set timezone='UTC' as $$
declare p public.scheduled_posts%rowtype;
  a public.client_media_assets%rowtype;
  s public.content_slots%rowtype;
  r public.approval_requests_v6%rowtype;
  e public.approval_request_evidence_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  v_package jsonb;
  v_hash text;
  v_epoch uuid;
  v_epoch_count integer;
begin
  if auth.role() not in ('authenticated','service_role') then return false; end if;
  select * into p from public.scheduled_posts where id=p_post_id;
  if p.id is null or p.client_id is null or p.asset_id is null
    or p.channel is distinct from 'organic'::public.post_channel
    or p.publication_status is null
    or p.publication_status not in ('scheduled','publishing')
    or p.published_at is not null
    or (auth.role()='authenticated' and not public.can_access_client(p.client_id))
    then return false; end if;
  select * into a from public.client_media_assets
    where id=p.asset_id and client_id=p.client_id;
  if a.id is null or a.review_status is distinct from 'approved'::public.review_status
    or a.human_approved_at is null or a.media_type is null
    or a.media_type not in ('image','text')
    or a.content_format is null or a.content_format not in ('single','carousel','story')
    then return false; end if;
  if public.ordinary_media_signoff_current_v6(a.id) then return true; end if;
  -- The Engine owns a different exact AAL2 source decision. It may authorize
  -- only its own linked post; a human timestamp alone never qualifies.
  if a.content_format <> 'single' then return false; end if;
  if (select count(*) from public.content_slots cs
      where cs.scheduled_post_id=p.id)<>1 then return false; end if;
  select * into s from public.content_slots
    where scheduled_post_id=p.id and client_id=p.client_id and asset_id=a.id;
  if s.id is null or s.stage is distinct from 'scheduled'::public.slot_stage
    or s.platform is distinct from p.platform
    or s.scheduled_at is distinct from p.scheduled_at
    or p.media_type is distinct from a.media_type then return false; end if;
  select count(*)::integer,min(se.id::text)::uuid into v_epoch_count,v_epoch
    from public.slot_events se where se.slot_id=s.id
      and se.to_stage::text='awaiting_approval';
  if v_epoch_count<>1 then return false; end if;
  select * into r from public.approval_requests_v6
    where client_id=p.client_id and source_system='aa_console'
      and source_kind='engine_slot' and source_id=s.id::text
      and source_version=v_epoch::text
    order by requested_at desc,id desc limit 1;
  if r.id is null or r.scope is distinct from jsonb_build_object(
      'client_id',s.client_id,'slot_id',s.id,'asset_id',s.asset_id,
      'platform',s.platform,'scheduled_at',s.scheduled_at,
      'format',s.format,'approval_entry_id',r.source_version)
    or exists(select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id=r.id) then return false; end if;
  select * into e from public.approval_request_evidence_v6
    where request_id=r.id;
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  v_package:=public.engine_slot_exact_package_v6(s.id);
  v_hash:=public.engine_slot_exact_hash_v6(s.id);
  return coalesce(v_package is not null and v_hash is not null
    and e.id is not null and e.artifact_hash=v_hash
    and e.preview->'exact_package'=v_package
    and e.scope=r.scope and e.account_ref=v_package->>'account_ref'
    and e.destination=r.destination
    and d.decision='approved' and d.actor_aal='aal2'
    and d.actor_id is not null and d.artifact_hash=v_hash
    and d.source_decision_ref='engine_slot:'||r.source_version,false);
end $$;
revoke all on function public.organic_creative_source_current_v8(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.organic_creative_source_current_v8(uuid)
  to authenticated,service_role;

create or replace view public.ordinary_media_current_status_v6
with (security_invoker=true) as
select a.client_id,a.id as asset_id,
  (public.ordinary_media_signoff_current_v6(a.id) is true
    or exists(select 1 from public.content_slots s
      where s.asset_id=a.id and s.client_id=a.client_id
        and s.scheduled_post_id is not null
        and public.organic_creative_source_current_v8(s.scheduled_post_id) is true))
    as current_signoff
from public.client_media_assets a
where a.media_type in ('image','text')
  and a.content_format in ('single','carousel','story')
  and (a.content_format='single' or a.render_path is null)
  and a.review_status='approved' and a.human_approved_at is not null;
revoke all on public.ordinary_media_current_status_v6
  from public,anon,authenticated,service_role;
grant select on public.ordinary_media_current_status_v6
  to authenticated,service_role;

create or replace function public.organic_publication_source_snapshot_v6(p_post_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_post public.scheduled_posts%rowtype;
  v_slot public.content_slots%rowtype;
  v_asset public.client_media_assets%rowtype;
  v_brief public.client_briefs%rowtype;
  v_idea public.client_ideas%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_route public.campaign_route_packages_v6%rowtype;
  v_copy public.post_copy_effective%rowtype;
  v_provider text;
  v_account text;
  v_account_count integer;
  v_paths jsonb;
begin
  select * into v_post from public.scheduled_posts where id = p_post_id;
  if not found or v_post.client_id is null or v_post.asset_id is null
    or v_post.platform is null or v_post.scheduled_at is null
    or v_post.channel is distinct from 'organic'::public.post_channel
    or v_post.publication_status is distinct from 'scheduled'
    or v_post.published_at is not null
    then return null; end if;
  select * into v_asset from public.client_media_assets
    where id = v_post.asset_id and client_id = v_post.client_id;
  if not found or v_asset.review_status is distinct from 'approved'::public.review_status
    or v_asset.human_approved_at is null
    or (v_asset.media_type::text in ('image','text')
      and v_asset.content_format in ('single','carousel','story')
      and public.organic_creative_source_current_v8(p_post_id) is not true)
    or v_asset.content_format is null
    or v_post.media_type is distinct from v_asset.media_type then return null; end if;
  select * into v_brief from public.client_briefs
    where id = v_asset.brief_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_idea from public.client_ideas
    where id = v_brief.source_idea_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_campaign from public.client_campaigns
    where id = v_idea.campaign_id and client_id = v_post.client_id;
  if not found or not v_campaign.runs_organic
    or v_campaign.acquisition_mode not in ('organic','both')
    or v_idea.acquisition_route is distinct from 'organic' then return null; end if;
  select * into v_route from public.campaign_route_packages_v6
    where campaign_id = v_campaign.id and client_id = v_campaign.client_id
      and route = 'organic' order by version desc limit 1;
  if not found or v_route.plan_fingerprint is distinct from
      public.campaign_plan_fingerprint(v_campaign) then return null; end if;
  if (select count(*) from public.content_slots
      where scheduled_post_id = v_post.id) <> 1 then return null; end if;
  select * into v_slot from public.content_slots
    where scheduled_post_id = v_post.id;
  if v_slot.stage is distinct from 'scheduled'::public.slot_stage
    or (v_slot.client_id, v_slot.asset_id, v_slot.brief_id,
        v_slot.idea_id, v_slot.platform, v_slot.scheduled_at)
       is distinct from
       (v_post.client_id, v_asset.id, v_brief.id,
        v_idea.id, v_post.platform, v_post.scheduled_at)
    then return null; end if;
  select * into v_copy from public.post_copy_effective
    where scheduled_post_id = v_post.id and platform = v_post.platform;
  if not found or nullif(btrim(coalesce(v_copy.caption, '')), '') is null
    then return null; end if;
  select provider into v_provider from public.platform_publishing
    where platform = v_post.platform and supported;
  if v_provider is null or v_provider not in ('instagram','meta')
    then return null; end if;
  if not exists (select 1 from public.platform_format_publishing pfp
      where pfp.platform = v_post.platform
        and pfp.content_format = v_asset.content_format
        and (pfp.media_type = v_post.media_type or pfp.media_type is null)
        and pfp.supported) then return null; end if;
  select count(*)::integer,
         max(case when v_provider = 'instagram' then credential_label
                  else meta_page_id end)
    into v_account_count, v_account
    from public.client_integrations
   where client_id = v_post.client_id and provider = v_provider
     and public.integration_state_eligible(status, token_expires_at)
     and credential_secret_id is not null;
  if v_account_count <> 1 or nullif(btrim(v_account), '') is null
    or not coalesce(public.integration_usable(v_post.client_id, v_provider), false)
    then return null; end if;
  if v_asset.content_format in ('carousel','story') then
    if exists (select 1 from public.client_media_frames f
      where f.asset_id = v_asset.id and
        (f.storage_path is null
         or f.storage_path not like v_post.client_id::text || '/%'
         or position('..' in f.storage_path) > 0)) then return null; end if;
    select coalesce(jsonb_agg(f.storage_path order by f.position), '[]'::jsonb)
      into v_paths from public.client_media_frames f where f.asset_id = v_asset.id;
    if jsonb_array_length(v_paths) < (case when v_asset.content_format = 'carousel' then 2 else 1 end)
      or jsonb_array_length(v_paths) > 10 then return null; end if;
  else
    if nullif(btrim(coalesce(v_asset.render_path, v_asset.storage_path)), '') is null
      or coalesce(v_asset.render_path, v_asset.storage_path)
        not like v_post.client_id::text || '/%'
      or position('..' in coalesce(v_asset.render_path, v_asset.storage_path)) > 0
      then return null; end if;
    v_paths := jsonb_build_array(coalesce(v_asset.render_path, v_asset.storage_path));
  end if;
  return jsonb_build_object(
    'client_id',v_post.client_id,'scheduled_post_id',v_post.id,
    'slot_id',v_slot.id,'campaign_id',v_campaign.id,
    'route_package_id',v_route.id,'route_package_version',v_route.version,
    'idea_id',v_idea.id,'brief_id',v_brief.id,'asset_id',v_asset.id,
    'platform',v_post.platform,'provider',v_provider,
    'account_ref',v_account,'scheduled_at',v_post.scheduled_at,
    'content_format',v_asset.content_format,'media_type',v_post.media_type,
    'source_paths',v_paths,
    'copy',jsonb_build_object(
      'caption',v_copy.caption,'hashtags',v_copy.hashtags,
      'alt_text',v_copy.alt_text,'link_url',v_copy.link_url,
      'first_comment',v_copy.first_comment),
    'rights',jsonb_build_object(
      'usage_rights',v_asset.usage_rights,
      'intake_source',v_asset.intake_source,
      'asset_human_approved_at',v_asset.human_approved_at));
end;
$$;

create or replace function public.organic_publication_claim_snapshot_v7(p_post_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_post public.scheduled_posts%rowtype;
  v_slot public.content_slots%rowtype;
  v_asset public.client_media_assets%rowtype;
  v_brief public.client_briefs%rowtype;
  v_idea public.client_ideas%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_route public.campaign_route_packages_v6%rowtype;
  v_copy public.post_copy_effective%rowtype;
  v_provider text;
  v_account text;
  v_account_count integer;
  v_paths jsonb;
begin
  select * into v_post from public.scheduled_posts where id = p_post_id;
  if not found or v_post.client_id is null or v_post.asset_id is null
    or v_post.platform is null or v_post.scheduled_at is null
    or v_post.channel is distinct from 'organic'::public.post_channel
    or (v_post.publication_status is distinct from 'scheduled'
      and v_post.publication_status is distinct from 'publishing')
    or v_post.published_at is not null
    then return null; end if;
  select * into v_asset from public.client_media_assets
    where id = v_post.asset_id and client_id = v_post.client_id;
  if not found or v_asset.review_status is distinct from 'approved'::public.review_status
    or v_asset.human_approved_at is null
    or (v_asset.media_type::text in ('image','text')
      and v_asset.content_format in ('single','carousel','story')
      and public.organic_creative_source_current_v8(p_post_id) is not true)
    or v_asset.content_format is null
    or v_post.media_type is distinct from v_asset.media_type then return null; end if;
  select * into v_brief from public.client_briefs
    where id = v_asset.brief_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_idea from public.client_ideas
    where id = v_brief.source_idea_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_campaign from public.client_campaigns
    where id = v_idea.campaign_id and client_id = v_post.client_id;
  if not found or not v_campaign.runs_organic
    or v_campaign.acquisition_mode not in ('organic','both')
    or v_idea.acquisition_route is distinct from 'organic' then return null; end if;
  select * into v_route from public.campaign_route_packages_v6
    where campaign_id = v_campaign.id and client_id = v_campaign.client_id
      and route = 'organic' order by version desc limit 1;
  if not found or v_route.plan_fingerprint is distinct from
      public.campaign_plan_fingerprint(v_campaign) then return null; end if;
  if (select count(*) from public.content_slots
      where scheduled_post_id = v_post.id) <> 1 then return null; end if;
  select * into v_slot from public.content_slots
    where scheduled_post_id = v_post.id;
  if v_slot.stage is distinct from 'scheduled'::public.slot_stage
    or (v_slot.client_id, v_slot.asset_id, v_slot.brief_id,
        v_slot.idea_id, v_slot.platform, v_slot.scheduled_at)
       is distinct from
       (v_post.client_id, v_asset.id, v_brief.id,
        v_idea.id, v_post.platform, v_post.scheduled_at)
    then return null; end if;
  select * into v_copy from public.post_copy_effective
    where scheduled_post_id = v_post.id and platform = v_post.platform;
  if not found or nullif(btrim(coalesce(v_copy.caption, '')), '') is null
    then return null; end if;
  select provider into v_provider from public.platform_publishing
    where platform = v_post.platform and supported;
  if v_provider is null or v_provider not in ('instagram','meta')
    then return null; end if;
  if not exists (select 1 from public.platform_format_publishing pfp
      where pfp.platform = v_post.platform
        and pfp.content_format = v_asset.content_format
        and (pfp.media_type = v_post.media_type or pfp.media_type is null)
        and pfp.supported) then return null; end if;
  select count(*)::integer,
         max(case when v_provider = 'instagram' then credential_label
                  else meta_page_id end)
    into v_account_count, v_account
    from public.client_integrations
   where client_id = v_post.client_id and provider = v_provider
     and public.integration_state_eligible(status, token_expires_at)
     and credential_secret_id is not null;
  if v_account_count <> 1 or nullif(btrim(v_account), '') is null
    or not coalesce(public.integration_usable(v_post.client_id, v_provider), false)
    then return null; end if;
  if v_asset.content_format in ('carousel','story') then
    if exists (select 1 from public.client_media_frames f
      where f.asset_id = v_asset.id and
        (f.storage_path is null
         or f.storage_path not like v_post.client_id::text || '/%'
         or position('..' in f.storage_path) > 0)) then return null; end if;
    select coalesce(jsonb_agg(f.storage_path order by f.position), '[]'::jsonb)
      into v_paths from public.client_media_frames f where f.asset_id = v_asset.id;
    if jsonb_array_length(v_paths) < (case when v_asset.content_format = 'carousel' then 2 else 1 end)
      or jsonb_array_length(v_paths) > 10 then return null; end if;
  else
    if nullif(btrim(coalesce(v_asset.render_path, v_asset.storage_path)), '') is null
      or coalesce(v_asset.render_path, v_asset.storage_path)
        not like v_post.client_id::text || '/%'
      or position('..' in coalesce(v_asset.render_path, v_asset.storage_path)) > 0
      then return null; end if;
    v_paths := jsonb_build_array(coalesce(v_asset.render_path, v_asset.storage_path));
  end if;
  return jsonb_build_object(
    'client_id',v_post.client_id,'scheduled_post_id',v_post.id,
    'slot_id',v_slot.id,'campaign_id',v_campaign.id,
    'route_package_id',v_route.id,'route_package_version',v_route.version,
    'idea_id',v_idea.id,'brief_id',v_brief.id,'asset_id',v_asset.id,
    'platform',v_post.platform,'provider',v_provider,
    'account_ref',v_account,'scheduled_at',v_post.scheduled_at,
    'content_format',v_asset.content_format,'media_type',v_post.media_type,
    'source_paths',v_paths,
    'copy',jsonb_build_object(
      'caption',v_copy.caption,'hashtags',v_copy.hashtags,
      'alt_text',v_copy.alt_text,'link_url',v_copy.link_url,
      'first_comment',v_copy.first_comment),
    'rights',jsonb_build_object(
      'usage_rights',v_asset.usage_rights,
      'intake_source',v_asset.intake_source,
      'asset_human_approved_at',v_asset.human_approved_at));
end;
$$;

select public.lock_down_definer_functions();
commit;
