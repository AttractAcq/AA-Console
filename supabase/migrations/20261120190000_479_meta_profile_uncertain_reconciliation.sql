-- Resolve an uncertain Page write through a later provider read only. The
-- original one-shot attempt remains uncertain for audit and cannot POST again.
begin;

create table public.meta_profile_reconciliation_checks_v6 (
 id uuid primary key default gen_random_uuid(),
 attempt_id uuid not null references public.meta_profile_execution_attempts_v6(id) on delete restrict,
 client_id uuid not null references public.clients(id) on delete restrict,
 observed_value text,
 provider_ref text not null,
 result text not null check (result in ('matched','different')),
 checked_at timestamptz not null default clock_timestamp()
);
create index meta_profile_reconciliation_checks_attempt_idx
 on public.meta_profile_reconciliation_checks_v6(attempt_id,checked_at desc,id desc);
alter table public.meta_profile_reconciliation_checks_v6 enable row level security;
revoke all on public.meta_profile_reconciliation_checks_v6
 from public,anon,authenticated,service_role;

create function public.meta_profile_reconciliation_target_v6(
 p_attempt_id uuid,p_client_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare a public.meta_profile_execution_attempts_v6%rowtype;
begin
 if auth.role() is distinct from 'service_role' then return null; end if;
 select * into a from public.meta_profile_execution_attempts_v6
  where id=p_attempt_id and client_id=p_client_id and status='uncertain';
 if a.id is null or not exists(select 1 from public.meta_profile_changes m
  where m.id=a.change_id and m.client_id=a.client_id
   and m.status='approved' and m.platform='facebook'
   and m.approved_request_id=a.approval_request_id
   and m.approved_content_hash=a.source_hash
   and m.field=a.field and m.current_value is not distinct from a.before_value
   and m.proposed_value=a.proposed_value)
  or not public.meta_profile_write_credential_eligible_v6(a.client_id) then
  return null; end if;
 return jsonb_build_object('attempt_id',a.id,'client_id',a.client_id,
  'change_id',a.change_id,'page_id',a.page_id,'field',a.field,
  'proposed_value',a.proposed_value);
end $$;

create or replace function public.guard_meta_profile_approval_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare q public.meta_profile_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 if new.status='applied' and old.status is distinct from 'applied' then
  if old.status<>'approved' or auth.role() is distinct from 'service_role'
   or not exists(select 1 from public.meta_profile_execution_attempts_v6 a
    where a.change_id=new.id and a.client_id=new.client_id
     and a.approval_request_id=new.approved_request_id
     and a.source_hash=new.approved_content_hash
     and a.field=new.field
     and a.before_value is not distinct from new.current_value
     and a.proposed_value=new.proposed_value
     and ((a.status='confirmed' and a.observed_value=a.proposed_value
       and a.provider_ref=new.external_ref)
      or (a.status='uncertain' and exists(select 1
       from public.meta_profile_reconciliation_checks_v6 c
       where c.attempt_id=a.id and c.client_id=a.client_id
        and c.result='matched' and c.observed_value=a.proposed_value
        and c.provider_ref=new.external_ref)))) then
   raise exception 'Meta profile applied status requires exact provider readback.'
    using errcode='42501'; end if;
 end if;
 if new.status<>'approved' or old.status='approved' then return new; end if;
 select * into q from public.meta_profile_review_requests_v6
  where canonical_request_id=new.approved_request_id and change_id=new.id and client_id=new.client_id;
 select * into e from public.approval_decision_events_v6 where request_id=q.canonical_request_id
  order by event_order desc limit 1;
 if q.id is null or new.approved_content_hash is distinct from q.source_hash
  or e.decision is distinct from 'approved' or e.actor_aal<>'aal2'
  or e.actor_id is distinct from auth.uid() or e.artifact_hash is distinct from q.source_hash
  or public.meta_profile_review_source_state_v6(q.canonical_request_id)<>'pending'
  then raise exception 'Approve the exact Meta profile proposal in Approval Inbox.'
   using errcode='42501'; end if;
 return new;
end $$;

create function public.record_meta_profile_reconciliation_v6(
 p_attempt_id uuid,p_client_id uuid,p_observed_value text,p_provider_ref text)
returns text language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.meta_profile_execution_attempts_v6%rowtype;
 result_value text;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Only the trusted Page reader may reconcile an attempt.' using errcode='42501'; end if;
 select * into a from public.meta_profile_execution_attempts_v6
  where id=p_attempt_id and client_id=p_client_id for update;
 if a.id is null or a.status<>'uncertain'
  or p_provider_ref is distinct from 'facebook_page:'||a.page_id||'#'||a.field
  or not public.meta_profile_write_credential_eligible_v6(a.client_id) then
  raise exception 'The uncertain Page attempt or current credential is unavailable.'
   using errcode='23514'; end if;
 if exists(select 1 from public.meta_profile_reconciliation_checks_v6 c
  where c.attempt_id=a.id and c.result='matched') then return 'matched'; end if;
 result_value:=case when p_observed_value is not distinct from a.proposed_value
  then 'matched' else 'different' end;
 insert into public.meta_profile_reconciliation_checks_v6
  (attempt_id,client_id,observed_value,provider_ref,result)
 values (a.id,a.client_id,p_observed_value,p_provider_ref,result_value);
 if result_value='matched' then
  update public.meta_profile_changes m
   set status='applied',applied_at=clock_timestamp(),external_ref=p_provider_ref,
    lease_until=null,last_error=null
   where m.id=a.change_id and m.client_id=a.client_id
    and m.status='approved' and m.platform='facebook'
    and m.approved_request_id=a.approval_request_id
    and m.approved_content_hash=a.source_hash
    and m.field=a.field and m.current_value is not distinct from a.before_value
    and m.proposed_value=a.proposed_value;
 end if;
 return result_value;
end $$;

create or replace view public.meta_profile_execution_overview_v6
with (security_barrier=true) as
select a.id as attempt_id,a.change_id,a.client_id,a.approval_request_id,
 a.page_id,a.field,a.status,a.reserved_at,a.started_at,a.finished_at,
 a.observed_value,a.provider_ref,a.outcome_note,
 c.result as reconciliation_result,c.checked_at as reconciled_at
from public.meta_profile_execution_attempts_v6 a
left join lateral (select result,checked_at
 from public.meta_profile_reconciliation_checks_v6 c
 where c.attempt_id=a.id
 order by (result='matched') desc,checked_at desc,id desc limit 1) c on true
where public.can_access_client(a.client_id);

revoke all on function public.meta_profile_reconciliation_target_v6(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.meta_profile_reconciliation_target_v6(uuid,uuid) to service_role;
revoke all on function public.guard_meta_profile_approval_v6()
 from public,anon,authenticated,service_role;
revoke all on function public.record_meta_profile_reconciliation_v6(uuid,uuid,text,text)
 from public,anon,authenticated,service_role;
grant execute on function public.record_meta_profile_reconciliation_v6(uuid,uuid,text,text)
 to service_role;
revoke all on public.meta_profile_execution_overview_v6
 from public,anon,authenticated,service_role;
grant select on public.meta_profile_execution_overview_v6 to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (23,6,'meta_profile_change','Meta profile change',
 'verified','387 exact proposal; 469 epoch; 470 Page target binding',
 'verified','387 AAL2 decision; 470 current Page/write credential gate',
 'blocked','474 one-shot attempt; 475 held worker; 476 confirmed source; 479 uncertain read-only reconciliation record',
 'Connect trusted read-only provider reconciliation, verify live Page token and authorize an observed provider test receipt.');

select public.lock_down_definer_functions();
commit;
