-- Bind proof-request approval to the sender identity used by the runtime.
-- Existing requests remain readable, but need a fresh sender-bound request.
begin;
alter table public.proof_request_deliveries
  add column sender_ref text check (length(sender_ref) between 8 and 400);

create function public.guard_proof_delivery_sender_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if old.sender_ref is distinct from new.sender_ref then
  raise exception 'A proof request sender cannot be changed; queue a new delivery.' using errcode='23514';
 end if;
 return new;
end $$;
create trigger proof_delivery_sender_immutable_v6
 before update of sender_ref on public.proof_request_deliveries
 for each row execute function public.guard_proof_delivery_sender_v6();
revoke all on function public.guard_proof_delivery_sender_v6() from public,anon,authenticated,service_role;

create or replace function public.proof_delivery_preview_v6(q public.proof_delivery_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',d.client_id,'delivery_id',d.id,
 'request_token',q.request_token,'config_id',d.config_id,'link_id',d.link_id,
 'channel',d.channel,'recipient',d.recipient,'subject',d.subject,
 'message',d.message,'capture_url',d.capture_url,
 'template_sid',d.template_sid,'template_variables',d.template_variables,
 'scheduled_at',d.scheduled_at,'link_expires_at',l.expires_at,
 'link_revoked_at',l.revoked_at,'link_submissions',l.submissions,
 'link_max_submissions',l.max_submissions,
 'consequence',case when d.sender_ref is null
  then 'Send this exact proof request to this recipient through the configured provider'
  else 'Send this exact proof request from the reviewed sender to this recipient' end)
 || case when d.sender_ref is null then '{}'::jsonb
  else jsonb_build_object('sender_ref',d.sender_ref) end
 || case when d.outcome_lead_id is null then '{}'::jsonb else jsonb_build_object(
 'outcome_lead_id',d.outcome_lead_id,'outcome_consent_id',d.outcome_consent_id,
 'outcome_stage',lead.stage,'outcome_stage_at',lead.stage_at,
 'outcome_sale_value',lead.sale_value,'outcome_cash_collected',lead.cash_collected,
 'outcome_consent_text',consent.consent_text,
 'outcome_consent_evidence',consent.evidence_note,
 'outcome_consented_at',consent.consented_at,
 'outcome_consent_withdrawn_at',consent.withdrawn_at,
 'outcome_event_id',event.id,'service_outcome',event.outcome_summary,
 'service_outcome_date',event.occurred_at,'service_evidence_source',event.evidence_source,
 'service_evidence_note',event.evidence_note,'service_evidence_url',event.evidence_url,
 'service_verified_at',event.verified_at,'service_withdrawn_at',event.withdrawn_at,
 'outcome_ready',public.proof_outcome_followup_ready_v7(d)) end
 from public.proof_request_deliveries d
 join public.proof_capture_links l on l.id=d.link_id and l.client_id=d.client_id and l.config_id=d.config_id
 join public.proof_capture_configs c on c.id=d.config_id and c.client_id=d.client_id
 left join public.client_leads lead on lead.id=d.outcome_lead_id and lead.client_id=d.client_id
 left join public.proof_outcome_followup_consents_v7 consent on consent.id=d.outcome_consent_id
   and consent.client_id=d.client_id and consent.lead_id=d.outcome_lead_id
 left join public.proof_service_outcomes_v7 event on event.id=d.outcome_event_id
   and event.client_id=d.client_id and event.lead_id=d.outcome_lead_id
 where d.id=q.delivery_id and d.client_id=q.client_id
   and (d.sender_ref is not null or d.status in ('sent','uncertain'));
$$;
commit;
