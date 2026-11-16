-- Signoff rows are written only by their exact AAL2 Inbox decision.
begin;
create function public.guard_video_seat_signoff_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.video_seat_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 select * into q from public.video_seat_review_requests_v6
  where canonical_request_id=new.approved_request_id
   and asset_id=new.asset_id and approval_role=new.approval_role;
 select * into e from public.approval_decision_events_v6 where request_id=q.canonical_request_id
  order by event_order desc limit 1;
 if q.id is null or e.id is null or e.decision<>'approved' or e.actor_aal<>'aal2'
  or e.actor_id is distinct from auth.uid() or new.user_id is distinct from auth.uid()
  or new.approved_content_hash is distinct from q.source_hash
  or e.artifact_hash is distinct from q.source_hash
  or new.user_id is distinct from public.video_seat_reviewer_v6(new.asset_id,new.approval_role)
  or new.render_path is distinct from (select coalesce(nullif(btrim(a.render_path),''),a.storage_path)
   from public.client_media_assets a where a.id=new.asset_id)
  or public.video_seat_review_source_state_v6(q.canonical_request_id)<>'pending'
  then raise exception 'Sign this exact rendered video in Approval Inbox.' using errcode='42501'; end if;
 return new;
end $$;
create trigger video_seat_signoff_guard_v6 before insert or update on public.video_approval_signoffs
 for each row execute function public.guard_video_seat_signoff_v6();

create function public.decide_video_seat_inbox_v6(
 p_review_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.video_seat_review_requests_v6%rowtype;
 a public.client_media_assets%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 human must decide video signoff.' using errcode='42501'; end if;
 select * into q from public.video_seat_review_requests_v6 where id=p_review_id for update;
 select * into a from public.client_media_assets where id=q.asset_id for update;
 if q.id is null or a.id is null or a.client_id<>q.client_id
  or auth.uid() is distinct from public.video_seat_reviewer_v6(a.id,q.approval_role)
  then raise exception 'The video decision is assigned to another current reviewer.' using errcode='42501'; end if;
 h:=public.video_seat_review_hash_v6(q);
 if q.canonical_request_id is distinct from p_request_id
  or public.video_seat_review_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 i
   where i.id=p_request_id and i.status='pending' and i.preview_blocker is null)
  then raise exception 'Review the current rendered bytes in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null
  then raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'video_seat:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  insert into public.video_approval_signoffs(asset_id,approval_role,user_id,render_path,
   approved_request_id,approved_content_hash)
  values(a.id,q.approval_role,auth.uid(),coalesce(nullif(btrim(a.render_path),''),a.storage_path),
   p_request_id,h)
  on conflict(asset_id,approval_role) do update set user_id=excluded.user_id,
   render_path=excluded.render_path,signed_at=now(),
   approved_request_id=excluded.approved_request_id,
   approved_content_hash=excluded.approved_content_hash;
 elsif q.approval_role='client' then
  update public.video_client_approval_requests
   set rejected_at=now(),rejection_reason=btrim(p_reason)
   where asset_id=a.id and client_user_id=auth.uid();
  delete from public.video_approval_signoffs
   where asset_id=a.id and approval_role='client';
 end if;
 return a.id;
end $$;

create or replace function public.sign_video_approval(p_asset_id uuid,p_role text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 raise exception 'Sign the exact rendered video in Approval Inbox.' using errcode='42501';
end $$;
create or replace function public.decline_video_client_approval(p_asset_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 raise exception 'Request changes on the exact video in Approval Inbox.' using errcode='42501';
end $$;

create function public.video_signoff_current_v6(p_asset_id uuid,p_role text)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare sig public.video_approval_signoffs%rowtype;
 q public.video_seat_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
 r public.approval_requests_v6%rowtype;
 a public.client_media_assets%rowtype;
begin
 select * into sig from public.video_approval_signoffs
  where asset_id=p_asset_id and approval_role=p_role;
 if sig.asset_id is null or sig.approved_request_id is null then return false; end if;
 select * into a from public.client_media_assets where id=p_asset_id;
 if a.id is null or (auth.role() is distinct from 'service_role'
  and (auth.role() is distinct from 'authenticated'
   or not public.can_access_client(a.client_id))) then return false; end if;
 select * into r from public.approval_requests_v6 where id=sig.approved_request_id
  and client_id=a.client_id and source_system='aa_console' and source_kind='video_seat';
 select * into q from public.video_seat_review_requests_v6
  where canonical_request_id=sig.approved_request_id and asset_id=p_asset_id
   and approval_role=p_role;
 select * into e from public.approval_decision_events_v6 where request_id=sig.approved_request_id
  order by event_order desc limit 1;
 if r.id is null or q.id is null or e.id is null
  or e.decision<>'approved' or e.actor_aal<>'aal2'
  or e.actor_id is distinct from sig.user_id
  or e.artifact_hash is distinct from q.source_hash
  or sig.approved_content_hash is distinct from q.source_hash
  or public.video_seat_review_source_state_v6(sig.approved_request_id)<>'source_decided'
  or exists(select 1 from public.delivery_approval_invalidations_v6 i
   where i.approval_request_id=sig.approved_request_id)
  then return false; end if;
 return true;
end $$;
revoke all on function public.video_signoff_current_v6(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.video_signoff_current_v6(uuid,text) to authenticated,service_role;

create function public.guard_video_final_exact_signoffs_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.media_type='video' and old.human_approved_at is null
  and new.human_approved_at is not null and
  (not public.video_signoff_current_v6(new.id,'owner')
   or not public.video_signoff_current_v6(new.id,'manager')
   or (exists(select 1 from public.video_client_approval_requests r where r.asset_id=new.id)
    and not public.video_signoff_current_v6(new.id,'client')))
  then raise exception 'Current exact owner, SMM and requested client Inbox signoffs are required.' using errcode='42501'; end if;
 return new;
end $$;
create trigger video_final_exact_signoffs_v6
 before update of human_approved_at on public.client_media_assets for each row
 execute function public.guard_video_final_exact_signoffs_v6();

revoke all on function public.guard_video_seat_signoff_v6() from public,anon,authenticated,service_role;
revoke all on function public.guard_video_final_exact_signoffs_v6() from public,anon,authenticated,service_role;
revoke all on function public.decide_video_seat_inbox_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_video_seat_inbox_v6(uuid,uuid,boolean,text) to authenticated;
select public.lock_down_definer_functions();
commit;
