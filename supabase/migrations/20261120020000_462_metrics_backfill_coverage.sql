insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (28,4,'integration_grant','Integration credential/ingest grant',
 'blocked','433 exact credential grant; 460 frozen one-off metrics window, surfaces and credential versions; legacy connected rows remain unaudited.',
 'verified','433 AAL2 access grant; 460 AAL2 exact backfill Inbox decision before job insertion.',
 'blocked','460 manual metrics jobs require review; ordinary metrics jobs require the trusted scheduler. Provider account/scope and external pull outcomes remain unverified.',
 'Audit legacy credentials and queued jobs; verify provider identity and scopes live, then record a real authorized metrics read and outcome.');
