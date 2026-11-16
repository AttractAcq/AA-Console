-- Restoring old proposal words must not revive a stale Meta profile review.
-- Provider application remains held.
begin;

alter table public.meta_profile_changes
 add column review_epoch_v6 bigint not null default 0;

create function public.advance_meta_profile_review_epoch_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.client_id,new.platform,new.field,new.current_value,
     new.proposed_value,new.offer_version_id,new.reason) is distinct from
    (old.client_id,old.platform,old.field,old.current_value,
     old.proposed_value,old.offer_version_id,old.reason) then
  new.review_epoch_v6:=old.review_epoch_v6+1;
 elsif new.review_epoch_v6 is distinct from old.review_epoch_v6 then
  raise exception 'Meta profile review epoch is system-owned.' using errcode='42501';
 end if;
 return new;
end $$;
create trigger meta_profile_review_epoch_v6
 before update on public.meta_profile_changes for each row
 execute function public.advance_meta_profile_review_epoch_v6();
revoke all on function public.advance_meta_profile_review_epoch_v6()
 from public,anon,authenticated,service_role;

create or replace function public.meta_profile_review_preview_v6(q public.meta_profile_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',m.client_id,'change_id',m.id,
  'request_token',q.request_token,'platform',m.platform,'field',m.field,
  'review_epoch',m.review_epoch_v6,
  'current_value',m.current_value,'proposed_value',m.proposed_value,
  'offer_version_id',m.offer_version_id,'reason',m.reason,
  'consequence','Approve these exact before/after words as a proposal; provider application remains held')
 from public.meta_profile_changes m where m.id=q.change_id and m.client_id=q.client_id;
$$;

select public.lock_down_definer_functions();
commit;
