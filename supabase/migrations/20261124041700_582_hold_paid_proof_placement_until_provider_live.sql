-- Building a Meta ad creates paused provider objects. It is not evidence that
-- the creative was shown. Migration 246 recorded that build as a placed proof
-- destination, which inflated the live proof surface and retraction views.
-- Keep historical rows for audit; refuse new assertions until an exact
-- account read can bind a provider-live ad to its proof and approval.

create or replace function public.record_proof_placement_for_ad_v6(
  p_campaign_id uuid, p_external_id text, p_external_url text default null,
  p_approval_id uuid default null)
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  raise exception 'A paused ad build is not a live proof placement. Reconcile the exact ad and account through a provider read before recording distribution.'
    using errcode = 'P0001';
end $$;

comment on function public.record_proof_placement_for_ad_v6(uuid, text, text, uuid) is
  'Held: a paused ad build does not prove paid proof distribution. Preserve historical rows and require a future provider-live reconciliation before creating new placements.';

revoke all on function public.record_proof_placement_for_ad_v6(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_proof_placement_for_ad_v6(uuid, text, text, uuid)
  to service_role;

update public.proof_destinations
   set supported = false,
       note = 'A paid operator may receive proof-derived creative, but a paused build or handoff is not a live placement. Paid proof distribution remains unverified until the exact provider account and ad are read back as active with a receipt.'
 where destination_key = 'paid_advertising';
