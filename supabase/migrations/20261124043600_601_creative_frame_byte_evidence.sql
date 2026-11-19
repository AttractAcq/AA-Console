-- A framed creative is one asset but several stored files. Preserve trusted
-- byte evidence for each ordered frame; the asset digest covers frame one only.
begin;

create table public.creative_frame_bytes_v8 (
  frame_id uuid primary key references public.client_media_frames(id) on delete cascade,
  asset_id uuid not null references public.client_media_assets(id) on delete cascade,
  storage_path text not null,
  object_id uuid not null,
  object_version text,
  object_updated_at timestamptz not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes bigint not null check (file_bytes > 0),
  attested_at timestamptz not null default now()
);
create index creative_frame_bytes_asset_v8 on public.creative_frame_bytes_v8(asset_id);
alter table public.creative_frame_bytes_v8 enable row level security;
revoke all on public.creative_frame_bytes_v8 from public,anon,authenticated,service_role;

create function public.creative_frame_storage_identities_v8(p_asset_id uuid)
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
  if v_count<2 or v_found<>v_count or
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

create function public.attest_creative_frame_bytes_v8(
  p_asset_id uuid,p_frame_id uuid,p_storage_path text,p_sha256 text,
  p_file_bytes bigint,p_object_id uuid,p_object_version text,
  p_object_updated_at timestamptz)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare a public.client_media_assets%rowtype;
  f public.client_media_frames%rowtype; o storage.objects%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted verifier may attest frame bytes.' using errcode='42501';
  end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' or p_file_bytes is null or p_file_bytes<=0 then
    raise exception 'A nonempty frame and SHA-256 digest are required.' using errcode='23514';
  end if;
  select * into a from public.client_media_assets where id=p_asset_id for update;
  select * into f from public.client_media_frames
    where id=p_frame_id and asset_id=p_asset_id for update;
  if a.id is null or a.content_format='single' or f.id is null
    or f.storage_path is distinct from p_storage_path then
    raise exception 'The frame no longer belongs to this creative.' using errcode='23514';
  end if;
  select * into o from storage.objects
    where bucket_id='client-media' and name=p_storage_path;
  if o.id is null or o.id is distinct from p_object_id
    or o.version is distinct from p_object_version
    or o.updated_at is distinct from p_object_updated_at then
    raise exception 'Frame Storage identity changed during verification.' using errcode='23514';
  end if;
  insert into public.creative_frame_bytes_v8
    (frame_id,asset_id,storage_path,object_id,object_version,object_updated_at,sha256,file_bytes)
  values (f.id,a.id,p_storage_path,o.id,o.version,o.updated_at,p_sha256,p_file_bytes)
  on conflict(frame_id) do update set
    asset_id=excluded.asset_id,storage_path=excluded.storage_path,
    object_id=excluded.object_id,object_version=excluded.object_version,
    object_updated_at=excluded.object_updated_at,sha256=excluded.sha256,
    file_bytes=excluded.file_bytes,attested_at=now()
  where (creative_frame_bytes_v8.asset_id,creative_frame_bytes_v8.storage_path,
    creative_frame_bytes_v8.object_id,creative_frame_bytes_v8.object_version,
    creative_frame_bytes_v8.object_updated_at,creative_frame_bytes_v8.sha256,
    creative_frame_bytes_v8.file_bytes) is distinct from
    (excluded.asset_id,excluded.storage_path,excluded.object_id,excluded.object_version,
    excluded.object_updated_at,excluded.sha256,excluded.file_bytes);
  return f.id;
end $$;

create function public.invalidate_creative_frame_bytes_v8()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if tg_table_schema='storage' then
    delete from public.creative_frame_bytes_v8 b where b.object_id=old.id
      or b.storage_path=old.name
      or (tg_op='UPDATE' and b.storage_path=new.name);
  else
    delete from public.creative_frame_bytes_v8 b where b.frame_id=old.id;
  end if;
  return null;
end $$;
create trigger creative_frame_storage_changed_v8
  after update or delete on storage.objects for each row
  execute function public.invalidate_creative_frame_bytes_v8();
create trigger creative_frame_record_changed_v8
  after update of asset_id,position,storage_path,caption or delete
  on public.client_media_frames for each row
  execute function public.invalidate_creative_frame_bytes_v8();

revoke all on function public.creative_frame_storage_identities_v8(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.creative_frame_storage_identities_v8(uuid) to service_role;
revoke all on function public.attest_creative_frame_bytes_v8(
  uuid,uuid,text,text,bigint,uuid,text,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.attest_creative_frame_bytes_v8(
  uuid,uuid,text,text,bigint,uuid,text,timestamptz) to service_role;
revoke all on function public.invalidate_creative_frame_bytes_v8()
  from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
