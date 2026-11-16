-- A central one-shot claim and outcome digest prevents a second gateway
-- process from replaying the same approved tool card. Adapter-specific
-- provider receipts and last-moment checks remain outstanding.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (31,3,'gateway_tool','Gateway tool approval',
  'verified','447 exact gateway source and 448 Inbox projection bind bot/client/token/tool/risk/payload/expiry.',
  'verified','447 provisioned AAL2 Console decision and current source-state attestation; connected bearer reviewer decisions are refused.',
  'blocked','450 one-shot canonical execution claim, duplicate denial, immutable final status and result digest. Connected gateway claims before adapter work and records its result or an indeterminate state.',
  'Run a connected gateway-to-runtime-to-Inbox test, reconcile legacy SQLite approvals, add provider-specific prewrite checks and provider receipts, and surface execution outcomes in the Console.');
