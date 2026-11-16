-- The sequence decision is exact, but historical approvals and a real send
-- remain unreconciled; request/authoring UX is also not released.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (20,2,'nurture_sequence','Nurture sequence approval',
 'verified','400 ordered step words, delay, trigger/exit stages and automatic-enrolment snapshot; 402 Inbox projection',
 'verified','400 source-owned provisioned AAL2 decision and direct-approval guard; rollback fixture covers stale, AAL1 and duplicate',
 'blocked','401 current exact approval rechecked at enrolment and before every sequencer step; 397 per-message courier gate',
 'Historical standing sequence approvals need reconciliation; authoring/request UX, sender identity and an authorized provider receipt remain unverified.');
