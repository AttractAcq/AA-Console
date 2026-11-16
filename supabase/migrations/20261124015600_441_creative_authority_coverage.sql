-- The director-requirement switch is reviewed in both directions. Global
-- video owner and assigned seats still need their own governance cards.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (30,2,'creative_authority','Creative authority assignment',
  'blocked','438 exact current/proposed director-requirement and seat packet; 439 Inbox projection. Global owner and client assignments have no equivalent review.',
  'blocked','438 AAL2 admin decision, direct toggle guard, seat-change invalidation and current-director recusal for the requirement control only.',
  'blocked','438 source decision changes the requirement in the same transaction. Direct set_content_approval_owner and SMM/creative-director client_assignments writes remain.',
  'Add exact governance reviews for global video owner and client creative/SMM assignments, with direct-write guards and separate-authority checks.');
