-- New human selections are exact; legacy and bot provenance still need audit.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (26,2,'campaign_idea','Campaign idea selection',
  'verified','416 frozen idea/campaign/proof packet; 417 Unified Inbox projection; 418 edit-and-revert invalidation',
  'verified','416 provisioned AAL2 admin or active manager decision; 418 direct human status guard; rollback fixture',
  'blocked','418 idempotent brief RPC requires current human, Engine or bot selection; 420 checks every new brief job; 422 checks worker start, output and linked brief writes',
  'Legacy approved/briefed ideas and bot selection evidence need reconciliation; downstream use of older briefs needs audit.');
