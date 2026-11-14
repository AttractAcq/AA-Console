-- Every known activation switch now has an exact AAL2 source decision.
-- Effective runtime/provider readiness and legacy-on reconciliation remain.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (29,4,'activation_switch','Client/product activation switch',
  'blocked','423 per-client, 426 booking and intake, 428 agency-wide Engine packets; 424/429 Inbox projections; provider identity and live grant evidence remain incomplete',
  'verified','423/426 exact AAL2 admin decision invokes existing per-client setter; 428 exact AAL2 agency decision invokes global setter',
  'blocked','423/426/428 direct enablement guards, stale/revert invalidation and immediate off; local rollback fixtures. Outward switches still lack a common live-provider preflight and legacy-on reconciliation',
  'Bind verified provider account, runtime readiness and action scope to outward switch enablement; audit legacy on states and downstream effects before release.');
