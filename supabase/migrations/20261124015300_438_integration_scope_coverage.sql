insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (28,3,'integration_grant','Integration credential/ingest grant',
  'blocked','433 exact pending-grant packet; 434 Inbox state; 436 account/Page/Pixel and expiry-extension changes revoke current credential use. Legacy connected rows remain unaudited.',
  'verified','433 AAL2 admin decision releases one exact secret version and optional daily ingest; direct status and ingest promotion are guarded.',
  'blocked','433 shared secret reader and scheduler reject pending_grant; 436 scope changes return to pending_grant and stop ingest. Live provider identity/scopes and legacy grants are not verified.',
  'Audit legacy connected credentials and queued jobs; add live provider account/scope read-back and an exact manual-backfill review before release.');
