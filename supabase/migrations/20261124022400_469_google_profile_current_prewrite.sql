-- A Google profile proposal must remain exact after edits and provider reads.
-- This predicate does not release the held PATCH worker.
begin;

alter table public.google_profile_changes
 add column review_epoch_v6 bigint not null default 0;
alter table public.client_google_locations
 add column profile_review_epoch_v6 bigint not null default 0;

create function public.advance_google_profile_review_epoch_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_table_name='google_profile_changes' then
  if (new.client_id,new.location_id,new.field,new.current_value,
      new.proposed_value,new.reason) is distinct from
     (old.client_id,old.location_id,old.field,old.current_value,
      old.proposed_value,old.reason) then
   new.review_epoch_v6:=old.review_epoch_v6+1;
  elsif new.review_epoch_v6 is distinct from old.review_epoch_v6 then
   raise exception 'Google profile review epoch is system-owned.' using errcode='42501';
  end if;
 else
  if (new.client_id,new.location_ref,new.title,new.address,new.primary_phone,
      new.website_url,new.verification_state,new.profile_snapshot,
      new.last_read_at) is distinct from
     (old.client_id,old.location_ref,old.title,old.address,old.primary_phone,
      old.website_url,old.verification_state,old.profile_snapshot,
      old.last_read_at) then
   new.profile_review_epoch_v6:=old.profile_review_epoch_v6+1;
  elsif new.profile_review_epoch_v6 is distinct from old.profile_review_epoch_v6 then
   raise exception 'Google location profile review epoch is system-owned.' using errcode='42501';
  end if;
 end if;
 return new;
end $$;
create trigger google_profile_change_review_epoch_v6
 before update on public.google_profile_changes for each row
 execute function public.advance_google_profile_review_epoch_v6();
create trigger google_location_profile_review_epoch_v6
 before update on public.client_google_locations for each row
 execute function public.advance_google_profile_review_epoch_v6();
revoke all on function public.advance_google_profile_review_epoch_v6()
 from public,anon,authenticated,service_role;

create or replace function public.google_profile_review_preview_v6(q public.google_profile_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',m.client_id,'change_id',m.id,
  'request_token',q.request_token,'location_id',l.id,
  'location_ref',l.location_ref,'location_title',l.title,
  'verification_state',l.verification_state,'last_read_at',l.last_read_at,
  'location_review_epoch',l.profile_review_epoch_v6,
  'field',m.field,'change_review_epoch',m.review_epoch_v6,
  'current_value',m.current_value,'proposed_value',m.proposed_value,
  'reason',m.reason,
  'consequence','Approve these exact before/after words as a proposal; provider application remains held')
 from public.google_profile_changes m
 join public.client_google_locations l on l.id=m.location_id and l.client_id=m.client_id
 where m.id=q.change_id and m.client_id=q.client_id;
$$;

create function public.google_profile_prewrite_current_v6(p_change_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
 m public.google_profile_changes%rowtype;
 l public.client_google_locations%rowtype;
 q public.google_profile_review_requests_v6%rowtype;
 r public.approval_requests_v6%rowtype;
 d public.approval_decision_events_v6%rowtype;
begin
 if auth.role() is distinct from 'service_role' then return false; end if;
 select * into m from public.google_profile_changes where id=p_change_id;
 if m.id is null or m.status<>'approved' or m.approved_request_id is null then return false; end if;
 select * into l from public.client_google_locations
  where id=m.location_id and client_id=m.client_id;
 if l.id is null or l.verification_state<>'verified' then return false; end if;
 if not exists(select 1 from public.profile_field_support f
  where f.surface='google_business' and f.platform='google'
   and f.field=m.field and f.writable) then return false; end if;
 select * into q from public.google_profile_review_requests_v6
  where canonical_request_id=m.approved_request_id and change_id=m.id
   and client_id=m.client_id;
 if q.id is null or q.source_hash is distinct from m.approved_content_hash
  or public.google_profile_review_source_state_v6(q.canonical_request_id)<>'source_decided'
  then return false; end if;
 select * into r from public.approval_requests_v6 where id=q.canonical_request_id;
 select * into d from public.approval_decision_events_v6
  where request_id=r.id order by event_order desc limit 1;
 if r.id is null or r.client_id is distinct from m.client_id
  or r.artifact_hash is distinct from q.source_hash
  or d.decision is distinct from 'approved' or d.actor_aal is distinct from 'aal2'
  or d.artifact_hash is distinct from q.source_hash
  or exists(select 1 from public.delivery_approval_invalidations_v6 x
    where x.approval_request_id=r.id)
  or not exists(select 1 from public.approval_inbox_v6 i
    where i.id=r.id and i.status='approved')
  then return false; end if;
 return public.google_reply_credential_eligible_v6(m.client_id);
end $$;
revoke all on function public.google_profile_prewrite_current_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.google_profile_prewrite_current_v6(uuid)
 to service_role;

select public.lock_down_definer_functions();
commit;
