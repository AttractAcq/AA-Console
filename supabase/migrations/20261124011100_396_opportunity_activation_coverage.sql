-- Activation changes only the internal opportunity lifecycle; campaign and
-- provider actions keep their own approval and execution gates.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (14,2,'opportunity_activate','Market opportunity activation',
 'verified','393 frozen approved opportunity, proof, campaign links and activation note; 394 Inbox source state',
 'verified','393 provisioned AAL2 source-owned activation decision and direct-status guard',
 'blocked','393 atomic active status and opportunity event; rollback fixture covers staleness, AAL1 and pause',
 'Existing active/learning/scaling records lack a separate activation decision and need a legacy audit before this class is released.');
