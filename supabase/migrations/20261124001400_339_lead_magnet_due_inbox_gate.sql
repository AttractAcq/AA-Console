-- New approvals can release owed delivery only with their exact AAL2 decision.
-- Historical decisions are not fabricated as AAL2; consent checks apply to all.
begin;
create or replace view public.lead_magnet_due with (security_invoker = true) as
select
  d.id as delivery_id,
  d.client_id,
  d.submission_id,
  d.lead_id,
  d.magnet_version_id,
  m.name as magnet_name,
  d.channel,
  d.recipient,
  d.status,
  d.attempts,
  d.provider_ref,
  d.last_error,
  case
    when a.id is null then 'Nobody has approved this magnet.'
    when a.status = 'revoked' then
      'The approval was revoked: ' || coalesce(a.revoked_reason,'no reason recorded') || '.'
    when a.status <> 'approved' then 'The approval is ' || a.status || '.'
    when a.payload_hash <> public.lead_magnet_payload_hash_v6(d.magnet_version_id)
      then 'The file or the message changed after approval. Ask again.'
    when v.client_id is distinct from d.client_id
      or d.channel is distinct from v.delivery_channel
      or s.id is null or s.client_id is distinct from d.client_id
      or s.status <> 'promoted' or ep.id is null
      or ep.client_id is distinct from d.client_id
      or ep.purpose <> 'magnet_optin'
      or ep.magnet_version_id is distinct from d.magnet_version_id
      or nullif(btrim(s.consent_wording),'') is null
      or s.consent_wording is distinct from ep.consent_wording
      or s.consent_given_at is null
      or (d.channel = 'email' and lower(btrim(d.recipient))
        is distinct from lower(btrim(coalesce(s.email,''))))
      then 'The same-client opt-in, consent, endpoint or recipient is unverified.'
    when a.inbox_enforced_v6 and not exists (
      select 1 from public.approval_requests_v6 r
      join public.approval_request_evidence_v6 e on e.request_id = r.id
      join lateral (
        select x.* from public.approval_decision_events_v6 x
        where x.request_id = r.id order by x.event_order desc limit 1
      ) decision on true
      where r.source_system = 'aa_console' and r.source_kind = 'lead_magnet'
        and r.source_id = a.id::text and r.source_version = a.payload_hash
        and r.client_id = a.client_id
        and e.artifact_hash = a.payload_hash
        and e.preview->>'verified_content_sha256' = v.content_sha256
        and e.preview->>'verified_file_bytes' = v.file_bytes::text
        and decision.decision = 'approved' and decision.actor_aal = 'aal2'
        and decision.artifact_hash = a.payload_hash
        and decision.source_decision_ref =
          'lead_magnet_approvals:' || a.id::text || ':approved'
        and exists (select 1 from public.approval_inbox_v6 i
          where i.id = r.id and i.status = 'approved' and i.preview_blocker is null)
    ) then 'The exact AAL2 Inbox approval or stored-file attestation is missing.'
    when not coalesce(ces.lead_magnet_delivery_enabled,false)
      then 'Magnet delivery is off for this client.'
    when d.status = 'sent' then 'Already sent.'
    when d.status = 'cancelled' then 'Cancelled.'
    when d.status = 'sending' and d.lease_until > now() then 'Being sent now.'
    when d.attempts >= 5 then
      'Failed ' || d.attempts::text || ' times. Last error: '
        || coalesce(d.last_error,'none recorded') || '.'
    else null
  end as blocker
from public.lead_magnet_deliveries d
join public.lead_magnet_versions v on v.id = d.magnet_version_id
join public.lead_magnets m on m.id = v.magnet_id
left join public.lead_submissions s on s.id = d.submission_id
left join public.lead_capture_endpoints ep on ep.id = s.endpoint_id
left join public.lead_magnet_approvals a
  on a.magnet_version_id = d.magnet_version_id
    and a.status in ('approved','revoked')
left join public.client_engine_settings ces on ces.client_id = d.client_id;
grant select on public.lead_magnet_due to authenticated;
commit;
