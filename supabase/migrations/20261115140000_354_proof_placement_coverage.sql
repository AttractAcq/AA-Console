-- Standalone text placement can be reviewed exactly; media, legacy approvals
-- and provider effects still need separate verification.
begin;
insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (8,2,'proof_placement','Proof placement',
  'blocked','352 exact standalone placement, destination, rights and text source snapshot; media held',
  'verified','352 source-owned AAL2 Inbox decision and direct-decision guard',
  'blocked','355 prewrite check and 356 due gate; provider and assisted receipts unverified',
  'Stored media and produced artifacts need trusted byte/version attestation. Legacy standalone approvals and external placement receipts need audit.');
commit;
