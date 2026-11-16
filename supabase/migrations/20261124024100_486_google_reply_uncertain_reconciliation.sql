-- A later GET may resolve one uncertain reply PUT without repeating it.
begin;

create table public.google_reply_reconciliation_checks_v6 (
 id uuid primary key default gen_random_uuid(),
 attempt_id uuid not null references public.google_reply_execution_attempts_v6(id) on delete restrict,
 client_id uuid not null references public.clients(id) on delete restrict,
 review_ref text not null,
 observed_body_hash text,
 provider_update_time text,
 provider_state text,
 result text not null check (result in ('matched','pending','rejected','different','unverified')),
 checked_at timestamptz not null default clock_timestamp()
);
create index google_reply_reconciliation_attempt_idx
 on public.google_reply_reconciliation_checks_v6(attempt_id,checked_at desc,id desc);
alter table public.google_reply_reconciliation_checks_v6 enable row level security;
revoke all on public.google_reply_reconciliation_checks_v6
 from public,anon,authenticated,service_role;

create function public.google_reply_reconciliation_target_v6(p_attempt_id uuid,p_client_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare a public.google_reply_execution_attempts_v6%rowtype;
begin
 if auth.role() is distinct from 'service_role' then return null; end if;
 select * into a from public.google_reply_execution_attempts_v6
  where id=p_attempt_id and client_id=p_client_id and status='uncertain';
 if a.id is null or not exists(select 1 from public.google_review_replies g
  join public.google_reviews v on v.id=g.review_id and v.client_id=g.client_id
  join public.client_google_locations l on l.id=v.location_id and l.client_id=v.client_id
  where g.id=a.reply_id and g.client_id=a.client_id and g.body_hash=a.body_hash
   and l.location_ref=a.location_ref)
  or not public.google_reply_credential_eligible_v6(a.client_id) then return null; end if;
 return jsonb_build_object('attempt_id',a.id,'client_id',a.client_id,
  'reply_id',a.reply_id,'location_ref',a.location_ref,'review_ref',a.review_ref);
end $$;

create or replace function public.guard_google_reply_inbox_status_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' then
  if new.status not in ('drafted','awaiting_approval')
   or new.approved_by is not null or new.approved_at is not null
   or new.rejection_reason is not null then
   raise exception 'A Google reply must start as an undecided draft.' using errcode='23514';
  end if;
  return new;
 end if;
 if old.status in ('approved','posting','posted')
  and (new.client_id,new.review_id,new.body,new.body_hash,new.approved_by,new.approved_at)
   is distinct from
      (old.client_id,old.review_id,old.body,old.body_hash,old.approved_by,old.approved_at) then
  raise exception 'The approved Google reply and target are immutable.' using errcode='23514';
 end if;
 if new.status in ('drafted','awaiting_approval')
  and (new.approved_by is not null or new.approved_at is not null
   or new.rejection_reason is not null) then
  raise exception 'An undecided Google reply cannot carry decision metadata.' using errcode='23514';
 end if;
 if new.status='approved'
  and old.status not in ('drafted','awaiting_approval','approved') then
  raise exception 'Only an undecided Google reply can enter approved state.' using errcode='23514';
 end if;
 if old.status in ('approved','rejected','posting','posted','failed')
  and new.status is distinct from old.status
  and not (old.status='approved' and new.status='posted') then
  raise exception 'A decided Google reply cannot restart or change state.' using errcode='23514';
 end if;
 if new.status='posted' and old.status is distinct from 'posted' then
  if old.status<>'approved' or auth.role() is distinct from 'service_role'
   or new.posted_at is null or new.external_ref is null
   or not exists(select 1 from public.google_reply_execution_attempts_v6 a
    where a.reply_id=new.id and a.client_id=new.client_id
     and a.body_hash=new.body_hash
     and new.external_ref=case when a.review_ref like 'accounts/%'
       then a.review_ref else a.location_ref||'/reviews/'||a.review_ref end
     and ((a.status='confirmed' and a.observed_body_hash=a.body_hash
       and a.provider_state='APPROVED')
      or (a.status='uncertain' and exists(select 1
       from public.google_reply_reconciliation_checks_v6 c
       where c.attempt_id=a.id and c.client_id=a.client_id
        and c.result='matched' and c.observed_body_hash=a.body_hash
        and c.review_ref=new.external_ref)))) then
   raise exception 'Google reply posted status requires an exact provider readback.'
    using errcode='42501';
  end if;
 elsif new.status='posting' and old.status is distinct from 'posting' then
  raise exception 'Google reply sending requires a bound exact-version executor.'
   using errcode='23514';
 end if;
 return new;
end $$;

create function public.record_google_reply_reconciliation_v6(
 p_attempt_id uuid,p_client_id uuid,p_review_ref text,p_observed_body_hash text,
 p_provider_update_time text,p_provider_state text)
returns text language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.google_reply_execution_attempts_v6%rowtype;
 expected_ref text; result_value text;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Only the trusted review reader may reconcile a reply.' using errcode='42501'; end if;
 select * into a from public.google_reply_execution_attempts_v6
  where id=p_attempt_id and client_id=p_client_id for update;
 if a.id is null or a.status<>'uncertain'
  or not public.google_reply_credential_eligible_v6(a.client_id) then
  raise exception 'The uncertain reply attempt or credential is unavailable.' using errcode='23514'; end if;
 expected_ref:=case when a.review_ref like 'accounts/%' then a.review_ref
  else a.location_ref||'/reviews/'||a.review_ref end;
 if p_review_ref is distinct from expected_ref
  or (p_observed_body_hash is not null and p_observed_body_hash !~ '^[0-9a-f]{64}$') then
  raise exception 'The provider review reference or hash is invalid.' using errcode='23514'; end if;
 if exists(select 1 from public.google_reply_reconciliation_checks_v6 c
  where c.attempt_id=a.id and c.result='matched') then return 'matched'; end if;
 result_value:=case
  when p_provider_state='REJECTED' then 'rejected'
  when p_observed_body_hash is distinct from a.body_hash then 'different'
  when p_provider_state='APPROVED' then 'matched'
  when p_provider_state='PENDING' then 'pending'
  else 'unverified' end;
 insert into public.google_reply_reconciliation_checks_v6
  (attempt_id,client_id,review_ref,observed_body_hash,provider_update_time,provider_state,result)
 values (a.id,a.client_id,p_review_ref,p_observed_body_hash,
  p_provider_update_time,p_provider_state,result_value);
 if result_value='matched' then
  update public.google_review_replies g
   set status='posted',posted_at=clock_timestamp(),external_ref=p_review_ref,
    lease_until=null,last_error=null
   where g.id=a.reply_id and g.client_id=a.client_id
    and g.status='approved' and g.body_hash=a.body_hash;
 end if;
 return result_value;
end $$;

create or replace view public.google_reply_execution_overview_v6
with (security_barrier=true) as
select a.id as attempt_id,a.reply_id,a.client_id,a.approval_request_id,
 a.status,a.reserved_at,a.started_at,a.finished_at,a.observed_body_hash,
 a.provider_update_time,a.provider_state,a.outcome_note,
 c.result as reconciliation_result,c.checked_at as reconciled_at,
 c.provider_state as reconciled_provider_state
from public.google_reply_execution_attempts_v6 a
left join lateral (select result,checked_at,provider_state
 from public.google_reply_reconciliation_checks_v6 c
 where c.attempt_id=a.id
 order by (result='matched') desc,checked_at desc,id desc limit 1) c on true
where public.can_access_client(a.client_id);

revoke all on function public.google_reply_reconciliation_target_v6(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.google_reply_reconciliation_target_v6(uuid,uuid) to service_role;
revoke all on function public.guard_google_reply_inbox_status_v6()
 from public,anon,authenticated,service_role;
revoke all on function public.record_google_reply_reconciliation_v6(uuid,uuid,text,text,text,text)
 from public,anon,authenticated,service_role;
grant execute on function public.record_google_reply_reconciliation_v6(uuid,uuid,text,text,text,text)
 to service_role;
revoke all on public.google_reply_execution_overview_v6
 from public,anon,authenticated,service_role;
grant select on public.google_reply_execution_overview_v6 to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (21,6,'google_review_reply','Google review reply',
 'verified','278 exact reply preview and AAL2 source decision',
 'verified','458 owner-requested sender; 485 later readback guard',
 'blocked','457 one-shot attempt; 477 confirmed source; 485 later GET-only observation contract',
 'Connect trusted read-only reconciliation, verify live account/scope, audit legacy replies and obtain an authorized provider receipt.');

select public.lock_down_definer_functions();
commit;
