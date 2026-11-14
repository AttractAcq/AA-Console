-- Requirement and global owner changes now have exact decisions; assignment
-- of the client creative director and SMM remains an unreviewed authority path.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (30,3,'creative_authority','Creative authority assignment',
  'blocked','438 client director-requirement and 441 agency owner exact packets; 439/442 Inbox projections. Client creative/SMM assignment is still direct.',
  'blocked','438 AAL2 client requirement decision; 441 AAL2 global owner decision with candidate recusal and direct setter guard. Assignment decision is absent.',
  'blocked','Both reviewed changes run their existing effects in the decision transaction. Direct client_assignments changes can still replace the signing seat.',
  'Add exact governance review for creative-director and SMM client assignment and ending, with a direct-write guard and separate-authority check.');
