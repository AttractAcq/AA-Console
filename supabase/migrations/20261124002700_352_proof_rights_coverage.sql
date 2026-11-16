-- Text-source clearance is source-owned. Stored media remains held until a
-- trusted byte verifier can bind its exact file to the decision.
begin;
insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (11,2,'proof_rights','Proof usage rights',
  'blocked','348 exact text source, consent basis, expiry and request epoch; stored media held',
  'verified','350 source-owned AAL2 Inbox grant/rejection and protective revocation ledger',
  'blocked','350 direct-grant guard and immediate source-edit/restriction revocation; legacy rows remain',
  'Stored image/video bytes need trusted attestation; historical cleared proof and every downstream use need audit.');
commit;
