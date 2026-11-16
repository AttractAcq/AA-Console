-- Recruitment image selection now depends on current exact creative and
-- brief signoffs; its external Meta build remains held.
insert into public.approval_class_coverage_versions_v6 (
  class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker
) values (
  17,2,'recruitment_media','Recruitment media signoff',
  'blocked','381 current recruitment image and approved-brief lineage view',
  'blocked','370 exact ordinary-media AAL2 signoff plus 276 exact recruitment brief decision',
  'blocked','381 campaign selection gate; 293 Meta build request remains held',
  'Recruitment media has no separate unified card; pre-Inbox creative is excluded, while Meta provider creation and receipts remain held.'
);
