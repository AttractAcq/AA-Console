-- Offer Studio's New main/secondary actions create an unversioned draft row.
-- Migration 208 granted authenticated users SELECT only, so those POSTs 403.
-- Match the existing read scope and grant only the three fields the UI writes.
create policy service_offers_create on public.service_offers
  for insert to authenticated
  with check (
    coalesce(public.is_admin(), false)
    or auth.uid() = public.active_video_approval_manager(client_id)
  );

grant insert (client_id, kind, service_name) on public.service_offers to authenticated;
