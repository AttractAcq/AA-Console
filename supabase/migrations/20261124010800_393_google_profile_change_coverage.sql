-- Exact proposal review is bridged; Google field PATCH remains held.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (22,2,'google_profile_change','Google profile change',
 'verified','390 before/after, same-client location and review epoch; 391 Inbox source state',
 'verified','390 AAL2 source-owned decision and direct approved/applied status guard',
 'blocked','Profile updater still has its global prewrite hold; no external test receipt',
 'Verify location/account and current provider field, then add last-moment prewrite comparison, paused or reversible change handling, provider receipt and read-back.');
