-- Booking and endpoint-specific lead capture now share the exact client
-- activation request and decision; global Engine still needs its own scope.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (29,3,'activation_switch','Client/product activation switch',
  'blocked','423 per-client settings snapshot; 426 exact booking rules/windows and intake endpoint/consent packet; 424 Unified Inbox projection; global Engine source absent',
  'blocked','423 and 426 provisioned AAL2 admin decision calls the original setter atomically; global Engine decision absent',
  'blocked','423/426 direct enablement guards, edit-and-revert invalidation, live booking/intake shape guards and immediate disable; rollback fixtures',
  'Global Engine enablement is still direct. Reconcile legacy on switches; bind live provider identity, scope expiry and verified execution outcomes before release.');
