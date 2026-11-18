-- A paid packet approval is usable only while its exact Inbox request remains
-- current and unexpired. The Inbox already labels an expired request expired.
begin;

create or replace function public.paid_operator_bundle_approved_v7(p_bundle_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare b public.paid_operator_bundles_v7%rowtype;
  q public.approval_requests_v6%rowtype;
  v_decision text;
begin
  select * into b from public.paid_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null then return false; end if;
  if b.platform='google' and nullif(btrim(b.snapshot->>'research_task'),'') is null
    then return false; end if;
  if not public.paid_operator_bundle_current_v7(b.id) then return false; end if;
  select * into q from public.approval_requests_v6
    where source_system='aa_console' and source_kind='paid_operator_bundle'
      and source_id=b.id::text and source_version=b.snapshot_hash;
  if q.id is null or q.client_id is distinct from b.client_id
    or q.artifact_hash is distinct from b.snapshot_hash
    or q.preview is distinct from b.snapshot
    or q.destination is distinct from b.platform||'_ads:manual_operator_handoff'
    or q.scope is distinct from jsonb_build_object('client_id',b.client_id,
      'campaign_id',b.campaign_id,'package_id',b.package_id,
      'bundle_id',b.id,'platform',b.platform,'version',b.version,
      'snapshot_hash',b.snapshot_hash)
    or q.expires_at is null or q.expires_at <= now() then return false; end if;
  select d.decision into v_decision from public.approval_decision_events_v6 d
    where d.request_id=q.id order by d.event_order desc limit 1;
  return coalesce(v_decision='approved',false);
end $$;
revoke all on function public.paid_operator_bundle_approved_v7(uuid)
  from public,anon;
grant execute on function public.paid_operator_bundle_approved_v7(uuid)
  to authenticated,service_role;

select public.lock_down_definer_functions();
commit;
