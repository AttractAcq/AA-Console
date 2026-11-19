-- Release the organic claim only for a current exact AAL2 package.
-- Runtime still requires its separate PUBLISH_ENABLED switch, frozen-byte
-- verification, live Meta preflight and final prewrite before external effect.
-- No historical scheduled post is backfilled or auto-approved.
begin;
create function public.organic_publication_scheduled_authority_v8(p_post_id uuid)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare
  p public.scheduled_posts%rowtype;
  pkg public.organic_publication_packages_v6%rowtype;
  req public.approval_requests_v6%rowtype;
  dec public.approval_decision_events_v6%rowtype;
  snap jsonb;
  source_hash text;
begin
  select * into p from public.scheduled_posts where id=p_post_id;
  if not found or p.publication_status is distinct from 'scheduled'
    or p.published_at is not null or p.scheduled_at>clock_timestamp()
    or p.channel is distinct from 'organic'::public.post_channel
    or (auth.role() is distinct from 'service_role' and
      (auth.role() is distinct from 'authenticated' or
        not coalesce(public.can_access_client(p.client_id),false)))
    then return false; end if;
  if not exists(select 1 from public.client_engine_settings s
      where s.client_id=p.client_id and s.publishing_enabled) then return false; end if;
  snap:=public.organic_publication_source_snapshot_v6(p_post_id);
  if snap is null then return false; end if;
  source_hash:=encode(sha256(convert_to(snap::text,'UTF8')),'hex');
  if (select count(*) from public.organic_publication_packages_v6 x
      where x.scheduled_post_id=p.id and x.client_id=p.client_id
        and x.source_snapshot_hash=source_hash)<>1 then return false; end if;
  select * into pkg from public.organic_publication_packages_v6 x
    where x.scheduled_post_id=p.id and x.client_id=p.client_id
      and x.source_snapshot_hash=source_hash;
  if pkg.manifest is distinct from (snap || jsonb_build_object(
      'media',pkg.manifest->'media','provider_copy',pkg.manifest->'provider_copy'))
    or pkg.artifact_hash is distinct from
      encode(sha256(convert_to(pkg.manifest::text,'UTF8')),'hex')
    or coalesce(pkg.manifest->'rights'->>'usage_rights','')
      not in ('client_owned','licensed','agency_owned')
    or jsonb_typeof(pkg.manifest->'media') is distinct from 'array'
    or jsonb_array_length(pkg.manifest->'media')<1
    or exists(select 1 from jsonb_array_elements(pkg.manifest->'media') item
      where item->>'frozen_bucket' is distinct from 'publication-media'
        or not exists(select 1 from storage.objects o
          where o.bucket_id='publication-media' and o.name=item->>'frozen_path'))
    then return false; end if;
  if (select count(*) from public.approval_requests_v6 q
      where q.source_system='aa_console' and q.source_kind='organic_publication'
        and q.source_id=pkg.id::text)<>1 then return false; end if;
  select * into req from public.approval_requests_v6 q
    where q.source_system='aa_console' and q.source_kind='organic_publication'
      and q.source_id=pkg.id::text;
  if req.client_id is distinct from pkg.client_id
    or req.owner_role is distinct from 'client_media_reviewer'
    or req.requester_kind is distinct from 'service'
    or req.requester_ref is distinct from
      ('organic_publication_packages_v6:'||pkg.id::text)
    or req.expires_at is null or req.expires_at<=clock_timestamp()
    or req.source_version is distinct from pkg.artifact_hash
    or req.artifact_hash is distinct from pkg.artifact_hash
    or req.preview is distinct from pkg.manifest
    or req.destination is distinct from ('organic:'||(pkg.manifest->>'platform'))
    or req.account_ref is distinct from (pkg.manifest->>'account_ref')
    or req.scope is distinct from jsonb_build_object(
      'client_id',pkg.client_id,'scheduled_post_id',pkg.scheduled_post_id,
      'slot_id',pkg.slot_id,'source_snapshot_hash',pkg.source_snapshot_hash)
    or exists(select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id=req.id)
    or exists(select 1 from public.approval_request_evidence_v6 e
      where e.request_id=req.id and
        (e.artifact_hash is distinct from pkg.artifact_hash
          or e.preview is distinct from pkg.manifest
          or e.destination is distinct from req.destination
          or e.account_ref is distinct from req.account_ref
          or e.scope is distinct from req.scope))
    then return false; end if;
  select * into dec from public.approval_decision_events_v6 d
    where d.request_id=req.id order by d.event_order desc limit 1;
  return dec.request_id is not null and dec.decision='approved'
    and dec.actor_aal='aal2' and dec.artifact_hash=pkg.artifact_hash
    and dec.source_decision_ref='organic_publication_packages_v6:'||pkg.id::text;
end $$;

create or replace function public.require_organic_publication_prewrite_v6(p_post_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare
  v_post public.scheduled_posts%rowtype;
  v_package public.organic_publication_packages_v6%rowtype;
  v_request public.approval_requests_v6%rowtype;
  v_decision public.approval_decision_events_v6%rowtype;
  v_snapshot jsonb;
  v_source_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the publisher may verify publication authority.'
      using errcode='42501';
  end if;
  select * into v_post from public.scheduled_posts
    where id=p_post_id for share;
  if not found or v_post.publication_status is distinct from 'publishing'
    or v_post.published_at is not null or v_post.publish_claimed_at is null
    or v_post.publish_claimed_at < clock_timestamp()-interval '15 minutes'
    or v_post.publish_claimed_at > clock_timestamp()+interval '1 minute'
    or v_post.channel is distinct from 'organic'::public.post_channel then
    raise exception 'This post has no current organic publication claim.'
      using errcode='23514';
  end if;
  if not exists (select 1 from public.client_engine_settings s
      where s.client_id=v_post.client_id and s.publishing_enabled) then
    raise exception 'Client publication switch is off.' using errcode='23514';
  end if;
  v_snapshot:=public.organic_publication_claim_snapshot_v7(p_post_id);
  if v_snapshot is null then
    raise exception 'The claimed post no longer matches its organic source.'
      using errcode='23514';
  end if;
  v_source_hash:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  select * into v_package from public.organic_publication_packages_v6 p
    where p.scheduled_post_id=p_post_id
      and p.client_id=v_post.client_id
      and p.source_snapshot_hash=v_source_hash;
  if not found or v_package.manifest is distinct from
      (v_snapshot || jsonb_build_object(
        'media',v_package.manifest->'media',
        'provider_copy',v_package.manifest->'provider_copy'))
    or v_package.artifact_hash is distinct from
      encode(sha256(convert_to(v_package.manifest::text,'UTF8')),'hex')
    or coalesce(v_package.manifest->'rights'->>'usage_rights','')
      not in ('client_owned','licensed','agency_owned') then
    raise exception 'The frozen package is missing, stale or unlicensed.'
      using errcode='23514';
  end if;
  if jsonb_typeof(v_package.manifest->'media') is distinct from 'array'
    or jsonb_array_length(v_package.manifest->'media') < 1
    or exists (select 1
      from jsonb_array_elements(v_package.manifest->'media') item
      where item->>'frozen_bucket' is distinct from 'publication-media'
        or not exists(select 1 from storage.objects o
          where o.bucket_id='publication-media'
            and o.name=item->>'frozen_path')) then
    raise exception 'Frozen publication media is unavailable.' using errcode='23514';
  end if;
  if (select count(*) from public.approval_requests_v6 q
      where q.source_system='aa_console'
        and q.source_kind='organic_publication'
        and q.source_id=v_package.id::text) <> 1 then
    raise exception 'The exact publication review request is missing or ambiguous.'
      using errcode='23514';
  end if;
  select * into v_request from public.approval_requests_v6 q
    where q.source_system='aa_console'
      and q.source_kind='organic_publication'
      and q.source_id=v_package.id::text;
  if v_request.client_id is distinct from v_package.client_id
    or v_request.owner_role is distinct from 'client_media_reviewer'
    or v_request.requester_kind is distinct from 'service'
    or v_request.requester_ref is distinct from
      ('organic_publication_packages_v6:'||v_package.id::text)
    or v_request.expires_at is null
    or v_request.expires_at <= clock_timestamp()
    or v_request.source_version is distinct from v_package.artifact_hash
    or v_request.artifact_hash is distinct from v_package.artifact_hash
    or v_request.preview is distinct from v_package.manifest
    or v_request.destination is distinct from
      ('organic:'||(v_package.manifest->>'platform'))
    or v_request.account_ref is distinct from
      (v_package.manifest->>'account_ref')
    or v_request.scope is distinct from jsonb_build_object(
      'client_id',v_package.client_id,
      'scheduled_post_id',v_package.scheduled_post_id,
      'slot_id',v_package.slot_id,
      'source_snapshot_hash',v_package.source_snapshot_hash) then
    raise exception 'The exact publication review is stale or expired.'
      using errcode='23514';
  end if;
  if exists (select 1 from public.approval_request_evidence_v6 e
      where e.request_id=v_request.id and
        (e.artifact_hash is distinct from v_package.artifact_hash
          or e.preview is distinct from v_package.manifest
          or e.destination is distinct from v_request.destination
          or e.account_ref is distinct from v_request.account_ref
          or e.scope is distinct from v_request.scope)) then
    raise exception 'The publication review evidence changed.'
      using errcode='23514';
  end if;
  select * into v_decision from public.approval_decision_events_v6 d
    where d.request_id=v_request.id order by d.event_order desc limit 1;
  if exists (select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id=v_request.id) then
    raise exception 'The publication approval was invalidated.'
      using errcode='42501';
  end if;
  if not found or v_decision.decision is distinct from 'approved'
    or v_decision.actor_aal is distinct from 'aal2'
    or v_decision.artifact_hash is distinct from v_package.artifact_hash
    or v_decision.source_decision_ref is distinct from
      ('organic_publication_packages_v6:'||v_package.id::text) then
    raise exception 'Exact AAL2 publication approval is unavailable.'
      using errcode='42501';
  end if;
  return jsonb_build_object('artifact_hash',v_package.artifact_hash,
    'manifest',v_package.manifest);
end $$;
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
    when ca.id is null or ca.client_id is distinct from sp.client_id
      then 'The idea has no verified campaign for this client.'
    when ca.acquisition_mode = 'paid'
      then 'This asset belongs to a paid campaign and cannot use organic publishing.'
    when i.acquisition_route is distinct from 'organic'
      or not ca.runs_organic or ca.acquisition_mode not in ('organic','both')
      then 'This campaign has no explicit organic publishing route.'
    when coalesce(sr.slot_count, 0) = 0
      then 'This calendar entry has no approved Engine slot. An exact-version publication approval must be connected through Approval Inbox before it can publish.'
    when sr.slot_count <> 1 or not coalesce(sr.matches, false)
      then 'The Engine slot and asset campaign lineage do not match this post.'
    when a.review_status is distinct from 'approved'::public.review_status
      then 'The asset approval was revoked.'
    when a.human_approved_at is null then 'Nobody has approved the asset.'
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
           and s.idea_id = i.id and s.platform = sp.platform
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
create or replace function public.claim_posts_for_publishing(p_limit integer default 5)
returns table (post_id uuid, client_id uuid, platform public.post_platform,
  provider text, media_type public.media_type, media_path text, asset_id uuid,
  caption text, hashtags text[], alt_text text, link_url text,
  first_comment text, scheduled_at timestamptz, attempt integer,
  content_format public.content_format, frame_paths text[])
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare
  candidate record;
  returned integer:=0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Posts are claimed by the publisher.' using errcode='42501';
  end if;
  if p_limit is null or p_limit<1 or p_limit>50 then
    raise exception 'Claim between 1 and 50 posts at a time.' using errcode='22023';
  end if;
  for candidate in
    select sp.id from public.scheduled_posts sp
    where sp.publication_status='scheduled' and sp.published_at is null
      and sp.channel='organic'::public.post_channel
      and sp.scheduled_at<=clock_timestamp()
    order by sp.scheduled_at,sp.id
    for update of sp skip locked
  loop
    if not public.organic_publication_scheduled_authority_v8(candidate.id) then
      continue;
    end if;
    begin
      update public.scheduled_posts sp
        set publication_status='publishing',publish_claimed_at=clock_timestamp(),
          publish_attempts=sp.publish_attempts+1,updated_at=clock_timestamp()
        where sp.id=candidate.id and sp.publication_status='scheduled';
      if not found then continue; end if;
      -- A failed final check rolls back this row's update via the exception
      -- subtransaction. An invalid first candidate cannot block later ones.
      perform public.require_organic_publication_prewrite_v6(candidate.id);
      return query select sp.id,sp.client_id,sp.platform,pp.provider,
        sp.media_type,coalesce(a.render_path,a.storage_path),sp.asset_id,
        c.caption,c.hashtags,c.alt_text,c.link_url,c.first_comment,
        sp.scheduled_at,sp.publish_attempts,a.content_format,
        (select array_agg(f.storage_path order by f.position)
          from public.client_media_frames f where f.asset_id=a.id)
        from public.scheduled_posts sp
        join public.client_media_assets a on a.id=sp.asset_id
          and a.client_id=sp.client_id
        join public.post_copy_effective c on c.scheduled_post_id=sp.id
          and c.platform=sp.platform
        join public.platform_publishing pp on pp.platform=sp.platform
        where sp.id=candidate.id;
      returned:=returned+1;
      if returned>=p_limit then exit; end if;
    exception when check_violation or insufficient_privilege then
      -- Exact approval, route, switch or package failed after the lease.
      -- The row remains scheduled and is not returned to the publisher.
      continue;
    end;
  end loop;
end $$;

revoke all on function public.organic_publication_scheduled_authority_v8(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.organic_publication_scheduled_authority_v8(uuid)
  to authenticated,service_role;
revoke all on function public.require_organic_publication_prewrite_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.require_organic_publication_prewrite_v6(uuid)
  to service_role;
revoke all on function public.claim_posts_for_publishing(integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_posts_for_publishing(integer)
  to service_role;
comment on function public.claim_posts_for_publishing(integer) is
  'Lease only current exact-AAL2 organic packages; after claiming, recheck the frozen package and roll back a failed individual lease.';
select public.lock_down_definer_functions();
commit;
