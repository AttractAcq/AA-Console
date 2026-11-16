-- Profile proposals have their own Google and Meta exact Inbox classes.
-- The old generic campaign action cannot name a profile source record and
-- has no handler. Preserve historical rows, but refuse new unsourced ones.
begin;

create function public.reject_generic_profile_campaign_action_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 raise exception 'Use the Google or Meta profile proposal review. Generic campaign profile updates have no exact source or executor.'
  using errcode='23514';
end $$;
create trigger generic_profile_campaign_action_hold_v6
 before insert on public.campaign_action_approvals
 for each row when (new.action_key='profile_update')
 execute function public.reject_generic_profile_campaign_action_v6();
revoke all on function public.reject_generic_profile_campaign_action_v6()
 from public,anon,authenticated,service_role;

update public.campaign_action_executors set supported=false,
 note='Retired for new requests. Google and Meta profile changes use their separate exact proposal reviews and remain held before provider PATCH. Historical generic campaign actions are retained for audit.'
 where action_key='profile_update';

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (24,3,'campaign_budget_profile','Campaign budget/profile change',
 'verified','463 exact budget source, campaign context, ad set, old/proposed amount, currency and reason; 467 rejects new unsourced generic profile actions. Google/Meta profile proposals are classes 22/23.',
 'verified','274 AAL2 campaign action decision; 464 current budget source invalidation.',
 'blocked','466 reviewed Meta write credential; runtime ad-set/account/current-budget preflight and readback.',
 'Campaign action release is held. Reconcile historical generic profile actions, verify a real Meta account and scope, then observe an authorized budget-write receipt. Profile PATCH routes remain blocked in classes 22/23.');

select public.lock_down_definer_functions();
commit;
