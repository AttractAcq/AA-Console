-- Approval inventory records the implemented path and its remaining live proof.
begin;
insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
  (7,2,'lead_magnet','Lead magnet approval',
    'verified','335/336 exact file, route, words and consented-recipient scope; trusted storage-byte attestation',
    'verified','337 AAL2 source and canonical Inbox decision; rollback fixture covers stale bytes, wrong actor and revocation',
    'blocked','338 due view checks same-client opt-in, consent, endpoint, switch and current exact AAL2 decision; courier rehashes bytes before send',
    'An authorized provider send and observed receipt have not been verified for this path.');
commit;
