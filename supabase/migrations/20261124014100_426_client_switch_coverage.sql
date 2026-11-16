-- The per-client Engine settings now have an exact governance path. Global
-- Engine and endpoint/booking switches remain outside this first bridge.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (29,2,'activation_switch','Client/product activation switch',
  'blocked','423 exact per-client settings snapshot and scope; 424 Unified Inbox projection; global Engine, booking and lead-capture switches lack review sources',
  'blocked','423 provisioned AAL2 admin decision calls existing switch setters atomically; global and endpoint-specific decisions absent',
  'blocked','423 direct per-client enablement guard, stale/revert invalidation and immediate disable; rollback fixture',
  'Reconcile legacy on switches; govern global Engine, booking and lead-capture enablement; bind live provider identity and expiry to each outward scope before release.');
