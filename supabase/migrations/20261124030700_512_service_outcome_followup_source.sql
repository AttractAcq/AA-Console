-- A sale is not proof that work was completed. Outcome follow-up needs an
-- independently reviewed service result before its message enters the Inbox.
begin;
create table public.proof_service_outcomes_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  lead_id uuid not null references public.client_leads(id) on delete restrict,
  outcome_summary text not null check (length(btrim(outcome_summary)) between 10 and 5000),
  occurred_at timestamptz not null,
  evidence_source text not null check (length(btrim(evidence_source)) between 3 and 500),
  evidence_note text not null check (length(btrim(evidence_note)) between 10 and 5000),
  evidence_url text,
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  verified_by uuid references public.profiles(id) on delete restrict,
  verified_at timestamptz,
  withdrawn_at timestamptz,
  withdrawal_reason text,
  unique(id,client_id,lead_id),
  constraint proof_service_outcome_verification_pair_v7 check
    ((verified_by is null)=(verified_at is null))
);
create index proof_service_outcomes_client_v7
  on public.proof_service_outcomes_v7(client_id,lead_id,recorded_at desc);
alter table public.proof_service_outcomes_v7 enable row level security;
create policy proof_service_outcomes_read_v7 on public.proof_service_outcomes_v7
  for select to authenticated
  using (public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id));
create policy proof_service_outcomes_insert_v7 on public.proof_service_outcomes_v7
  for insert to authenticated
  with check (public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id));
create policy proof_service_outcomes_update_v7 on public.proof_service_outcomes_v7
  for update to authenticated
  using (public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id))
  with check (public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id));
revoke all on public.proof_service_outcomes_v7 from public,anon,authenticated;
grant select,insert,update on public.proof_service_outcomes_v7 to authenticated;
grant select on public.proof_service_outcomes_v7 to service_role;

create function public.guard_proof_service_outcome_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare l public.client_leads%rowtype;
begin
  if tg_op='INSERT' then
    if auth.role()<>'authenticated' or auth.uid() is null
       or new.recorded_by is distinct from auth.uid()
       or new.verified_by is not null or new.verified_at is not null
       or new.withdrawn_at is not null or new.occurred_at>now()
       or new.occurred_at<now()-interval '2 years' then
      raise exception 'Record a dated, unverified service outcome as the signed-in owner.'
        using errcode='23514';
    end if;
    select * into l from public.client_leads
      where id=new.lead_id and client_id=new.client_id;
    if l.id is null or l.stage not in ('sale','cash') then
      raise exception 'Choose a customer with a recorded sale or cash outcome.'
        using errcode='23514';
    end if;
    return new;
  end if;
  if (to_jsonb(new)-'verified_by'-'verified_at'-'withdrawn_at'-'withdrawal_reason')
     is distinct from (to_jsonb(old)-'verified_by'-'verified_at'-'withdrawn_at'-'withdrawal_reason')
     then raise exception 'Service outcome evidence is immutable; record a new outcome.'
       using errcode='23514'; end if;
  if old.withdrawn_at is not null then
    raise exception 'A withdrawn service outcome cannot change.' using errcode='23514'; end if;
  if new.withdrawn_at is distinct from old.withdrawn_at then
    if new.withdrawn_at is null or new.withdrawn_at<old.recorded_at
       or new.withdrawn_at>now()
       or nullif(btrim(coalesce(new.withdrawal_reason,'')),'') is null
       or new.verified_by is distinct from old.verified_by
       or new.verified_at is distinct from old.verified_at then
      raise exception 'Record a current withdrawal and its reason.' using errcode='23514'; end if;
    return new;
  end if;
  if old.verified_at is not null or new.verified_by is distinct from auth.uid()
     or new.verified_at is null or new.verified_at<old.recorded_at
     or new.verified_at>now() or auth.role()<>'authenticated'
     or coalesce(auth.jwt()->>'aal','')<>'aal2'
     or new.withdrawal_reason is distinct from old.withdrawal_reason then
    raise exception 'A provisioned AAL2 reviewer must verify the recorded outcome.'
      using errcode='42501';
  end if;
  return new;
end $$;
create trigger proof_service_outcome_guard_v7
  before insert or update on public.proof_service_outcomes_v7
  for each row execute function public.guard_proof_service_outcome_v7();

alter table public.proof_request_deliveries
  add column outcome_event_id uuid references public.proof_service_outcomes_v7(id) on delete restrict;

create or replace function public.proof_outcome_followup_ready_v7(d public.proof_request_deliveries)
returns boolean language sql stable security definer
set search_path=pg_catalog,public as $$
  select d.outcome_lead_id is not null and d.outcome_event_id is not null and exists (
    select 1 from public.proof_outcome_followup_consents_v7 c
    join public.client_leads l on l.id=c.lead_id and l.client_id=c.client_id
    join public.proof_capture_configs config on config.id=d.config_id
      and config.client_id=d.client_id and config.method='outcome_followup'
    join public.proof_service_outcomes_v7 event on event.id=d.outcome_event_id
      and event.client_id=d.client_id and event.lead_id=l.id
    where c.id=d.outcome_consent_id and c.client_id=d.client_id
      and c.lead_id=d.outcome_lead_id and c.withdrawn_at is null
      and event.verified_at is not null and event.withdrawn_at is null
      and l.stage in ('sale','cash')
      and c.channel=d.channel and c.recipient=d.recipient
      and ((d.channel='email' and lower(btrim(l.email))=lower(btrim(d.recipient)))
        or (d.channel in ('sms','whatsapp') and btrim(l.phone)=btrim(d.recipient)))
      and (config.trigger_event='service_completed'
        or config.trigger_event is null or config.trigger_event=l.stage::text));
$$;

create or replace function public.guard_proof_outcome_delivery_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare method text;
begin
  select c.method into method from public.proof_capture_configs c
    where c.id=new.config_id and c.client_id=new.client_id;
  if method='outcome_followup' then
    if not public.proof_outcome_followup_ready_v7(new) then
      raise exception 'Outcome request needs a verified service result and current proof follow-up consent.'
        using errcode='23514';
    end if;
  elsif new.outcome_lead_id is not null or new.outcome_consent_id is not null
     or new.outcome_event_id is not null then
    raise exception 'Only outcome follow-up may bind a lead, result and consent.' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger proof_outcome_delivery_guard_v7 on public.proof_request_deliveries;
create trigger proof_outcome_delivery_guard_v7 before insert or update of
  client_id,config_id,recipient,channel,outcome_lead_id,outcome_consent_id,outcome_event_id
  on public.proof_request_deliveries for each row
  execute function public.guard_proof_outcome_delivery_v7();

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
 'consequence','Send this exact proof request to this recipient through the configured provider')
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
 where d.id=q.delivery_id and d.client_id=q.client_id;
$$;

create or replace view public.proof_outcome_followup_submissions_v7
with (security_barrier=true) as
select d.client_id,d.outcome_lead_id as lead_id,d.id as delivery_id,
  s.id as submission_id,s.proof_id,s.created_at as submitted_at,
  d.outcome_event_id
from public.proof_request_deliveries d
join public.proof_capture_submissions s on s.link_id=d.link_id and s.client_id=d.client_id
where d.outcome_lead_id is not null and public.can_access_client(d.client_id);

revoke all on function public.guard_proof_service_outcome_v7()
  from public,anon,authenticated,service_role;
commit;
