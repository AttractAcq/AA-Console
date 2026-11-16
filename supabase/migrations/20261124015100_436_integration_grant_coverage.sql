-- Exact new-version decisions are in place. Legacy connected rows and live
-- provider capability remain unverified, so the class is still blocked.
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
 (28,2,'integration_grant','Integration credential/ingest grant',
  'blocked','433 pending_grant source, exact account/scope/expiry/secret-version packet; 434 Inbox projection. Existing connected rows have no grant review.',
  'verified','433 AAL2 admin decision releases one exact credential version and optional daily ingest; direct promotion and direct enable are guarded.',
  'blocked','433 status excludes newly stored credentials from integration_secret and integration_usable until approval; daily ingest off is immediate. Legacy grants, manual backfill and provider identity/scope read-back remain open.',
  'Audit legacy connected credentials and queued jobs; bind live provider account and scopes to the grant and pre-execution checks before release.');
