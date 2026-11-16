-- Proof release and lead enrolment are database effects. Require the owned
-- claim and current Inbox decision in the same transaction as the effect;
-- service_role must not call the legacy effect functions directly.
begin;
create function public.release_campaign_proof_placements_owned_v6(
  p_execution_id uuid,p_worker_id text,p_build_sha text)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  perform public.assert_campaign_action_prewrite_v6(
    p_execution_id,p_worker_id,p_build_sha,'proof_publish');
  return public.release_campaign_proof_placements(p_execution_id);
end $$;
create function public.enrol_campaign_leads_owned_v6(
  p_execution_id uuid,p_worker_id text,p_build_sha text)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  perform public.assert_campaign_action_prewrite_v6(
    p_execution_id,p_worker_id,p_build_sha,'lead_message');
  return public.enrol_campaign_leads_in_sequence_v6(p_execution_id);
end $$;
revoke all on function public.release_campaign_proof_placements(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.enrol_campaign_leads_in_sequence_v6(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.release_campaign_proof_placements_owned_v6(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.release_campaign_proof_placements_owned_v6(uuid,text,text)
  to service_role;
revoke all on function public.enrol_campaign_leads_owned_v6(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.enrol_campaign_leads_owned_v6(uuid,text,text)
  to service_role;
select public.lock_down_definer_functions();
commit;
