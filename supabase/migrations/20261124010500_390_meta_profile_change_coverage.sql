-- Proposal review is exact; applying a Meta profile field remains held.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (23,2,'meta_profile_change','Meta profile change',
 'verified','387 exact before/after proposal snapshot and review epoch; 388 Inbox source state',
 'verified','387 AAL2 source-owned decision, direct-RPC denial and status guard',
 'blocked','Meta profile-write adapter remains absent and global prewrite hold remains active',
 'Bind verified Facebook/Instagram account identity and field capabilities, then add an exact prewrite check, provider receipt and read-back.');
