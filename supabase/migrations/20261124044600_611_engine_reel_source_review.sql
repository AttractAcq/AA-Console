-- A recurring reel requires the finished render, exact current video seats,
-- the Engine slot decision, and a separate publication package decision.
-- Existing single and framed image/text packet hashes remain unchanged.
begin;
create or replace function public.engine_slot_exact_package_v6(p_slot_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare s public.content_slots%rowtype;
  a public.client_media_assets%rowtype;
  o storage.objects%rowtype;
  v_copy jsonb;
  v_account text;
  v_count integer;
  v_provider text;
  v_path text;
  v_frames jsonb;
  v_video_seats jsonb;
begin
  select * into s from public.content_slots where id=p_slot_id;
  if s.id is null or s.stage::text not in
    ('awaiting_approval','scheduled','published') or s.asset_id is null
    then return null; end if;
  select * into a from public.client_media_assets
    where id=s.asset_id and client_id=s.client_id;
  v_path:=coalesce(nullif(btrim(a.render_path),''),a.storage_path);
  if a.id is null or not (
      (a.media_type in ('image','text')
        and a.content_format in ('single','carousel','story'))
      or (a.media_type='video' and a.content_format='reel'))
    or s.format is distinct from a.content_format
    or (a.content_format in ('carousel','story') and a.render_path is not null)
    or (a.media_type='video' and (a.edit_stage is distinct from 'review_ready'
      or nullif(btrim(coalesce(a.render_path,'')),'') is null))
    or a.archived_at is not null
    or a.delivery_bytes_sha256 !~ '^[0-9a-f]{64}$'
    or nullif(btrim(coalesce(a.usage_rights,'')),'') is null
    or a.review_status not in ('pending','approved')
    or a.storage_path not like s.client_id::text||'/%'
    or v_path not like s.client_id::text||'/%'
    then return null; end if;
  select * into o from storage.objects
    where bucket_id='client-media' and name=v_path;
  if o.id is null then return null; end if;
  if a.content_format in ('carousel','story') then
    if public.framed_creative_evidence_current_v8(a.id) is not true
      or exists(select 1 from public.client_media_frames f
        where f.asset_id=a.id and (f.storage_path not like s.client_id::text||'/%'
          or position('..' in f.storage_path)>0)) then return null; end if;
    select jsonb_agg(jsonb_build_object(
      'frame_id',f.id,'position',f.position,'caption',f.caption,
      'storage_path',f.storage_path,'file_sha256',b.sha256,
      'file_bytes',b.file_bytes,'object_id',fo.id,
      'object_version',fo.version,'object_updated_at',fo.updated_at)
      order by f.position) into v_frames
    from public.client_media_frames f
    join public.creative_frame_bytes_v8 b on b.frame_id=f.id and b.asset_id=a.id
    join storage.objects fo on fo.bucket_id='client-media' and fo.name=f.storage_path
    where f.asset_id=a.id;
  end if;
  if a.media_type='video' then
    if public.video_signoff_current_v6(a.id,'owner') is not true
      or public.video_signoff_current_v6(a.id,'manager') is not true
      or (exists(select 1 from public.video_client_approval_requests r
          where r.asset_id=a.id)
        and public.video_signoff_current_v6(a.id,'client') is not true)
      then return null; end if;
    select jsonb_build_object(
      'owner_user_id',(select owner_user_id from public.content_approval_settings
        where singleton),
      'manager_user_id',public.active_video_approval_manager(a.client_id),
      'client_user_id',(select client_user_id from public.video_client_approval_requests
        where asset_id=a.id),
      'signoffs',(select jsonb_agg(jsonb_build_object(
        'role',sig.approval_role,'user_id',sig.user_id,
        'request_id',sig.approved_request_id,
        'content_hash',sig.approved_content_hash) order by sig.approval_role)
        from public.video_approval_signoffs sig where sig.asset_id=a.id))
      into v_video_seats;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',pc.id,'platform',pc.platform,'version',pc.version,
    'caption',pc.caption,'hashtags',pc.hashtags,'alt_text',pc.alt_text,
    'link_url',pc.link_url,'first_comment',pc.first_comment,
    'cta',pc.cta,'source',pc.source) order by pc.platform::text,pc.id),'[]'::jsonb)
    into v_copy from public.post_copy pc where pc.asset_id=a.id;
  if v_copy='[]'::jsonb or not exists(select 1 from public.post_copy pc
    where pc.asset_id=a.id and pc.platform=s.platform
      and nullif(btrim(coalesce(pc.caption,'')),'') is not null)
    then return null; end if;
  v_provider := case s.platform::text when 'facebook' then 'meta'
    when 'instagram' then 'instagram' else null end;
  if v_provider is null then return null; end if;
  select count(*)::integer,
    max(case when v_provider='meta' then i.meta_page_id
      else i.credential_label end)
    into v_count,v_account from public.client_integrations i
    where i.client_id=s.client_id and i.provider=v_provider
      and public.integration_state_eligible(i.status,i.token_expires_at);
  if v_count<>1 or nullif(btrim(coalesce(v_account,'')),'') is null
    then return null; end if;
  return jsonb_build_object(
    'client_id',s.client_id,
    'slot',jsonb_build_object('id',s.id,'asset_id',s.asset_id,
      'platform',s.platform,'scheduled_at',s.scheduled_at,
      'format',s.format,'idea_id',s.idea_id,'brief_id',s.brief_id,
      'attempts',s.attempts),
    'asset',jsonb_build_object('id',a.id,'client_id',a.client_id,
      'title',a.title,'media_type',a.media_type,'content_format',a.content_format,
      'storage_path',a.storage_path,'file_sha256',a.delivery_bytes_sha256,
      'usage_rights',a.usage_rights,'intake_source',a.intake_source,
      'brief_id',a.brief_id,'source_asset_id',a.source_asset_id)
      || case when nullif(btrim(a.render_path),'') is not null
        then jsonb_build_object('render_path',v_path) else '{}'::jsonb end
      || case when a.media_type='video'
        then jsonb_build_object('edit_stage',a.edit_stage) else '{}'::jsonb end,
    'storage',jsonb_build_object('bucket','client-media','object_id',o.id,
      'version',o.version,'updated_at',o.updated_at),
    'post_copy',v_copy,
    'provider',v_provider,'account_ref',v_account,
    'consequence','Approve this asset and create one scheduled organic post. Publication requires a separate exact-version decision.')
    || case when a.content_format in ('carousel','story')
      then jsonb_build_object('frames',v_frames)
      else '{}'::jsonb end
    || case when a.media_type='video'
      then jsonb_build_object('video_seats',v_video_seats)
      else '{}'::jsonb end;
end $$;

create or replace function public.decide_engine_slot_inbox_v6(
  p_slot_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare s public.content_slots%rowtype;
  r public.approval_requests_v6%rowtype;
  e public.approval_request_evidence_v6%rowtype;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A provisioned AAL2 human must decide the Engine slot.'
      using errcode='42501'; end if;
  if p_approved is null or (not p_approved
    and nullif(btrim(coalesce(p_reason,'')),'') is null) then
    raise exception 'A decision and rejection reason are required.'
      using errcode='22023'; end if;
  select * into s from public.content_slots where id=p_slot_id for update;
  if s.id is null or s.stage::text<>'awaiting_approval' then
    raise exception 'Engine slot is no longer awaiting review.'
      using errcode='23514'; end if;
  select * into r from public.approval_requests_v6
    where id=p_request_id and client_id=s.client_id
      and source_system='aa_console' and source_kind='engine_slot'
      and source_id=s.id::text for update;
  if r.id is null or not public.can_review_approval_request_v6(s.client_id,r.owner_role)
    then raise exception 'The exact Engine request or reviewer is unavailable.'
      using errcode='42501'; end if;
  -- Freeze the rows consulted by the live package check through the source
  -- transition; a concurrent edit cannot change the reviewed bytes or copy.
  perform 1 from public.client_media_assets where id=s.asset_id for update;
  perform 1 from storage.objects o join public.client_media_assets a
    on o.bucket_id='client-media'
      and o.name=coalesce(nullif(btrim(a.render_path),''),a.storage_path)
    where a.id=s.asset_id for share of o;
  perform 1 from public.client_media_frames f
    where f.asset_id=s.asset_id for share;
  perform 1 from public.creative_frame_bytes_v8 b
    where b.asset_id=s.asset_id for share;
  perform 1 from storage.objects o join public.client_media_frames f
    on o.bucket_id='client-media' and o.name=f.storage_path
    where f.asset_id=s.asset_id for share of o;
  perform 1 from public.video_approval_signoffs v
    where v.asset_id=s.asset_id for share;
  perform 1 from public.video_client_approval_requests v
    where v.asset_id=s.asset_id for share;
  perform 1 from public.content_approval_settings v where v.singleton for share;
  perform 1 from public.client_assignments ca
    where ca.client_id=s.client_id and ca.ended_at is null for share;
  perform 1 from public.post_copy where asset_id=s.asset_id for share;
  perform 1 from public.client_integrations i
    where i.client_id=s.client_id and i.provider in ('meta','instagram')
    for share;
  select * into e from public.approval_request_evidence_v6
    where request_id=r.id;
  if e.id is null or public.engine_slot_exact_source_state_v6(r.id)<>'pending'
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=r.id and i.status='pending' and i.preview_blocker is null)
    then raise exception 'Review the current exact Engine package in Approval Inbox.'
      using errcode='23514'; end if;
  perform public.record_approval_decision_v6(r.id,
    case when p_approved then 'approved' else 'rejected' end,
    e.artifact_hash,
    case when p_approved then 'engine_slot:' else 'engine_slot_rejection:' end
      ||r.source_version,p_reason);
  if p_approved then
    perform public.approve_slot(s.id);
  else
    perform public.reject_slot(s.id,p_reason);
  end if;
  return s.id;
end $$;

create or replace function public.engine_slot_exact_source_current_v8(p_post_id uuid)
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
    or not ((a.media_type in ('image','text')
      and a.content_format in ('single','carousel','story'))
      or (a.media_type='video' and a.content_format='reel'))
    then return false; end if;
  -- The Engine owns a different exact AAL2 source decision. It may authorize
  -- only its own linked post; a human timestamp alone never qualifies.
  if a.content_format not in ('single','carousel','story','reel') then return false; end if;
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
revoke all on function public.engine_slot_exact_source_current_v8(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.engine_slot_exact_source_current_v8(uuid)
  to authenticated,service_role;

create or replace function public.organic_creative_source_current_v8(p_post_id uuid)
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
    or not ((a.media_type in ('image','text')
      and a.content_format in ('single','carousel','story'))
      or (a.media_type='video' and a.content_format='reel'))
    then return false; end if;
  if public.ordinary_media_signoff_current_v6(a.id) then return true; end if;
  -- The Engine owns a different exact AAL2 source decision. It may authorize
  -- only its own linked post; a human timestamp alone never qualifies.
  if a.content_format not in ('single','carousel','story','reel') then return false; end if;
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
    or (v_asset.media_type::text='video' and
      (public.video_signoff_current_v6(v_asset.id,'owner') is not true
        or public.video_signoff_current_v6(v_asset.id,'manager') is not true
        or (exists(select 1 from public.video_client_approval_requests r
            where r.asset_id=v_asset.id)
          and public.video_signoff_current_v6(v_asset.id,'client') is not true)))
    or v_asset.content_format is null
    or v_post.media_type is distinct from v_asset.media_type then return null; end if;
  select * into v_brief from public.client_briefs
    where id = v_asset.brief_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_idea from public.client_ideas
    where id = v_brief.source_idea_id and client_id = v_post.client_id;
  if not found then return null; end if;
  if v_idea.campaign_id is not null then
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
  end if;
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
  -- The recurring Engine has no commercial campaign. Its own exact AAL2
  -- source decision and slot-bound idea are the route identity instead.
  if v_idea.campaign_id is null and (
    v_idea.slot_id is distinct from v_slot.id
    or (v_idea.acquisition_route is not null
      and v_idea.acquisition_route <> 'organic')
    or not ((v_asset.media_type::text in ('image','text')
        and v_asset.content_format in ('single','carousel','story'))
      or (v_asset.media_type::text='video' and v_asset.content_format='reel'))
    or public.engine_slot_exact_source_current_v8(p_post_id) is not true
  ) then return null; end if;
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
      'asset_human_approved_at',v_asset.human_approved_at))
    || case when v_idea.campaign_id is null
      then jsonb_build_object('source_mode','recurring_engine')
      else '{}'::jsonb end;
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
    or (v_asset.media_type::text='video' and
      (public.video_signoff_current_v6(v_asset.id,'owner') is not true
        or public.video_signoff_current_v6(v_asset.id,'manager') is not true
        or (exists(select 1 from public.video_client_approval_requests r
            where r.asset_id=v_asset.id)
          and public.video_signoff_current_v6(v_asset.id,'client') is not true)))
    or v_asset.content_format is null
    or v_post.media_type is distinct from v_asset.media_type then return null; end if;
  select * into v_brief from public.client_briefs
    where id = v_asset.brief_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_idea from public.client_ideas
    where id = v_brief.source_idea_id and client_id = v_post.client_id;
  if not found then return null; end if;
  if v_idea.campaign_id is not null then
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
  end if;
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
  -- The recurring Engine has no commercial campaign. Its own exact AAL2
  -- source decision and slot-bound idea are the route identity instead.
  if v_idea.campaign_id is null and (
    v_idea.slot_id is distinct from v_slot.id
    or (v_idea.acquisition_route is not null
      and v_idea.acquisition_route <> 'organic')
    or not ((v_asset.media_type::text in ('image','text')
        and v_asset.content_format in ('single','carousel','story'))
      or (v_asset.media_type::text='video' and v_asset.content_format='reel'))
    or public.engine_slot_exact_source_current_v8(p_post_id) is not true
  ) then return null; end if;
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
      'asset_human_approved_at',v_asset.human_approved_at))
    || case when v_idea.campaign_id is null
      then jsonb_build_object('source_mode','recurring_engine')
      else '{}'::jsonb end;
end;
$$;

create or replace view public.publish_due with (security_invoker = true) as
select
  sp.id as post_id, sp.client_id, c.name as client_name, sp.platform,
  sp.scheduled_at, sp.media_type, sp.publication_status,
  sp.publish_attempts, sp.publish_claimed_at,
  a.id as asset_id, a.title as asset_title,
  coalesce(a.render_path, a.storage_path) as media_path,
  a.human_approved_at, pce.caption, pce.hashtags, pce.alt_text,
  pce.link_url, pce.first_comment, pp.provider,
  pp.supported as platform_supported,
  case
    when sp.asset_id is null or a.id is null then 'The asset is gone. This post can never be published.'
    when sp.client_id is null or a.client_id is distinct from sp.client_id
      then 'The scheduled post and asset belong to different clients.'
    when sp.channel is distinct from 'organic'::public.post_channel
      then 'Paid posts use the Ads Studio route, not the organic publisher.'
    when b.id is null or b.client_id is distinct from sp.client_id
      then 'The asset has no verified brief for this client.'
    when i.id is null or i.client_id is distinct from sp.client_id
      then 'The brief has no verified campaign idea for this client.'
    when i.campaign_id is not null and
      (ca.id is null or ca.client_id is distinct from sp.client_id)
      then 'The idea has no verified campaign for this client.'
    when i.campaign_id is null and
      (not ((a.media_type::text in ('image','text')
          and a.content_format in ('single','carousel','story'))
        or (a.media_type::text='video' and a.content_format='reel'))
       or i.acquisition_route = 'paid')
      then 'This recurring Engine slot lacks a supported exact single-file source decision.'
    when i.campaign_id is not null and ca.acquisition_mode = 'paid'
      then 'This asset belongs to a paid campaign and cannot use organic publishing.'
    when i.campaign_id is not null and
      (i.acquisition_route is distinct from 'organic'
       or not ca.runs_organic or ca.acquisition_mode not in ('organic','both'))
      then 'This campaign has no explicit organic publishing route.'
    when coalesce(sr.slot_count, 0) = 0
      then 'This calendar entry has no approved Engine slot. An exact-version publication approval must be connected through Approval Inbox before it can publish.'
    when sr.slot_count <> 1 or not coalesce(sr.matches, false)
      then 'The Engine slot and asset campaign lineage do not match this post.'
    when a.review_status is distinct from 'approved'::public.review_status
      then 'The asset approval was revoked.'
    when a.human_approved_at is null then 'Nobody has approved the asset.'
    when a.media_type::text='video' and
      (public.video_signoff_current_v6(a.id,'owner') is not true
        or public.video_signoff_current_v6(a.id,'manager') is not true
        or (exists(select 1 from public.video_client_approval_requests r
            where r.asset_id=a.id)
          and public.video_signoff_current_v6(a.id,'client') is not true))
      then 'A current exact video owner, SMM or requested client seat is missing.'
    when i.campaign_id is null
      and public.engine_slot_exact_source_current_v8(sp.id) is not true
      then 'The exact Engine slot source decision is missing or stale. Request a new Engine review in Approval Inbox.'
    when a.media_type::text in ('image','text')
      and a.content_format in ('single','carousel','story')
      and public.organic_creative_source_current_v8(sp.id) is not true
      then 'The exact creative source signoff is missing or stale. Request a new source review in Approval Inbox.'
    when sp.platform is null then 'The post has no platform.'
    when pp.platform is null or not pp.supported
      then 'There is no adapter for ' || coalesce(sp.platform::text, 'this platform') || '.'
    when pfp.platform is not null and not pfp.supported and pfp.media_type is not null
      then 'A ' || a.content_format::text || ' made of ' || sp.media_type::text
           || ' cannot be sent to ' || sp.platform::text || ' yet.'
    when pfp.platform is null or not pfp.supported
      then 'A ' || a.content_format::text || ' cannot be sent to ' || sp.platform::text
           || ' yet. Publishing it now would post the first frame on its own and record it as published.'
    when a.content_format = 'carousel' and coalesce(fr.frames, 0) < 2
      then 'A carousel needs at least two frames. This one has '
           || coalesce(fr.frames, 0)::text || ' on file.'
    when a.content_format = 'carousel' and fr.frames > 10
      then 'This carousel has ' || fr.frames::text || ' frames. Ten is the most either platform takes.'
    when a.content_format = 'story' and coalesce(fr.frames, 0) < 1
      then 'This story has no frames on file.'
    when not coalesce(ces.publishing_enabled, false)
      then 'Publishing is off for this client.'
    when not public.integration_usable(sp.client_id, pp.provider)
      then 'No usable ' || pp.provider || ' integration for this client.'
    when pce.caption is null or btrim(pce.caption) = ''
      then 'There is no caption for ' || sp.platform::text || '.'
    when sp.scheduled_at > now() then 'Not due yet.'
    when not exists (select 1 from public.organic_publication_packages_v6 p
      where p.scheduled_post_id = sp.id)
      then 'No immutable outgoing media-byte package exists for this post. Approval Inbox must review the exact destination, account, copy, time and rights.'
    when public.organic_publication_scheduled_authority_v8(sp.id) then null
    else 'The frozen package has no current exact AAL2 approval, route or rights; publication remains held.'
  end as blocker,
  a.content_format, coalesce(pfp.supported, false) as format_supported
from public.scheduled_posts sp
left join public.clients c on c.id = sp.client_id
left join public.client_media_assets a on a.id = sp.asset_id
left join public.client_briefs b on b.id = a.brief_id
left join public.client_ideas i on i.id = b.source_idea_id
left join public.client_campaigns ca on ca.id = i.campaign_id
left join lateral (
  select count(*)::int as slot_count,
         bool_and(s.stage = 'scheduled' and s.client_id = sp.client_id
           and s.asset_id = sp.asset_id and s.brief_id = b.id
           and s.idea_id = i.id and (i.campaign_id is not null or i.slot_id = s.id)
           and s.platform = sp.platform
           and s.scheduled_at = sp.scheduled_at) as matches
    from public.content_slots s where s.scheduled_post_id = sp.id
) sr on true
left join public.client_engine_settings ces on ces.client_id = sp.client_id
left join public.platform_publishing pp on pp.platform = sp.platform
left join lateral (
  select x.platform, x.supported, x.media_type
    from public.platform_format_publishing x
   where x.platform = sp.platform and x.content_format = a.content_format
     and (x.media_type is null or x.media_type = sp.media_type)
   order by x.media_type nulls last limit 1
) pfp on true
left join lateral (
  select count(*)::int as frames from public.client_media_frames f
   where f.asset_id = a.id
) fr on true
left join public.post_copy_effective pce
  on pce.scheduled_post_id = sp.id and pce.platform = sp.platform
where sp.publication_status in ('scheduled','publishing')
  and sp.published_at is null;
comment on view public.publish_due is
  'A null blocker means the exact scheduled package has current AAL2 approval; the publisher still rechecks after claiming and runs provider preflight before any write.';
grant select on public.publish_due to authenticated;




select public.lock_down_definer_functions();
commit;
