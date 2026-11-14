-- The exact source and decision are bridged, while external sender identity
-- and provider receipt still need an authorized live verification.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (9,2,'proof_delivery','Proof capture delivery',
 'verified','384 immutable review epoch and exact recipient/message/link preview; 385 Inbox source state',
 'verified','384 provisioned AAL2 owner decision and legacy direct-approval denial',
 'blocked','384 claim gate and runtime pre-send recheck; local rollback fixture only',
 'Bind the provider sender account and prove one authorized external send with provider receipt and duplicate handling.');
