-- Single-file Engine slots have an exact AAL2 source decision and atomic
-- schedule. Video, multi-file creative and the separate publisher remain held.
insert into public.approval_class_coverage_versions_v6 (
  class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker
) values (
  1,3,'engine_slot','Engine slot release',
  'blocked','376 exact trusted single-file media, copy, slot and account packet; video and multi-file held',
  'blocked','378 source-owned AAL2 Inbox decision and atomic approve_slot for single-file image/text',
  'blocked','375/376 transition guards and rollback fixture; publication separately held by 295',
  'Video and multi-file Engine slots, legacy multiple entry events, live provider account verification and external publication receipts remain open.'
);
