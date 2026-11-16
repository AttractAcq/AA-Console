-- Seat display and finalization use current exact Inbox signatures.
begin;
create or replace function public.video_approval_state(p_asset_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  a public.client_media_assets%rowtype;
  v_owner uuid;
  v_manager uuid;
  v_client uuid;
begin
  select * into a from public.client_media_assets where id = p_asset_id;
  if a.id is null or not public.can_access_client(a.client_id) then
    raise exception 'Not permitted for this asset';
  end if;
  select owner_user_id into v_owner from public.content_approval_settings where singleton;
  v_manager := public.active_video_approval_manager(a.client_id);
  select client_user_id into v_client from public.video_client_approval_requests where asset_id = a.id;
  return jsonb_build_object(
    'owner_user_id', v_owner, 'manager_user_id', v_manager,
    'client_user_id', v_client,
    'client_rejection_reason', (select rejection_reason from public.video_client_approval_requests where asset_id = a.id),
    'owner_approved', public.video_signoff_current_v6(a.id,'owner'),
    'manager_approved', public.video_signoff_current_v6(a.id,'manager'),
    'client_approved', v_client is not null
      and exists(select 1 from public.profiles p join public.client_users cu on cu.user_id = p.id
                  where p.id = v_client and p.role = 'client' and cu.client_id = a.client_id)
      and public.video_signoff_current_v6(a.id,'client'),
    'can_configure', public.is_admin(), 'current_user_id', auth.uid(),
    'client_accounts', case when auth.uid() = v_manager then (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id,
        'name', coalesce(p.full_name, p.email, 'Client')) order by p.full_name), '[]'::jsonb)
      from public.client_users cu join public.profiles p on p.id = cu.user_id
      where cu.client_id = a.client_id and p.role = 'client'
    ) else '[]'::jsonb end
  );
end;
$$;
select public.lock_down_definer_functions();
commit;
