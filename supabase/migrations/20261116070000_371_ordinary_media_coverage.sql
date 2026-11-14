-- Single-file image/text source approval is exact; downstream and legacy
-- uses still require current-decision audit before the class can be released.
begin;
insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (2,2,'ordinary_media','Ordinary media acceptance',
  'verified','367 trusted Storage digest; 368 exact single-file image/text review request',
  'verified','370 AAL2 source-owned decision and direct human-approval guard for that path',
  'blocked','Videos, carousels, Engine slots and legacy human approvals retain separate paths',
  'Audit downstream uses and legacy approvals; bridge multi-file creative and specialist gates.');
commit;
