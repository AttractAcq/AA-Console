-- Exact artifact signoff is available for new versions. Historical rows lack
-- the Inbox identity and are held at placement until re-reviewed.
begin;
insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (10,2,'proof_artifact','Proof artifact signoff',
  'verified','361 immutable artifact, current source rights and exact claim/words snapshot',
  'verified','363 source-owned AAL2 Inbox decision and insert guard',
  'blocked','364 current-signoff placement recheck; legacy signoffs held',
  'Audit pre-Inbox signoffs and verify new artifact-to-placement use with provider receipts.');
commit;
