-- The browser supplies an asset ID. A trusted worker reads the actual stored
-- file and binds its digest to the current Storage object and asset path.
begin;
create function public.creative_storage_identity_v6(p_asset_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, storage as $$
declare a public.client_media_assets%rowtype;
  o storage.objects%rowtype;
  v_path text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the trusted verifier may read creative Storage identity.'
      using errcode = '42501'; end if;
  select * into a from public.client_media_assets where id = p_asset_id;
  if a.id is null then raise exception 'Asset not found.' using errcode = '23514'; end if;
  v_path := coalesce(nullif(btrim(a.render_path),''),a.storage_path);
  if nullif(btrim(v_path),'') is null then
    raise exception 'This asset has no stored file.' using errcode = '23514'; end if;
  select * into o from storage.objects
    where bucket_id = 'client-media' and name = v_path;
  if o.id is null then raise exception 'Creative file is missing from Storage.'
    using errcode = '23514'; end if;
  return jsonb_build_object('asset_id',a.id,'client_id',a.client_id,
    'storage_path',v_path,'object_id',o.id,
    'object_version',o.version,'object_updated_at',o.updated_at);
end $$;

create function public.attest_creative_storage_bytes_v6(
  p_asset_id uuid,p_storage_path text,p_sha256 text,p_file_bytes bigint,
  p_object_id uuid,p_object_version text,p_object_updated_at timestamptz)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public, storage as $$
declare a public.client_media_assets%rowtype;
  o storage.objects%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the trusted verifier may attest creative bytes.'
      using errcode = '42501'; end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' or p_file_bytes is null or p_file_bytes <= 0 then
    raise exception 'A nonempty file and SHA-256 digest are required.'
      using errcode = '23514'; end if;
  select * into a from public.client_media_assets where id = p_asset_id for update;
  if a.id is null or p_storage_path is distinct from
    coalesce(nullif(btrim(a.render_path),''),a.storage_path) then
    raise exception 'Asset path changed during verification.' using errcode = '23514'; end if;
  select * into o from storage.objects
    where bucket_id = 'client-media' and name = p_storage_path;
  if o.id is null or o.id is distinct from p_object_id
    or o.version is distinct from p_object_version
    or o.updated_at is distinct from p_object_updated_at then
    raise exception 'Creative Storage object changed during verification.'
      using errcode = '23514'; end if;
  update public.client_media_assets set delivery_bytes_sha256 = p_sha256
    where id = a.id;
  perform public.refresh_delivery_entity_v6('content_asset',a.id::text,a.client_id);
  return a.id;
end $$;
revoke all on function public.creative_storage_identity_v6(uuid)
  from public,anon,authenticated;
grant execute on function public.creative_storage_identity_v6(uuid) to service_role;
revoke all on function public.attest_creative_storage_bytes_v6(
  uuid,text,text,bigint,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.attest_creative_storage_bytes_v6(
  uuid,text,text,bigint,uuid,text,timestamptz) to service_role;
select public.lock_down_definer_functions();
commit;
