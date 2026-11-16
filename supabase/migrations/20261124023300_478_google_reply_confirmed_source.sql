-- A confirmed Google review reply readback and the source status must agree.
begin;

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
  and (new.client_id,new.review_id,new.body,new.body_hash,
       new.approved_by,new.approved_at)
   is distinct from
      (old.client_id,old.review_id,old.body,old.body_hash,
       old.approved_by,old.approved_at) then
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
     and a.body_hash=new.body_hash and a.status='confirmed'
     and a.observed_body_hash=a.body_hash
     and new.external_ref=case when a.review_ref like 'accounts/%'
       then a.review_ref else a.location_ref||'/reviews/'||a.review_ref end) then
   raise exception 'Google reply posted status requires an exact confirmed provider attempt.'
    using errcode='42501';
  end if;
 elsif new.status='posting' and old.status is distinct from 'posting' then
  raise exception 'Google reply sending requires a bound exact-version executor.'
   using errcode='23514';
 end if;
 return new;
end $$;

create or replace function public.finish_google_reply_execution_v6(
 p_attempt_id uuid,p_claim_key uuid,p_outcome text,
 p_observed_body_hash text default null,p_provider_update_time text default null,
 p_provider_state text default null,p_note text default null)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.google_reply_execution_attempts_v6%rowtype;
begin
 if auth.role() is distinct from 'service_role' then return false; end if;
 if p_outcome not in ('confirmed','refused','uncertain') then
  raise exception 'Invalid Google reply outcome.' using errcode='22023'; end if;
 select * into a from public.google_reply_execution_attempts_v6
  where id=p_attempt_id and claim_key=p_claim_key for update;
 if a.id is null or a.status not in ('reserved','started') then return false; end if;
 if p_outcome='confirmed' and (a.status<>'started'
  or p_observed_body_hash is distinct from a.body_hash) then
  raise exception 'An exact provider readback is required to confirm a reply.'
   using errcode='23514'; end if;
 if p_outcome='uncertain' and a.status<>'started' then
  raise exception 'An uncertain outcome requires an invoked provider write.'
   using errcode='23514'; end if;
 if p_outcome='refused' and a.status<>'reserved' then
  raise exception 'After a provider write starts, an unconfirmed outcome is uncertain.'
   using errcode='23514'; end if;
 if p_outcome<>'confirmed' and nullif(btrim(coalesce(p_note,'')),'') is null then
  raise exception 'A refusal or uncertain outcome needs a reason.' using errcode='22023'; end if;
 update public.google_reply_execution_attempts_v6
  set status=p_outcome,finished_at=clock_timestamp(),
   observed_body_hash=p_observed_body_hash,
   provider_update_time=p_provider_update_time,
   provider_state=p_provider_state,outcome_note=nullif(btrim(p_note),'')
  where id=a.id;
 if p_outcome='confirmed' then
  update public.google_review_replies g
   set status='posted',posted_at=clock_timestamp(),
    external_ref=case when a.review_ref like 'accounts/%'
     then a.review_ref else a.location_ref||'/reviews/'||a.review_ref end,
    lease_until=null,last_error=null
   where g.id=a.reply_id and g.client_id=a.client_id
    and g.status='approved' and g.body_hash=a.body_hash;
 end if;
 return true;
end $$;

revoke all on function public.guard_google_reply_inbox_status_v6()
 from public,anon,authenticated,service_role;
revoke all on function public.finish_google_reply_execution_v6(
 uuid,uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_google_reply_execution_v6(
 uuid,uuid,text,text,text,text,text) to service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (21,5,'google_review_reply','Google review reply',
 'verified','278 exact reply preview and AAL2 source decision',
 'verified','458 owner-requested job; 459 credential gate',
 'blocked','457 one-shot attempt; 477 confirmed readback updates exact source',
 'Audit historical approvals, verify live credential scopes and provider readback, authorize the held worker and observe a test receipt.');

select public.lock_down_definer_functions();
commit;
