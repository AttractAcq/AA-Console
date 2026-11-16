-- Describe the current artifact signoff, not merely a historical row.
begin;
create or replace view proof_placement_due with (security_invoker = true) as
select
  pl.id as placement_id,
  pl.client_id,
  pl.destination_key,
  d.label as destination_label,
  d.mode,
  pl.status,
  pl.attempts,
  pl.payload_hash,
  pl.source_proof_id,
  p.title as source_title,
  p.expires_on,
  case
    when p.id is null
      then 'The source proof is gone. This placement can never be made.'
    when p.usage_rights <> 'approved'
      then 'The source proof is not cleared for use.'
    when p.expires_on is not null and p.expires_on < current_date
      then 'Permission for this proof expired on ' || p.expires_on::text || '.'
    when nullif(btrim(p.permission_basis), '') is null
      then 'No permission basis is recorded for the source proof.'
    when pl.artifact_version_id is not null and not
      public.proof_artifact_signoff_current_v6(pl.artifact_version_id)
      then 'The artifact source and claim no longer have a current Inbox signoff.'
    when d.supported is not true
      then 'There is no adapter for ' || d.label || '.'
    when not coalesce(cpd.enabled, false)
      then d.label || ' is not switched on for this client.'
    when d.requires_integration and not public.integration_usable(pl.client_id, d.provider)
      then 'No usable ' || d.provider || ' integration for this client.'
    when not coalesce(ces.proof_publishing_enabled, false)
      then 'Proof distribution is off for this client.'
    when pl.approval_id is null
      then 'Nobody has approved this placement.'
    when a.status <> 'approved'
      then 'The placement approval is ' || a.status || '.'
    when a.payload_hash <> pl.payload_hash
      then 'The approved version is not the current one. Ask for approval again.'
    when not public.proof_placement_effect_allowed_v6(pl.id)
      then 'Current Inbox approval, proof rights or client destination controls are missing.'
    when d.mode <> 'api'
      then 'This destination is placed by ' || d.executor_module || ', not by the sweep.'
    else null
  end as blocker
from public.proof_placements pl
join public.proof_destinations d on d.destination_key = pl.destination_key
left join public.client_proof_assets p on p.id = pl.source_proof_id
left join public.client_proof_destinations cpd
  on cpd.client_id = pl.client_id and cpd.destination_key = pl.destination_key
left join public.client_engine_settings ces on ces.client_id = pl.client_id
left join public.proof_placement_approvals a on a.id = pl.approval_id
where pl.status in ('approved', 'queued', 'placing', 'awaiting_manual_placement', 'bound');

commit;
