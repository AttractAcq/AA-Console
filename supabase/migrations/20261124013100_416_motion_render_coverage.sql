-- Exact Inbox decisions exist; downstream use and legacy records remain held.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (15,2,'motion_render','Motion render acceptance',
  'verified','411 trusted Storage byte attestation, frozen render/QA/scene/proof snapshot; 412 Inbox projection; 413 edit-and-revert invalidation',
  'verified','411 provisioned AAL2 owner decision and direct accept guard; rollback fixture covers stale, AAL1, duplicate and Storage mutation',
  'blocked','413 current acceptance check; 414 legacy/stale label in render list',
  'Historical path-only acceptances need reconciliation; downstream content or page attachment must check current exact acceptance, and a live distribution receipt is unverified.');
