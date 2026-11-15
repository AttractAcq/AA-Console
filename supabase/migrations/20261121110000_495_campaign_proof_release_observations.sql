-- Read back each proof placement named by a campaign action. This records
-- the database release state, not a receipt from an external destination.
begin;

create view public.campaign_proof_release_observations_v6
with (security_barrier=true) as
select e.id as execution_id,e.client_id,e.approval_id,
 item.value->>'placement_id' as placement_ref,
 item.value->>'payload_hash' as expected_payload_hash,
 ppa.id as placement_approval_id,ppa.status as placement_approval_status,
 pl.destination_key,pl.status as placement_status,
 pl.payload_hash as current_payload_hash,
 case when pl.id is null then null
  else pl.payload_hash is not distinct from item.value->>'payload_hash' end as payload_matches,
 pl.external_id,pl.external_url,pl.retracted_at,
 ppa.decided_at as release_decided_at
from public.campaign_action_executions e
join public.campaign_action_approvals a on a.id=e.approval_id
cross join lateral jsonb_array_elements(case
 when jsonb_typeof(a.scope->'placements')='array' then a.scope->'placements'
 else '[]'::jsonb end) item(value)
left join public.proof_placement_approvals ppa
 on ppa.campaign_action_approval_id=a.id and ppa.client_id=e.client_id
 and ppa.placement_id::text=item.value->>'placement_id'
left join public.proof_placements pl
 on pl.id=ppa.placement_id and pl.client_id=e.client_id
where e.action_key='proof_publish'
 and a.client_id=e.client_id
 and public.can_access_client(e.client_id);

revoke all on public.campaign_proof_release_observations_v6
 from public,anon,authenticated,service_role;
grant select on public.campaign_proof_release_observations_v6
 to authenticated,service_role;
comment on view public.campaign_proof_release_observations_v6 is
 'Exact campaign proof items and their current local approval/placement state. External distribution needs its own provider or assisted receipt.';

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','274 exact action Inbox source; 325 atomic handler-owned claim',
 'verified','274 AAL2 decision; 331 revocation',
 'blocked','328 per-attempt receipt; 490 uncertain terminal result; 495 exact proof release readback',
 'Owned runtime release, live provider preflight/receipt and external proof-placement reconciliation are outstanding.'
from public.approval_class_coverage_v6 c where c.class_id=6;

select public.lock_down_definer_functions();
commit;
