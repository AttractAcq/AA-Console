-- A canonical request and AAL2 decision now exist for connected gateway tool
-- cards. Executor completion still needs per-adapter prewrite attestation and
-- real outcome receipts before this class is operational.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (31,2,'gateway_tool','Gateway tool approval',
  'verified','447 freezes bot, client, current token, exact tool and payload; 448 projects the source into Unified Inbox. Connected gateway registers before persisting a local card.',
  'verified','447 requires a provisioned AAL2 Console admin decision; connected gateway disables bearer-token decisions and rechecks canonical attestation before execution.',
  'blocked','Connected gateway requires the exact canonical request ID and payload hash, fresh bot identity, current client/tool grant and repeated decision attestation. SQLite remains an execution journal.',
  'Audit legacy SQLite cards and run a connected gateway-to-runtime-to-Inbox integration test. Every outward adapter needs an atomic or last-moment provider prewrite check and an observed result receipt.');
