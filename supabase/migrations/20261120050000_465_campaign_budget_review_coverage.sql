insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (24,2,'campaign_budget_profile','Campaign budget/profile change',
 'blocked','463 budget source row, amount, ad set, reason and campaign context attach as exact Inbox evidence; profile field payloads remain incomplete.',
 'verified','274 AAL2 campaign action Inbox decision; 464 current budget source state invalidates changed and reverted context.',
 'missing',null,
 'Complete profile field previews and provider prewrite checks; bind Meta ad-set account/current-budget readback, outcome and a live receipt before release.');
