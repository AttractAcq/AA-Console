-- The Google review reply transport may proceed only from the exact current
-- human decision. A sender and one-shot execution receipt are still required.
begin;

alter table public.google_reviews
  add column approval_epoch_v6 bigint not null default 0;
alter table public.client_google_locations
  add column approval_epoch_v6 bigint not null default 0;

create function public.advance_google_reply_context_epoch_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if tg_table_name='google_reviews' then
    if (new.client_id,new.location_id,new.review_ref,new.author_name,
        new.star_rating,new.comment,new.review_url,new.gone_at)
      is distinct from
       (old.client_id,old.location_id,old.review_ref,old.author_name,
        old.star_rating,old.comment,old.review_url,old.gone_at) then
      new.approval_epoch_v6:=old.approval_epoch_v6+1;
    elsif new.approval_epoch_v6 is distinct from old.approval_epoch_v6 then
      raise exception 'Google review approval epoch is system-owned.' using errcode='42501';
    end if;
  else
    if (new.client_id,new.location_ref,new.title,new.verification_state)
      is distinct from
       (old.client_id,old.location_ref,old.title,old.verification_state) then
      new.approval_epoch_v6:=old.approval_epoch_v6+1;
    elsif new.approval_epoch_v6 is distinct from old.approval_epoch_v6 then
      raise exception 'Google location approval epoch is system-owned.' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger google_review_context_epoch_v6
  before update on public.google_reviews for each row
  execute function public.advance_google_reply_context_epoch_v6();
create trigger google_location_context_epoch_v6
  before update on public.client_google_locations for each row
  execute function public.advance_google_reply_context_epoch_v6();
revoke all on function public.advance_google_reply_context_epoch_v6()
  from public,anon,authenticated,service_role;

create table public.google_reply_context_bindings_v6 (
  reply_id uuid primary key references public.google_review_replies(id) on delete restrict,
  approval_request_id uuid not null references public.approval_requests_v6(id) on delete restrict,
  review_epoch bigint not null,
  location_epoch bigint not null,
  bound_at timestamptz not null default now()
);
alter table public.google_reply_context_bindings_v6 enable row level security;
revoke all on public.google_reply_context_bindings_v6
  from public,anon,authenticated,service_role;

create function public.bind_google_reply_context_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  v_request_id uuid;
  v_review_epoch bigint;
  v_location_epoch bigint;
begin
  if old.status not in ('drafted','awaiting_approval') or new.status <> 'approved' then
    return new;
  end if;
  select ar.id into v_request_id from public.approval_requests_v6 ar
    join public.approval_decision_events_v6 d on d.request_id=ar.id
    where ar.source_system='aa_console' and ar.source_kind='google_review_reply'
      and ar.source_id=new.id::text and d.decision='approved'
      and d.source_decision_ref='google_review_replies:'||new.id::text
    order by d.event_order desc limit 1;
  select v.approval_epoch_v6,l.approval_epoch_v6
    into v_review_epoch,v_location_epoch
    from public.google_reviews v
    join public.client_google_locations l on l.id=v.location_id
    where v.id=new.review_id and v.client_id=new.client_id
      and l.client_id=new.client_id;
  if v_request_id is null or v_review_epoch is null or v_location_epoch is null then
    raise exception 'Google reply context could not bind to its exact decision.'
      using errcode='23514';
  end if;
  insert into public.google_reply_context_bindings_v6
    (reply_id,approval_request_id,review_epoch,location_epoch)
    values (new.id,v_request_id,v_review_epoch,v_location_epoch);
  return new;
end $$;
-- Alphabetically after google_reply_inbox_decision_v6, which records the
-- canonical event in the same source transaction.
create trigger zz_google_reply_context_bind_v6
  after update of status on public.google_review_replies
  for each row execute function public.bind_google_reply_context_v6();
revoke all on function public.bind_google_reply_context_v6()
  from public,anon,authenticated,service_role;

create function public.google_reply_prewrite_current_v6(p_reply_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare
  g public.google_review_replies%rowtype;
  v_location public.client_google_locations%rowtype;
  p jsonb;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  c public.google_reply_context_bindings_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then return false; end if;
  select * into g from public.google_review_replies where id=p_reply_id;
  if g.id is null or g.status <> 'approved' then return false; end if;
  select loc.* into v_location from public.google_reviews v
    join public.client_google_locations loc on loc.id=v.location_id
    where v.id=g.review_id and v.client_id=g.client_id
      and loc.client_id=g.client_id and v.gone_at is null;
  if v_location.id is null or v_location.verification_state <> 'verified' then return false; end if;
  p:=public.google_reply_inbox_payload_v6(g);
  if p->>'preview_blocker' is not null then return false; end if;
  select * into r from public.approval_requests_v6
    where client_id=g.client_id and source_system='aa_console'
      and source_kind='google_review_reply' and source_id=g.id::text
      and source_version=p->>'source_version'
      and artifact_hash=p->>'artifact_hash'
      and preview=p->'preview'
      and destination=p->>'destination'
      and account_ref=p->>'account_ref'
      and scope=p->'scope'
      and preview_blocker is null
    order by requested_at desc,id desc limit 1;
  if r.id is null or exists (
    select 1 from public.delivery_approval_invalidations_v6 i
    where i.approval_request_id=r.id
  ) then return false; end if;
  select * into c from public.google_reply_context_bindings_v6
    where reply_id=g.id and approval_request_id=r.id;
  if c.reply_id is null or c.review_epoch is distinct from (
    select v.approval_epoch_v6 from public.google_reviews v where v.id=g.review_id
  ) or c.location_epoch is distinct from v_location.approval_epoch_v6 then
    return false;
  end if;
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  return d.decision='approved' and d.actor_aal='aal2'
    and d.artifact_hash=r.artifact_hash
    and d.source_decision_ref='google_review_replies:'||g.id::text;
end $$;

revoke all on function public.google_reply_prewrite_current_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.google_reply_prewrite_current_v6(uuid)
  to service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (21,2,'google_review_reply','Google review reply',
 'verified','278 exact reply, review and location preview',
 'verified','278 source-owned AAL2 Inbox decision',
 'blocked','456 service-only exact decision, monotonic review/location epoch and verified-location prewrite predicate; review-reply GET/PUT/readback transport is tested but not connected to a claim',
 'Build a one-shot execution claim and receipt, bind sender to verified credential identity, reconcile legacy approved replies and obtain an authorized provider readback.');

select public.lock_down_definer_functions();
commit;
