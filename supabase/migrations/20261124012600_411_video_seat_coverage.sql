-- Exact seat decisions exist, but legacy signoffs and downstream distribution
-- still need audit and a live render/provider receipt.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (3,2,'video_owner','Video owner signoff',
  'verified','405 owner-scoped exact render bytes, Storage identity, rights and assigned reviewer; 407 Inbox projection',
  'verified','406 assigned provisioned AAL2 owner decision, direct signoff guard; rollback fixture covers stale render and AAL1',
  'blocked','408 final media approval reads current exact owner signature; 406 final-update guard',
  'Historical path-only signoffs need reconciliation; Engine and downstream distribution must recheck current bytes, and a live receipt remains unverified.'),
 (4,2,'video_manager','Video SMM signoff',
  'verified','405 SMM-scoped exact render bytes, Storage identity, rights and active assignment; 407 Inbox projection',
  'verified','406 assigned provisioned AAL2 SMM decision and direct signoff guard; rollback fixture covers final gate',
  'blocked','408 final media approval reads current exact SMM signature; 406 final-update guard',
  'Historical path-only signoffs need reconciliation; Engine and downstream distribution must recheck current bytes, and a live receipt remains unverified.'),
 (5,2,'video_client','Video client signoff',
  'verified','405 nominated current client user and re-request epoch bound to exact render bytes and Storage identity',
  'verified','406 assigned provisioned AAL2 client approval/rejection through Inbox; direct sign/decline denied',
  'blocked','408 final media approval requires current client signature when a client review was requested',
  'Historical path-only signoffs and notification delivery need reconciliation; downstream distribution and a live receipt remain unverified.');
