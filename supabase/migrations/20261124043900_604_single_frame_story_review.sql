-- A story may contain one frame; carousel and reel require at least two.
-- Keep the trusted verifier and exact signoff aligned with publication rules.
begin;
create or replace function public.creative_frame_storage_identities_v8(p_asset_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,storage as $$
declare a public.client_media_assets%rowtype;
  v_frames jsonb; v_count integer; v_found integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted verifier may read frame identity.' using errcode='42501';
  end if;
  select * into a from public.client_media_assets where id=p_asset_id;
  if a.id is null then raise exception 'Asset not found.' using errcode='23514'; end if;
  if a.content_format='single' then return null; end if;
  select count(*),count(o.id),jsonb_agg(jsonb_build_object(
      'frame_id',f.id,'position',f.position,'storage_path',f.storage_path,
      'object_id',o.id,'object_version',o.version,'object_updated_at',o.updated_at,
      'caption',f.caption) order by f.position)
    into v_count,v_found,v_frames
  from public.client_media_frames f
  left join storage.objects o on o.bucket_id='client-media' and o.name=f.storage_path
  where f.asset_id=a.id;
  if v_count < (case when a.content_format='story' then 1 else 2 end) or v_found<>v_count or
    (v_frames->0->>'storage_path') is distinct from a.storage_path or
    exists(select 1 from (
      select f.position,row_number() over(order by f.position) as expected
      from public.client_media_frames f where f.asset_id=a.id
    ) numbered where numbered.position<>numbered.expected) then
    raise exception 'The ordered creative frames or stored files are incomplete.'
      using errcode='23514';
  end if;
  return jsonb_build_object('asset_id',a.id,'client_id',a.client_id,
    'content_format',a.content_format,'frames',v_frames);
end $$;


create or replace function public.framed_creative_evidence_current_v8(p_asset_id uuid)
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
  if frame_count < (case when a.content_format='story' then 1 else 2 end) or (select f.storage_path from public.client_media_frames f
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


select public.lock_down_definer_functions();
commit;
