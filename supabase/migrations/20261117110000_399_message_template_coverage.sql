-- Exact standing message approval is bridged, but historical approvals and
-- provider identity/receipts still need reconciliation before release.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (19,2,'message_template','Message template approval',
 'verified','396 immutable version, current purpose/channel/consent basis, request token and Inbox preview; 398 source projection',
 'verified','396 provisioned AAL2 source-owned Inbox decision and guarded approval row; rollback fixture covers stale and AAL1',
 'blocked','397 queue, claim and last-moment courier gate; runtime refuses provider call on denial',
 'Historical direct approvals need reconciliation, message authoring/request UI needs release, and sender account identity plus a real provider receipt remain unverified.');
