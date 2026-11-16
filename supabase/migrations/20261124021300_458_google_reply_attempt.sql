-- A Google reply gets one durable execution reservation. An uncertain PUT
-- cannot be retried by creating another job; a person must reconcile it.
begin;

create table public.google_reply_execution_attempts_v6 (
  id uuid primary key default gen_random_uuid(),
  reply_id uuid not null unique references public.google_review_replies(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  approval_request_id uuid not null references public.approval_requests_v6(id) on delete restrict,
  claim_key uuid not null default gen_random_uuid(),
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  location_ref text not null,
  review_ref text not null,
  status text not null default 'reserved' check (status in
    ('reserved','started','confirmed','refused','uncertain')),
  reserved_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  observed_body_hash text,
  provider_update_time text,
  provider_state text,
  outcome_note text,
  check ((status='reserved' and started_at is null and finished_at is null)
    or (status='started' and started_at is not null and finished_at is null)
    or (status in ('confirmed','refused','uncertain') and finished_at is not null))
);
alter table public.google_reply_execution_attempts_v6 enable row level security;
revoke all on public.google_reply_execution_attempts_v6
  from public,anon,authenticated,service_role;

create function public.claim_google_reply_execution_v6(p_reply_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare
  g public.google_review_replies%rowtype;
  p jsonb;
  c public.google_reply_context_bindings_v6%rowtype;
  a public.google_reply_execution_attempts_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted sender may claim a Google reply.' using errcode='42501';
  end if;
  select * into g from public.google_review_replies where id=p_reply_id for update;
  if g.id is null or not public.google_reply_prewrite_current_v6(g.id) then return null; end if;
  if exists(select 1 from public.google_reply_execution_attempts_v6
    where reply_id=g.id) then return null; end if;
  p:=public.google_reply_inbox_payload_v6(g);
  select * into c from public.google_reply_context_bindings_v6 where reply_id=g.id;
  insert into public.google_reply_execution_attempts_v6
    (reply_id,client_id,approval_request_id,body_hash,location_ref,review_ref)
  values (g.id,g.client_id,c.approval_request_id,g.body_hash,
    p->'preview'->>'location_ref',p->'preview'->>'review_ref')
  returning * into a;
  return jsonb_build_object('attempt_id',a.id,'claim_key',a.claim_key,
    'reply_id',g.id,'client_id',g.client_id,'exact_body',g.body,
    'body_hash',a.body_hash,'location_ref',a.location_ref,
    'review_ref',a.review_ref);
end $$;

create function public.begin_google_reply_write_v6(
  p_attempt_id uuid,p_claim_key uuid)
returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare
  a public.google_reply_execution_attempts_v6%rowtype;
  g public.google_review_replies%rowtype;
  p jsonb;
begin
  if auth.role() is distinct from 'service_role' then return false; end if;
  select * into a from public.google_reply_execution_attempts_v6
    where id=p_attempt_id and claim_key=p_claim_key for update;
  if a.id is null or a.status<>'reserved'
    or not public.google_reply_prewrite_current_v6(a.reply_id) then return false; end if;
  select * into g from public.google_review_replies where id=a.reply_id;
  p:=public.google_reply_inbox_payload_v6(g);
  if g.client_id is distinct from a.client_id
    or g.body_hash is distinct from a.body_hash
    or p->'preview'->>'location_ref' is distinct from a.location_ref
    or p->'preview'->>'review_ref' is distinct from a.review_ref then
    return false;
  end if;
  update public.google_reply_execution_attempts_v6
    set status='started',started_at=clock_timestamp()
    where id=a.id;
  return true;
end $$;

create function public.finish_google_reply_execution_v6(
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
      using errcode='23514';
  end if;
  if p_outcome='uncertain' and a.status<>'started' then
    raise exception 'An uncertain outcome requires an invoked provider write.'
      using errcode='23514';
  end if;
  if p_outcome='refused' and a.status<>'reserved' then
    raise exception 'After a provider write starts, an unconfirmed outcome is uncertain.'
      using errcode='23514';
  end if;
  if p_outcome<>'confirmed' and nullif(btrim(coalesce(p_note,'')),'') is null then
    raise exception 'A refusal or uncertain outcome needs a reason.'
      using errcode='22023';
  end if;
  update public.google_reply_execution_attempts_v6
    set status=p_outcome,finished_at=clock_timestamp(),
      observed_body_hash=p_observed_body_hash,
      provider_update_time=p_provider_update_time,
      provider_state=p_provider_state,outcome_note=nullif(btrim(p_note),'')
    where id=a.id;
  return true;
end $$;

revoke all on function public.claim_google_reply_execution_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_google_reply_execution_v6(uuid) to service_role;
revoke all on function public.begin_google_reply_write_v6(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.begin_google_reply_write_v6(uuid,uuid) to service_role;
revoke all on function public.finish_google_reply_execution_v6(
  uuid,uuid,text,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.finish_google_reply_execution_v6(
  uuid,uuid,text,text,text,text,text) to service_role;

create view public.google_reply_execution_overview_v6
with (security_barrier=true) as
select a.id as attempt_id,a.reply_id,a.client_id,a.approval_request_id,
  a.status,a.reserved_at,a.started_at,a.finished_at,a.observed_body_hash,
  a.provider_update_time,a.provider_state,a.outcome_note
from public.google_reply_execution_attempts_v6 a
where public.can_access_client(a.client_id);
revoke all on public.google_reply_execution_overview_v6
  from public,anon,authenticated,service_role;
grant select on public.google_reply_execution_overview_v6
  to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (21,3,'google_review_reply','Google review reply',
 'verified','278 exact reply, review and location preview',
 'verified','278 source-owned AAL2 Inbox decision',
 'blocked','456 current prewrite; 457 unique one-shot claim, started reservation and observed-result ledger',
 'Connect the sender to the claim and provider transport, bind credential identity and actual provider readback, reconcile legacy replies.');

select public.lock_down_definer_functions();
commit;
