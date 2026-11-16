-- A confirmed Facebook Page readback and the source status must agree.
begin;

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
     and a.status='confirmed' and a.provider_ref=new.external_ref
     and a.observed_value is not null) then
   raise exception 'Meta profile applied status requires an exact confirmed provider attempt.'
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

create or replace function public.finish_meta_profile_execution_v6(
 p_attempt_id uuid,p_claim_key uuid,p_outcome text,
 p_observed_value text default null,p_provider_ref text default null,
 p_note text default null)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.meta_profile_execution_attempts_v6%rowtype;
begin
 if auth.role() is distinct from 'service_role' then return false; end if;
 if p_outcome not in ('confirmed','refused','uncertain') then
  raise exception 'Invalid Meta profile outcome.' using errcode='22023'; end if;
 select * into a from public.meta_profile_execution_attempts_v6
  where id=p_attempt_id and claim_key=p_claim_key for update;
 if a.id is null or a.status not in ('reserved','started') then return false; end if;
 if p_outcome='confirmed' and (a.status<>'started'
  or p_observed_value is distinct from a.proposed_value
  or p_provider_ref is distinct from 'facebook_page:'||a.page_id||'#'||a.field) then
  raise exception 'Exact Page field readback and reference are required.'
   using errcode='23514'; end if;
 if p_outcome='uncertain' and a.status<>'started' then
  raise exception 'An uncertain outcome requires an invoked provider write.'
   using errcode='23514'; end if;
 if p_outcome='refused' and a.status<>'reserved' then
  raise exception 'After a provider write starts, an unconfirmed outcome is uncertain.'
   using errcode='23514'; end if;
 if p_outcome<>'confirmed' and nullif(btrim(coalesce(p_note,'')),'') is null then
  raise exception 'A refusal or uncertain outcome needs a reason.' using errcode='22023'; end if;
 update public.meta_profile_execution_attempts_v6
  set status=p_outcome,finished_at=clock_timestamp(),
   observed_value=p_observed_value,provider_ref=p_provider_ref,
   outcome_note=nullif(btrim(p_note),'') where id=a.id;
 if p_outcome='confirmed' then
  -- A source edited during provider execution remains for reconciliation;
  -- the immutable provider attempt still records what was observed.
  update public.meta_profile_changes m
   set status='applied',applied_at=clock_timestamp(),
    external_ref=p_provider_ref,lease_until=null,last_error=null
   where m.id=a.change_id and m.client_id=a.client_id
    and m.platform='facebook' and m.status='approved'
    and m.approved_request_id=a.approval_request_id
    and m.approved_content_hash=a.source_hash
    and m.field=a.field
    and m.current_value is not distinct from a.before_value
    and m.proposed_value=a.proposed_value;
 end if;
 return true;
end $$;

revoke all on function public.guard_meta_profile_approval_v6()
 from public,anon,authenticated,service_role;
revoke all on function public.finish_meta_profile_execution_v6(
 uuid,uuid,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_meta_profile_execution_v6(
 uuid,uuid,text,text,text,text) to service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (23,5,'meta_profile_change','Meta profile change',
 'verified','387 exact proposal preview; 469 revision epoch; 470 Page target binding',
 'verified','387 source-owned AAL2 decision; 470 current Page/write-credential prewrite; 475 owner-requested job',
 'blocked','474 one-shot outcome ledger; 475 default-off worker; 476 confirmed readback updates exact source',
 'Verify live Page token and provider readback, reconcile historical approvals, authorize release and observe a test receipt.');

select public.lock_down_definer_functions();
commit;
