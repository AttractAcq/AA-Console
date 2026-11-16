-- Join a standalone placement's exact review to its placement, and a proof
-- delivery review to the current delivery row. The latter provider attempt
-- does not store the approval request ID, so its causal attribution is unknown.
begin;

create view public.proof_approval_execution_evidence_v6
with (security_barrier=true) as
select a.canonical_request_id as request_id,a.client_id,
  'proof_placement'::text as source_kind,p.status as state,
  case
    when p.status='retracted' and r.id is null
      then 'Historical removal has no confirmation receipt; external state is unknown.'
    when p.status='retracted' and r.legacy_audit
      then 'A person checked this historical removal later; provider readback is not proved.'
    when p.status='retracted'
      then 'Removal confirmation recorded; inspect the receipt in Proof Distribution.'
    when p.status='retraction_required'
      then 'Proof must be removed; a removal receipt has not been recorded.'
    when p.status in ('placed','verified')
      then 'Placement is recorded; inspect the owning source for provider verification.'
    when p.status='failed' then 'Placement failed; inspect the owning source for the error.'
    else 'No external placement is confirmed.'
  end as detail,
  coalesce(p.external_url,p.external_id) as external_ref
from public.proof_placement_approvals a
join public.proof_placements p on p.id=a.placement_id
  and p.approval_id=a.id and p.client_id=a.client_id
left join public.proof_placement_retraction_receipts_v6 r
  on r.placement_id=p.id and r.client_id=p.client_id
where a.canonical_request_id is not null
  and public.can_access_client(a.client_id)
union all
select q.canonical_request_id,q.client_id,'proof_delivery'::text,
  d.status,
  case
    when d.status='sent'
      then 'A provider send is recorded for this delivery. The attempt is not bound to this exact approval request; recipient receipt is not proved.'
    when d.status='uncertain'
      then 'Provider effect may have happened; inspect the owning source before retry.'
    when d.status='failed'
      then 'Send failed; inspect the owning source for the error and retry policy.'
    when d.status='cancelled' then 'Send was cancelled.'
    else 'No provider send is confirmed.'
  end,
  d.provider_id
from public.proof_delivery_reviews_v6 q
join public.proof_request_deliveries d on d.id=q.delivery_id
  and d.client_id=q.client_id
where q.canonical_request_id is not null
  and (public.is_admin()
    or auth.uid()=public.active_video_approval_manager(q.client_id));

revoke all on public.proof_approval_execution_evidence_v6
  from public,anon,authenticated,service_role;
grant select on public.proof_approval_execution_evidence_v6
  to authenticated,service_role;
comment on view public.proof_approval_execution_evidence_v6 is
 'Proof Inbox request to current source-row observation. Proof delivery provider attempts lack an exact approval-request binding; a provider ID or placed status does not prove recipient delivery or external removal.';

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 c.source_state,c.source_evidence,c.decision_state,c.decision_evidence,
 'blocked','500 exact proof request-to-effect read projection',
 'Supported provider placement/removal and live readback receipts remain unverified.'
from public.approval_class_coverage_v6 c where c.class_id=8;
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 c.source_state,c.source_evidence,c.decision_state,c.decision_evidence,
 'blocked','500 exact proof delivery request-to-send read projection',
 'Provider sender identity and live recipient/send outcome receipts remain unverified.'
from public.approval_class_coverage_v6 c where c.class_id=9;

select public.lock_down_definer_functions();
commit;
