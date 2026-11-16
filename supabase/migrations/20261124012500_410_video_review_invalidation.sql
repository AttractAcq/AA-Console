-- A revert of render metadata, assigned seat or client request cannot revive
-- an earlier exact video review.
begin;
create function public.invalidate_video_asset_reviews_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.title,new.brief_id,new.source_asset_id,new.media_type,new.content_format,
  new.storage_path,new.render_path,new.delivery_bytes_sha256,new.usage_rights,
  new.edit_stage,new.archived_at) is distinct from
  (old.title,old.brief_id,old.source_asset_id,old.media_type,old.content_format,
   old.storage_path,old.render_path,old.delivery_bytes_sha256,old.usage_rights,
   old.edit_stage,old.archived_at) then
  update public.video_seat_review_requests_v6 set request_token=gen_random_uuid()
   where asset_id=new.id;
 end if;
 return new;
end $$;
create trigger video_asset_review_invalidation_v6 after update on public.client_media_assets
 for each row execute function public.invalidate_video_asset_reviews_v6();

create function public.invalidate_video_owner_reviews_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.owner_user_id is distinct from old.owner_user_id then
  update public.video_seat_review_requests_v6 set request_token=gen_random_uuid()
   where approval_role='owner';
 end if;
 return new;
end $$;
create trigger video_owner_review_invalidation_v6 after update on public.content_approval_settings
 for each row execute function public.invalidate_video_owner_reviews_v6();

create function public.invalidate_video_manager_reviews_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_old uuid; v_new uuid;
begin
 if tg_op<>'INSERT' then v_old:=old.client_id; end if;
 if tg_op<>'DELETE' then v_new:=new.client_id; end if;
 update public.video_seat_review_requests_v6 set request_token=gen_random_uuid()
  where approval_role='manager' and client_id in (v_old,v_new);
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger video_manager_review_invalidation_v6
 after insert or update or delete on public.client_assignments
 for each row execute function public.invalidate_video_manager_reviews_v6();

create function public.invalidate_video_manager_member_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.user_id,new.category,new.active) is distinct from
  (old.user_id,old.category,old.active) then
  update public.video_seat_review_requests_v6 q set request_token=gen_random_uuid()
   where q.approval_role='manager' and exists(select 1 from public.client_assignments ca
    where ca.member_id=new.id and ca.client_id=q.client_id);
 end if;
 return new;
end $$;
create trigger video_manager_member_invalidation_v6 after update on public.team_members
 for each row execute function public.invalidate_video_manager_member_v6();

create function public.invalidate_video_client_reviews_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_asset uuid;
begin
 if tg_op='DELETE' then v_asset:=old.asset_id; else v_asset:=new.asset_id; end if;
 update public.video_seat_review_requests_v6 set request_token=gen_random_uuid()
  where approval_role='client' and asset_id=v_asset;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger video_client_review_invalidation_v6
 after insert or update or delete on public.video_client_approval_requests
 for each row execute function public.invalidate_video_client_reviews_v6();

create function public.invalidate_video_reviewer_role_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.role is distinct from old.role then
  update public.video_seat_review_requests_v6 q set request_token=gen_random_uuid()
   where public.video_seat_reviewer_v6(q.asset_id,q.approval_role)=new.id
    or (q.approval_role='client' and exists(select 1 from public.video_client_approval_requests r
      where r.asset_id=q.asset_id and r.client_user_id=new.id))
    or (q.approval_role='owner' and exists(select 1 from public.content_approval_settings s
      where s.singleton and s.owner_user_id=new.id));
 end if;
 return new;
end $$;
create trigger video_reviewer_role_invalidation_v6 after update of role on public.profiles
 for each row execute function public.invalidate_video_reviewer_role_v6();

create function public.invalidate_video_client_membership_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_client uuid; v_user uuid;
begin
 if tg_op='DELETE' then v_client:=old.client_id; v_user:=old.user_id;
 else v_client:=new.client_id; v_user:=new.user_id; end if;
 update public.video_seat_review_requests_v6 q set request_token=gen_random_uuid()
  where q.client_id=v_client and q.approval_role='client'
   and exists(select 1 from public.video_client_approval_requests r
    where r.asset_id=q.asset_id and r.client_user_id=v_user);
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger video_client_membership_invalidation_v6
 after insert or update or delete on public.client_users for each row
 execute function public.invalidate_video_client_membership_v6();

revoke all on function public.invalidate_video_asset_reviews_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_video_owner_reviews_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_video_manager_reviews_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_video_manager_member_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_video_client_reviews_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_video_reviewer_role_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_video_client_membership_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
