-- A storage object may be overwritten or removed without changing the asset
-- row. Clear its trusted digest on any such event so approvals cannot keep
-- treating the old bytes as current. A worker must hash the new bytes again.
create function public.invalidate_delivery_asset_storage_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, storage as $$
declare v_new_path text;
begin
  if tg_op = 'UPDATE' then v_new_path := new.name; end if;
  update public.client_media_assets a
    set delivery_bytes_sha256 = null
  where a.delivery_bytes_sha256 is not null
    and (a.storage_path = old.name
      or to_jsonb(a)->>'render_path' = old.name
      or a.storage_path = v_new_path
      or to_jsonb(a)->>'render_path' = v_new_path);
  return null;
end $$;
create trigger delivery_asset_storage_updated_v6
  after update or delete on storage.objects
  for each row execute function public.invalidate_delivery_asset_storage_v6();
revoke all on function public.invalidate_delivery_asset_storage_v6()
  from public, anon, authenticated, service_role;
select public.lock_down_definer_functions();
