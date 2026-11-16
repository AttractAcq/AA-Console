-- Reserve one Google profile field write and retain its observed outcome.
-- This ledger does not release the held PATCH worker or mark source rows applied.
begin;

create table public.google_profile_execution_attempts_v6 (
 id uuid primary key default gen_random_uuid(),
 change_id uuid not null unique references public.google_profile_changes(id) on delete restrict,
 client_id uuid not null references public.clients(id) on delete restrict,
 approval_request_id uuid not null references public.approval_requests_v6(id) on delete restrict,
 claim_key uuid not null default gen_random_uuid(),
 source_hash text not null,
 location_ref text not null,
 field text not null,
 before_value text,
 proposed_value text not null,
 status text not null default 'reserved'
  check (status in ('reserved','started','confirmed','refused','uncertain')),
 reserved_at timestamptz not null default now(),
 started_at timestamptz,
 finished_at timestamptz,
 observed_value text,
 provider_ref text,
 outcome_note text,
 check ((status='reserved' and started_at is null and finished_at is null)
  or (status='started' and started_at is not null and finished_at is null)
  or (status in ('confirmed','refused','uncertain') and finished_at is not null))
);
alter table public.google_profile_execution_attempts_v6 enable row level security;
revoke all on public.google_profile_execution_attempts_v6
 from public,anon,authenticated,service_role;

create function public.claim_google_profile_execution_v6(p_change_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare m public.google_profile_changes%rowtype;
 l public.client_google_locations%rowtype;
 a public.google_profile_execution_attempts_v6%rowtype;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Only the trusted profile writer may claim a change.' using errcode='42501';
 end if;
 select * into m from public.google_profile_changes where id=p_change_id for update;
 if m.id is null or not public.google_profile_prewrite_current_v6(m.id) then return null; end if;
 if exists(select 1 from public.google_profile_execution_attempts_v6
  where change_id=m.id) then return null; end if;
 select * into l from public.client_google_locations
  where id=m.location_id and client_id=m.client_id;
 if l.id is null then return null; end if;
 insert into public.google_profile_execution_attempts_v6
  (change_id,client_id,approval_request_id,source_hash,location_ref,
   field,before_value,proposed_value)
 values (m.id,m.client_id,m.approved_request_id,m.approved_content_hash,
  l.location_ref,m.field,m.current_value,m.proposed_value)
 returning * into a;
 return jsonb_build_object('attempt_id',a.id,'claim_key',a.claim_key,
  'change_id',a.change_id,'client_id',a.client_id,
  'location_ref',a.location_ref,'field',a.field,
  'before_value',a.before_value,'proposed_value',a.proposed_value);
end $$;

create function public.begin_google_profile_write_v6(
 p_attempt_id uuid,p_claim_key uuid)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.google_profile_execution_attempts_v6%rowtype;
 m public.google_profile_changes%rowtype;
 l public.client_google_locations%rowtype;
begin
 if auth.role() is distinct from 'service_role' then return false; end if;
 select * into a from public.google_profile_execution_attempts_v6
  where id=p_attempt_id and claim_key=p_claim_key for update;
 if a.id is null or a.status<>'reserved'
  or not public.google_profile_prewrite_current_v6(a.change_id) then return false; end if;
 select * into m from public.google_profile_changes where id=a.change_id;
 select * into l from public.client_google_locations
  where id=m.location_id and client_id=m.client_id;
 if m.client_id is distinct from a.client_id
  or m.approved_request_id is distinct from a.approval_request_id
  or m.approved_content_hash is distinct from a.source_hash
  or m.field is distinct from a.field
  or m.current_value is distinct from a.before_value
  or m.proposed_value is distinct from a.proposed_value
  or l.location_ref is distinct from a.location_ref then return false; end if;
 update public.google_profile_execution_attempts_v6
  set status='started',started_at=clock_timestamp() where id=a.id;
 return true;
end $$;

create function public.finish_google_profile_execution_v6(
 p_attempt_id uuid,p_claim_key uuid,p_outcome text,
 p_observed_value text default null,p_provider_ref text default null,
 p_note text default null)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.google_profile_execution_attempts_v6%rowtype;
 exact_match boolean;
begin
 if auth.role() is distinct from 'service_role' then return false; end if;
 if p_outcome not in ('confirmed','refused','uncertain') then
  raise exception 'Invalid Google profile outcome.' using errcode='22023'; end if;
 select * into a from public.google_profile_execution_attempts_v6
  where id=p_attempt_id and claim_key=p_claim_key for update;
 if a.id is null or a.status not in ('reserved','started') then return false; end if;
 if p_outcome='confirmed' then
  if a.field='hours' then
   begin
    exact_match:=p_observed_value::jsonb=a.proposed_value::jsonb;
   exception when invalid_text_representation then exact_match:=false;
   end;
  else exact_match:=p_observed_value=a.proposed_value; end if;
  if a.status<>'started' or exact_match is distinct from true
   or nullif(btrim(coalesce(p_provider_ref,'')),'') is null then
   raise exception 'Exact provider readback and reference are required.' using errcode='23514';
  end if;
 end if;
 if p_outcome='uncertain' and a.status<>'started' then
  raise exception 'An uncertain outcome requires an invoked provider write.'
   using errcode='23514'; end if;
 if p_outcome='refused' and a.status<>'reserved' then
  raise exception 'After a provider write starts, an unconfirmed outcome is uncertain.'
   using errcode='23514'; end if;
 if p_outcome<>'confirmed' and nullif(btrim(coalesce(p_note,'')),'') is null then
  raise exception 'A refusal or uncertain outcome needs a reason.' using errcode='22023'; end if;
 update public.google_profile_execution_attempts_v6
  set status=p_outcome,finished_at=clock_timestamp(),
   observed_value=p_observed_value,provider_ref=p_provider_ref,
   outcome_note=nullif(btrim(p_note),'') where id=a.id;
 return true;
end $$;

revoke all on function public.claim_google_profile_execution_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.claim_google_profile_execution_v6(uuid) to service_role;
revoke all on function public.begin_google_profile_write_v6(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.begin_google_profile_write_v6(uuid,uuid) to service_role;
revoke all on function public.finish_google_profile_execution_v6(
 uuid,uuid,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_google_profile_execution_v6(
 uuid,uuid,text,text,text,text) to service_role;

create view public.google_profile_execution_overview_v6
with (security_barrier=true) as
select a.id as attempt_id,a.change_id,a.client_id,a.approval_request_id,
 a.field,a.location_ref,a.status,a.reserved_at,a.started_at,a.finished_at,
 a.observed_value,a.provider_ref,a.outcome_note
from public.google_profile_execution_attempts_v6 a
where public.can_access_client(a.client_id);
revoke all on public.google_profile_execution_overview_v6
 from public,anon,authenticated,service_role;
grant select on public.google_profile_execution_overview_v6
 to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (22,3,'google_profile_change','Google profile change',
 'verified','390 exact proposal preview; 468 current proposal and location epoch',
 'verified','390 source-owned AAL2 decision; 468 current prewrite',
 'blocked','471 unique one-shot reservation and observed-outcome ledger; 784e381 held v1 transport',
 'Connect claim to held writer, verify account-location membership and live provider readback, reconcile legacy approvals and obtain an authorized test receipt.');

select public.lock_down_definer_functions();
commit;
