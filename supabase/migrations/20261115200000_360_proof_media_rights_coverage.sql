-- The media request is bound to trusted bytes and Storage identity. External
-- media placement remains held until a provider prewrite rehash exists.
begin;
insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (11,3,'proof_rights','Proof usage rights',
  'blocked','357-359 trusted runtime digest, Storage object identity and change invalidation; live download unverified',
  'verified','350 exact AAL2 Inbox decision and immediate rights revocation',
  'blocked','355 media placement held until provider prewrite byte rehash; legacy clearances remain',
  'Verify a real private proof download and review. Add media byte rehash before every external use, then audit historical clearances and placement retractions.');
commit;
