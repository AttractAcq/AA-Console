-- Add proof-request sender outcomes to the shared external alert ledger. A
-- provider ID proves acceptance only, not recipient delivery.
begin;

alter table public.proof_request_deliveries
 add column attempt_started_at timestamptz,
 add column attempt_finished_at timestamptz;

create function public.proof_delivery_attempt_clock_v6()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.status='sending' and old.status is distinct from 'sending' then
  new.attempt_started_at:=now();
  new.attempt_finished_at:=null;
 elsif old.status='sending' and new.status is distinct from 'sending' then
  new.attempt_finished_at:=now();
 end if;
 return new;
end $$;
create trigger proof_delivery_attempt_clock_v6
 before update on public.proof_request_deliveries
 for each row execute function public.proof_delivery_attempt_clock_v6();

create or replace view public.client_external_outcomes_v6
with (security_barrier=true) as
select e.id as outcome_id,e.client_id,'campaign_action'::text as source_kind,
 case when e.status='executing' and (e.lease_until is null or e.lease_until<=now())
  then 'uncertain' else e.status end as outcome,
 coalesce(e.executed_at,e.updated_at) as occurred_at,
 coalesce(e.external_url,e.external_id) as external_ref,
 '/clients/'||e.client_id::text||'/delivery/approval-inbox?tab=campaign-actions' as owning_path
from public.campaign_action_executions e
where (e.status in ('executed','failed','abandoned','uncertain')
  or (e.status='executing' and (e.lease_until is null or e.lease_until<=now())))
 and (e.status<>'executed' or e.external_url is not null or e.external_id is not null)
 and (public.is_admin() or auth.uid()=public.active_video_approval_manager(e.client_id))
union all
select a.id,a.client_id,'google_review_reply',
 case when c.result='matched' then 'confirmed'
  when c.result in ('pending','rejected','different','unverified') then c.result
  when a.status='confirmed' and a.provider_state is distinct from 'APPROVED'
   then 'unverified'
  else a.status end,
 coalesce(c.checked_at,a.finished_at),
 case when c.result='matched'
  or (a.status='confirmed' and a.provider_state='APPROVED') then
  case when a.review_ref like 'accounts/%' then a.review_ref
   else a.location_ref||'/reviews/'||a.review_ref end
  else null end,
 '/clients/'||a.client_id::text||'/google-profile?tab=reviews'
from public.google_reply_execution_attempts_v6 a
left join lateral (select result,checked_at
 from public.google_reply_reconciliation_checks_v6 c
 where c.attempt_id=a.id
 order by (result='matched') desc,checked_at desc,id desc limit 1) c on true
where a.status in ('confirmed','refused','uncertain')
 and public.can_access_client(a.client_id)
union all
select g.id,g.client_id,'google_review_reply','unverified',
 coalesce(g.posted_at,g.updated_at),null,
 '/clients/'||g.client_id::text||'/google-profile?tab=reviews'
from public.google_review_replies g
where g.status='posted'
 and not exists(select 1 from public.google_reply_execution_attempts_v6 a
  where a.reply_id=g.id)
 and public.can_access_client(g.client_id)
union all
select a.id,a.client_id,'google_profile_change',
 case when c.result='matched' then 'confirmed'
  when c.result='different' then 'different' else a.status end,
 coalesce(c.checked_at,a.finished_at),
 case when c.result='matched' then c.provider_ref
  when a.status='confirmed' then a.provider_ref else null end,
 '/clients/'||a.client_id::text||'/google-profile?tab=location'
from public.google_profile_execution_attempts_v6 a
left join lateral (select result,checked_at,provider_ref
 from public.google_profile_reconciliation_checks_v6 c
 where c.attempt_id=a.id
 order by (result='matched') desc,checked_at desc,id desc limit 1) c on true
where a.status in ('confirmed','refused','uncertain')
 and public.can_access_client(a.client_id)
union all
select a.id,a.client_id,'meta_profile_change',
 case when c.result='matched' then 'confirmed'
  when c.result='different' then 'different' else a.status end,
 coalesce(c.checked_at,a.finished_at),
 case when c.result='matched' then c.provider_ref
  when a.status='confirmed' then a.provider_ref else null end,
 '/clients/'||a.client_id::text||'/meta-profile?tab=profile'
from public.meta_profile_execution_attempts_v6 a
left join lateral (select result,checked_at,provider_ref
 from public.meta_profile_reconciliation_checks_v6 c
 where c.attempt_id=a.id
 order by (result='matched') desc,checked_at desc,id desc limit 1) c on true
where a.status in ('confirmed','refused','uncertain')
 and public.can_access_client(a.client_id)
union all
select d.id,d.client_id,'proof_delivery',
 case when d.attempt_request_id is null then 'unattributed'
  when d.status='sending' then 'uncertain'
  when d.status='sent' and d.provider_id is not null then 'unverified'
  when d.status='sent' then 'uncertain'
  else d.status end,
 coalesce(d.attempt_finished_at,d.sent_at,d.lease_until,d.attempt_started_at,d.created_at),
 case when d.attempt_request_id is not null then d.provider_id else null end,
 '/clients/'||d.client_id::text||'/delivery/proof-production-factory?tab=capture'
from public.proof_request_deliveries d
where (d.status in ('sent','failed','uncertain')
 or (d.status='sending' and (d.lease_until is null or d.lease_until<=now())))
 and (public.is_admin() or auth.uid()=public.active_video_approval_manager(d.client_id));

revoke all on public.client_external_outcomes_v6 from public,anon,authenticated,service_role;
grant select on public.client_external_outcomes_v6 to authenticated,service_role;
comment on view public.client_external_outcomes_v6 is
 'Client-scoped external outcomes, including proof-request provider attempts. A provider ID is unverified recipient delivery; historical attempts without an exact approval binding are unattributed.';

select public.lock_down_definer_functions();
commit;
