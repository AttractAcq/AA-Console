-- Bind each lead-magnet courier attempt to its exact approved request and quarantine ambiguous sends.
begin;
alter table public.lead_magnet_deliveries
 add column attempt_request_id uuid references public.approval_requests_v6(id);
alter table public.lead_magnet_deliveries drop constraint lead_magnet_deliveries_status_check;
alter table public.lead_magnet_deliveries add constraint lead_magnet_deliveries_status_check
 check (status in ('queued','sending','sent','failed','cancelled','uncertain'));

create table public.lead_magnet_delivery_attempts_v6 (
 id uuid primary key default gen_random_uuid(),
 delivery_id uuid not null references public.lead_magnet_deliveries(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 request_id uuid not null references public.approval_requests_v6(id),
 attempt_no integer not null check (attempt_no>0),
 outcome text not null check (outcome in ('sending','provider_accepted','retryable_failure','failed','uncertain','cancelled')),
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 provider_ref text,
 error text,
 unique(delivery_id,attempt_no)
);
create index lead_magnet_delivery_attempts_request_v6
 on public.lead_magnet_delivery_attempts_v6(request_id,started_at desc);
alter table public.lead_magnet_delivery_attempts_v6 enable row level security;
create policy lead_magnet_delivery_attempts_read_v6
 on public.lead_magnet_delivery_attempts_v6 for select to authenticated
 using (public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id));
revoke all on public.lead_magnet_delivery_attempts_v6 from public,anon,authenticated,service_role;
grant select on public.lead_magnet_delivery_attempts_v6 to authenticated,service_role;

create function public.record_lead_magnet_attempt_transition_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.status='sending' and old.status is distinct from 'sending' then
  if new.attempt_request_id is null or new.attempts<=old.attempts
   or not exists(select 1 from public.approval_requests_v6 r
     join public.lead_magnet_approvals a on a.id::text=r.source_id
      and a.client_id=r.client_id and a.magnet_version_id=new.magnet_version_id
     where r.id=new.attempt_request_id and r.client_id=new.client_id
      and r.source_system='aa_console' and r.source_kind='lead_magnet'
      and r.source_version=a.payload_hash and a.status='approved'
      and a.inbox_enforced_v6)
   then raise exception 'A current exact lead magnet approval must own the send attempt.' using errcode='23514'; end if;
  insert into public.lead_magnet_delivery_attempts_v6
   (delivery_id,client_id,request_id,attempt_no,outcome)
  values(new.id,new.client_id,new.attempt_request_id,new.attempts,'sending');
 elsif old.status='sending' and new.status is distinct from 'sending' then
  update public.lead_magnet_delivery_attempts_v6 t set
   outcome=case new.status when 'sent' then 'provider_accepted'
     when 'queued' then 'retryable_failure' else new.status end,
   finished_at=now(),provider_ref=new.provider_ref,error=new.last_error
  where t.delivery_id=new.id and t.attempt_no=old.attempts
   and t.request_id=old.attempt_request_id and t.outcome='sending';
  if not found then raise exception 'The lead magnet send attempt is missing.' using errcode='23514'; end if;
 end if;
 return new;
end $$;
create trigger lead_magnet_attempt_transition_v6
 after update of status on public.lead_magnet_deliveries
 for each row execute function public.record_lead_magnet_attempt_transition_v6();

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
    when not a.inbox_enforced_v6 then 'Historical approval lacks an exact Inbox decision; audit and reapprove before sending.'
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
    when d.status = 'uncertain' then 'Provider effect is uncertain; inspect the provider before any retry.'
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
left join lateral (
 select x.* from public.lead_magnet_approvals x
 where x.magnet_version_id=d.magnet_version_id and x.client_id=d.client_id
  and x.status in ('approved','revoked')
 order by (x.status='approved') desc,x.requested_at desc,x.id desc limit 1
) a on true
left join public.client_engine_settings ces on ces.client_id = d.client_id;

create or replace function public.claim_lead_magnet_deliveries(p_limit integer default 5)
returns table (
  delivery_id uuid, client_id uuid, magnet_version_id uuid, channel text,
  recipient text, storage_path text, media_type text, content_sha256 text,
  delivery_subject text, delivery_body text, magnet_name text, attempt integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 if auth.role()<>'service_role' then
  raise exception 'Only the internal service may claim a delivery.';
 end if;
 return query
 with ready as (
  select d.id,r.id as request_id from public.lead_magnet_deliveries d
  join public.lead_magnet_approvals a on a.magnet_version_id=d.magnet_version_id
   and a.client_id=d.client_id and a.status='approved' and a.inbox_enforced_v6
  join public.approval_requests_v6 r on r.client_id=a.client_id
   and r.source_system='aa_console' and r.source_kind='lead_magnet'
   and r.source_id=a.id::text and r.source_version=a.payload_hash
  where d.status in ('queued','failed')
   and exists(select 1 from public.lead_magnet_due u
     where u.delivery_id=d.id and u.blocker is null)
  order by d.created_at limit greatest(coalesce(p_limit,5),1)
  for update of d skip locked
 ), claimed as (
  update public.lead_magnet_deliveries d
   set status='sending',claimed_at=now(),lease_until=now()+interval '10 minutes',
    attempts=d.attempts+1,attempt_request_id=r.request_id
  from ready r where d.id=r.id returning d.*
 )
 select c.id,c.client_id,c.magnet_version_id,c.channel,c.recipient,
  v.storage_path,v.media_type,v.content_sha256,v.delivery_subject,v.delivery_body,
  m.name,c.attempts
 from claimed c
 join public.lead_magnet_versions v on v.id=c.magnet_version_id
 join public.lead_magnets m on m.id=v.magnet_id;
end $$;

create function public.lead_magnet_send_ready_v6(
 p_delivery_id uuid,p_attempt integer)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 if auth.role()<>'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 return exists(select 1 from public.lead_magnet_deliveries d
  join public.approval_requests_v6 r on r.id=d.attempt_request_id
   and r.client_id=d.client_id and r.source_system='aa_console'
   and r.source_kind='lead_magnet'
  join public.lead_magnet_approvals a on a.id::text=r.source_id
   and a.client_id=d.client_id and a.magnet_version_id=d.magnet_version_id
   and a.status='approved' and a.inbox_enforced_v6
   and a.payload_hash=r.source_version
  join public.lead_magnet_delivery_attempts_v6 t on t.delivery_id=d.id
   and t.client_id=d.client_id and t.request_id=d.attempt_request_id
   and t.attempt_no=p_attempt and t.outcome='sending'
  join public.lead_magnet_due u on u.delivery_id=d.id
  where d.id=p_delivery_id and d.status='sending'
   and d.attempt_request_id is not null and d.attempts=p_attempt
   and d.lease_until>now() and u.blocker='Being sent now.');
end $$;

create or replace function public.reap_stale_lead_magnet_deliveries()
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 update public.lead_magnet_deliveries
  set status='uncertain',lease_until=null,
   last_error='The send stopped without recording an outcome. Check the provider before any retry.'
  where status='sending' and lease_until is not null and lease_until<now();
 get diagnostics v_count=row_count;
 return v_count;
end $$;

create view public.lead_magnet_approval_execution_evidence_v6
with (security_barrier=true) as
select r.id as request_id,r.client_id,'lead_magnet'::text as source_kind,
 case
  when count(t.id) filter(where t.outcome='uncertain')>0 then 'uncertain'
  when count(t.id) filter(where t.outcome='failed')>0 then 'failed'
  when count(t.id) filter(where t.outcome='sending')>0 then 'sending'
  when count(t.id) filter(where t.outcome='provider_accepted')>0 then 'unverified'
  when count(t.id)>0 then 'retryable_failure'
  else 'not_attempted' end as state,
 count(t.id)::text||' attempt(s): '
  ||(count(t.id) filter(where t.outcome='provider_accepted'))::text||' provider accepted, '
  ||(count(t.id) filter(where t.outcome='failed'))::text||' failed, '
  ||(count(t.id) filter(where t.outcome='uncertain'))::text||' uncertain. '
  ||'Provider acceptance does not prove recipient delivery.' as detail,
 null::text as external_ref
from public.approval_requests_v6 r
join public.lead_magnet_approvals a on a.id::text=r.source_id
 and a.client_id=r.client_id and a.inbox_enforced_v6
left join public.lead_magnet_delivery_attempts_v6 t
 on t.request_id=r.id and t.client_id=r.client_id
where r.source_system='aa_console' and r.source_kind='lead_magnet'
 and (public.is_admin() or auth.uid()=public.active_video_approval_manager(r.client_id))
group by r.id,r.client_id;
revoke all on public.lead_magnet_approval_execution_evidence_v6
 from public,anon,authenticated,service_role;
grant select on public.lead_magnet_approval_execution_evidence_v6
 to authenticated,service_role;
comment on view public.lead_magnet_approval_execution_evidence_v6 is
 'Exact Inbox approval to courier attempts for all consented recipients; provider acceptance is not recipient delivery.';

revoke all on function public.record_lead_magnet_attempt_transition_v6()
 from public,anon,authenticated,service_role;
revoke all on function public.lead_magnet_send_ready_v6(uuid,integer)
 from public,anon,authenticated,service_role;
grant execute on function public.lead_magnet_send_ready_v6(uuid,integer) to service_role;
insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 c.source_state,c.source_evidence,c.decision_state,c.decision_evidence,
 'blocked','503 exact request-bound courier attempts, pre-send recheck and ambiguous-send quarantine',
 'Provider sender identity, recipient readback and a live authorized test receipt remain unverified.'
from public.approval_class_coverage_v6 c where c.class_id=7;
select public.lock_down_definer_functions();
commit;
