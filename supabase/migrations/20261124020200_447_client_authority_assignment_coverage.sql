-- Exact client SMM and creative-director seat changes now exist. Historical
-- assignments still need reconciliation before authority coverage is complete.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (30,4,'creative_authority','Creative authority assignment',
  'verified','438 requirement, 441 global owner, and 444 client seat source packets; 439/442/445 Inbox projections. Client seats freeze member identity, active same-category assignments and exact effect.',
  'verified','438, 441 and 444 require provisioned AAL2 admin decisions; owner and seat self-assignment recusal, source invalidation and direct-write guards apply.',
  'blocked','Reviewed requirement, owner and client seat effects run in their decision transactions; 444 keeps separate historical assignment periods and blocks direct active-seat insert/end.',
  'Audit and reconcile client SMM/creative-director assignments created before the exact Inbox route; verify all production decision resolvers use only current reviewed seats.');
