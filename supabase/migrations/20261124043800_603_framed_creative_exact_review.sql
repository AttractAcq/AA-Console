-- Bind every image/text frame to one ordinary-media Inbox decision. Video
-- keeps its assigned-seat route; Engine-owned slots keep their own gate.
begin;

create function public.framed_creative_evidence_current_v8(p_asset_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public,storage as $$
declare a public.client_media_assets%rowtype;
  frame_count integer;
begin
  select * into a from public.client_media_assets where id=p_asset_id;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and (a.id is null
      or not public.can_access_client(a.client_id))) then return false; end if;
  if a.id is null or a.media_type not in ('image','text')
    or a.content_format not in ('carousel','story') or a.render_path is not null
    or a.delivery_bytes_sha256 is null then return false; end if;
  select count(*) into frame_count from public.client_media_frames f where f.asset_id=a.id;
  if frame_count<2 or (select f.storage_path from public.client_media_frames f
    where f.asset_id=a.id and f.position=1) is distinct from a.storage_path
    or (select count(distinct f.storage_path) from public.client_media_frames f
      where f.asset_id=a.id)<>frame_count
    or exists(select 1 from (
      select f.position,row_number() over(order by f.position) as expected
      from public.client_media_frames f where f.asset_id=a.id
    ) numbered where numbered.position<>numbered.expected)
    then return false; end if;
  if exists(select 1 from public.client_media_frames f
    left join public.creative_frame_bytes_v8 b on b.frame_id=f.id and b.asset_id=a.id
    left join storage.objects o on o.bucket_id='client-media' and o.name=f.storage_path
    where f.asset_id=a.id and (b.frame_id is null or o.id is null
      or b.storage_path is distinct from f.storage_path
      or b.object_id is distinct from o.id
      or b.object_version is distinct from o.version
      or b.object_updated_at is distinct from o.updated_at
      or b.sha256 !~ '^[0-9a-f]{64}$' or b.file_bytes<=0
      or (f.position=1 and b.sha256 is distinct from a.delivery_bytes_sha256)))
    then return false; end if;
  return true;
end $$;

create or replace function public.ordinary_media_review_preview_v6(
  p_review public.ordinary_media_review_requests_v6)
returns jsonb language sql stable security definer
set search_path=pg_catalog,public,storage as $$
  select jsonb_build_object(
    'client_id',p_review.client_id,'asset_id',a.id,
    'request_token',p_review.request_token,
    'asset',jsonb_build_object(
      'id',a.id,'client_id',a.client_id,'brief_id',a.brief_id,
      'source_asset_id',a.source_asset_id,'title',a.title,
      'media_type',a.media_type,'content_format',a.content_format,
      'storage_path',a.storage_path,'render_path',a.render_path,
      'file_sha256',a.delivery_bytes_sha256,
      'usage_rights',a.usage_rights,'intake_source',a.intake_source,
      'edit_stage',a.edit_stage,'archived_at',a.archived_at),
    'storage',jsonb_build_object('object_id',o.id,'version',o.version,
      'updated_at',o.updated_at,'bucket','client-media'),
    'consequence','Human source approval of this exact image or text file; publication requires a separate destination decision')
    || case when a.content_format in ('carousel','story') then jsonb_build_object(
      'consequence','Human source approval of every ordered frame; publication requires a separate destination decision',
      'frames',(select jsonb_agg(jsonb_build_object(
        'frame_id',f.id,'position',f.position,'caption',f.caption,
        'storage_path',f.storage_path,'file_sha256',b.sha256,
        'file_bytes',b.file_bytes,'object_id',o_frame.id,
        'object_version',o_frame.version,'object_updated_at',o_frame.updated_at)
        order by f.position)
        from public.client_media_frames f
        left join public.creative_frame_bytes_v8 b on b.frame_id=f.id and b.asset_id=a.id
        left join storage.objects o_frame on o_frame.bucket_id='client-media'
          and o_frame.name=f.storage_path
        where f.asset_id=a.id))
      else '{}'::jsonb end
  from public.client_media_assets a
  join storage.objects o on o.bucket_id='client-media' and o.name=a.storage_path
  where a.id=p_review.asset_id and a.client_id=p_review.client_id
    and a.render_path is null;
$$;

create or replace function public.ordinary_media_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public,storage set timezone='UTC' as $$
declare r public.approval_requests_v6%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  a public.client_media_assets%rowtype;
  s public.ordinary_media_signoffs_v6%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'ordinary_media'
    or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where id=r.source_id::uuid and client_id=r.client_id and canonical_request_id=r.id;
  if q.id is null then return 'cancelled'; end if;
  select * into a from public.client_media_assets
    where id=q.asset_id and client_id=q.client_id;
  if a.id is null then return 'cancelled'; end if;
  h:=public.ordinary_media_review_hash_v6(q);
  if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
    or r.source_version is distinct from h||':'||q.request_token::text
    or r.preview is distinct from public.ordinary_media_review_preview_v6(q)
    or r.scope is distinct from public.ordinary_media_review_scope_v6(q)
    or r.destination is distinct from 'creative_source:'||a.id::text
    then return 'superseded'; end if;
  if a.media_type not in ('image','text') or a.content_format not in ('single','carousel','story')
    or a.render_path is not null or a.edit_stage<>'review_ready'
    or a.archived_at is not null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null
    or (a.content_format<>'single' and not public.framed_creative_evidence_current_v8(a.id)) or exists(select 1 from public.content_slots cs
      where cs.asset_id=a.id and cs.stage='awaiting_approval')
    then return 'source_held'; end if;
  if exists(select 1 from public.ordinary_media_review_requests_v6 newer
    where newer.asset_id=a.id and (newer.created_at,newer.id)>(q.created_at,q.id))
    then return 'source_held'; end if;
  select * into s from public.ordinary_media_signoffs_v6
    where approved_request_id=r.id and asset_id=a.id and client_id=a.client_id;
  if a.human_approved_at is not null then
    if s.id is not null and s.approved_hash=h then return 'source_decided'; end if;
    return 'source_held';
  end if;
  if s.id is not null and s.approved_hash<>h then return 'source_held'; end if;
  if a.review_status not in ('pending','approved') then return 'source_held'; end if;
  return 'pending';
end $$;

create or replace function public.guard_ordinary_media_human_approval_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare s public.ordinary_media_signoffs_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
begin
  if new.human_approved_at is null
    or new.media_type not in ('image','text') or new.content_format not in ('single','carousel','story')
    or exists(select 1 from public.content_slots cs
      where cs.asset_id=new.id and cs.stage='awaiting_approval')
    then return new; end if;
  select * into s from public.ordinary_media_signoffs_v6
    where asset_id=new.id order by approved_at desc,id desc limit 1;
  select * into r from public.approval_requests_v6
    where id=s.approved_request_id and client_id=new.client_id
      and source_system='aa_console' and source_kind='ordinary_media';
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  if s.id is null or r.id is null or s.approved_by is distinct from auth.uid()
    or d.decision is distinct from 'approved' or d.actor_aal<>'aal2'
    or d.actor_id is distinct from auth.uid()
    or d.artifact_hash is distinct from s.approved_hash
    or public.ordinary_media_review_source_state_v6(r.id)<>'pending'
    then raise exception 'Approve this exact creative in Approval Inbox.'
      using errcode='42501'; end if;
  return new;
end $$;

create or replace function public.ordinary_media_signoff_current_v6(p_asset_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public,storage set timezone='UTC' as $$
declare a public.client_media_assets%rowtype;
  s public.ordinary_media_signoffs_v6%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if auth.role() not in ('authenticated','service_role') then return false; end if;
  select * into a from public.client_media_assets where id=p_asset_id;
  if a.id is null or (auth.role()='authenticated'
    and not public.can_access_client(a.client_id)) then return false; end if;
  if a.media_type not in ('image','text') or a.content_format not in ('single','carousel','story')
    or a.render_path is not null or a.edit_stage<>'review_ready'
    or a.archived_at is not null or a.review_status<>'approved'
    or a.human_approved_at is null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null
    or (a.content_format<>'single' and not public.framed_creative_evidence_current_v8(a.id)) then return false; end if;
  select * into s from public.ordinary_media_signoffs_v6
    where asset_id=a.id and client_id=a.client_id
    order by approved_at desc,id desc limit 1;
  if s.id is null then return false; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where canonical_request_id=s.approved_request_id
      and asset_id=a.id and client_id=a.client_id;
  if q.id is null then return false; end if;
  h:=public.ordinary_media_review_hash_v6(q);
  select * into r from public.approval_requests_v6
    where id=s.approved_request_id and client_id=a.client_id
      and source_system='aa_console' and source_kind='ordinary_media'
      and source_id=q.id::text;
  if r.id is null or h is null or q.source_hash is distinct from h
    or s.approved_hash is distinct from h or r.artifact_hash is distinct from h
    or r.source_version is distinct from h||':'||q.request_token::text
    or r.preview is distinct from public.ordinary_media_review_preview_v6(q)
    or r.scope is distinct from public.ordinary_media_review_scope_v6(q)
    or r.destination is distinct from 'creative_source:'||a.id::text
    or exists(select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id=r.id)
    or exists(select 1 from public.ordinary_media_review_requests_v6 newer
      where newer.asset_id=a.id and (newer.created_at,newer.id)>(q.created_at,q.id))
    then return false; end if;
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  return d.decision='approved' and d.actor_aal='aal2'
    and d.actor_id=s.approved_by and d.artifact_hash=h
    and d.source_decision_ref='ordinary_media:'||q.id::text||':'||q.request_token::text;
end $$;

create or replace function public.request_ordinary_media_review_v6(p_asset_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.client_media_assets%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  s public.ordinary_media_signoffs_v6%rowtype;
  h text;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must request creative review.' using errcode='42501';
  end if;
  select * into a from public.client_media_assets where id=p_asset_id for update;
  if a.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(a.client_id),false)
    or coalesce(public.is_client_user(a.client_id),false)) then
    raise exception 'The asset or decision owner is unavailable.' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ordinary_media_review:'||a.id::text,0));
  if a.media_type not in ('image','text') or a.content_format not in ('single','carousel','story')
    or a.render_path is not null or a.edit_stage<>'review_ready'
    or a.archived_at is not null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null
    or (a.content_format<>'single' and not public.framed_creative_evidence_current_v8(a.id)) or a.review_status not in ('pending','approved')
    or exists(select 1 from public.content_slots cs
      where cs.asset_id=a.id and cs.stage='awaiting_approval') then
    raise exception 'This asset needs current bytes, rights and its owning review route.'
      using errcode='23514';
  end if;
  if a.human_approved_at is not null then
    if public.ordinary_media_signoff_current_v6(a.id) then
      raise exception 'This exact creative is already approved.' using errcode='23514';
    end if;
    select * into s from public.ordinary_media_signoffs_v6
      where asset_id=a.id and client_id=a.client_id
      order by approved_at desc,id desc limit 1;
    if s.id is null then
      raise exception 'Legacy approval needs a separate reconciliation.' using errcode='23514';
    end if;
    insert into public.ordinary_media_reopen_events_v8
      (asset_id,client_id,prior_request_id,reopened_by,reason)
    values(a.id,a.client_id,s.approved_request_id,auth.uid(),
      'The prior exact creative signoff is stale; request a new review.');
    update public.client_media_assets
      set human_approved_at=null,review_status='pending' where id=a.id;
  end if;
  select * into q from public.ordinary_media_review_requests_v6
    where asset_id=a.id order by created_at desc,id desc limit 1;
  if q.id is not null and q.canonical_request_id is not null
    and q.source_hash=public.ordinary_media_review_hash_v6(q)
    and exists(select 1 from public.approval_requests_v6 r
      where r.id=q.canonical_request_id and r.expires_at>now()
        and r.artifact_hash=q.source_hash)
    and not exists(select 1 from public.approval_decision_events_v6 d
      where d.request_id=q.canonical_request_id)
    then return q.canonical_request_id; end if;
  insert into public.ordinary_media_review_requests_v6(asset_id,client_id,created_at)
    values(a.id,a.client_id,clock_timestamp()) returning * into q;
  h:=public.ordinary_media_review_hash_v6(q);
  if h is null then raise exception 'Creative Storage identity is unavailable.'
    using errcode='23514'; end if;
  update public.ordinary_media_review_requests_v6 set source_hash=h
    where id=q.id returning * into q;
  q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
    'client_id',q.client_id,'source_system','aa_console',
    'source_kind','ordinary_media','source_id',q.id::text,
    'source_version',h||':'||q.request_token::text,
    'title','Review creative: '||coalesce(nullif(a.title,''),a.id::text),
    'artifact_hash',h,'preview',public.ordinary_media_review_preview_v6(q),
    'destination','creative_source:'||a.id::text,
    'scope',public.ordinary_media_review_scope_v6(q),
    'owner_role','admin_or_active_client_manager',
    'requested_by',auth.uid(),'requester_kind','human',
    'expires_at',now()+interval '7 days',
    'owning_path','/clients/'||a.client_id::text||'/delivery/approval-inbox?tab=assets'));
  update public.ordinary_media_review_requests_v6
    set canonical_request_id=q.canonical_request_id where id=q.id;
  return q.canonical_request_id;
end $$;


create or replace view public.ordinary_media_current_status_v6
with (security_invoker=true) as
select a.client_id,a.id as asset_id,
  public.ordinary_media_signoff_current_v6(a.id) as current_signoff
from public.client_media_assets a
where a.media_type in ('image','text')
  and a.content_format in ('single','carousel','story') and a.render_path is null
  and a.review_status='approved' and a.human_approved_at is not null;
revoke all on public.ordinary_media_current_status_v6
  from public,anon,authenticated,service_role;
grant select on public.ordinary_media_current_status_v6
  to authenticated,service_role;

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
    and v_asset.content_format in ('single','carousel','story') and v_asset.render_path is null
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
  'Manual organic scheduling requires a current exact creative signoff for image/text assets with exact single-file or framed signoff, plus the same-client campaign chain. Outward publication retains its own package approval gate.';

revoke all on function public.framed_creative_evidence_current_v8(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.framed_creative_evidence_current_v8(uuid)
  to authenticated,service_role;
select public.lock_down_definer_functions();
commit;
