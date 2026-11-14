-- The owner of every video sign-off is an agency-wide authority, not a
-- per-asset approval. Changing that person needs a separate exact decision.
begin;
create table public.global_video_owner_reviews_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 proposed_owner uuid not null references public.profiles(id),
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 applied_at timestamptz,
 applied_by uuid references auth.users(id),
 created_at timestamptz not null default now()
);
alter table public.global_video_owner_reviews_v6 enable row level security;
revoke all on public.global_video_owner_reviews_v6 from public,anon,authenticated,service_role;

create function public.global_video_owner_preview_v6(q public.global_video_owner_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('action','assign_global_video_approval_owner',
  'request_token',q.request_token,'current_owner',s.owner_user_id,
  'proposed_owner',q.proposed_owner,'proposed_owner_role',p.role,
  'scope','Owner seat for all client video sign-offs until another reviewed change',
  'consequence','The proposed admin becomes the required owner reviewer for later video sign-offs',
  'asset_note','This authority change does not approve any video or publish it')
 from public.profiles p
 left join public.content_approval_settings s on s.singleton
 where p.id=q.proposed_owner;
$$;
create function public.global_video_owner_hash_v6(q public.global_video_owner_reviews_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.global_video_owner_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.global_video_owner_scope_v6(q public.global_video_owner_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('review_id',q.id,'request_token',q.request_token,
  'content_hash',public.global_video_owner_hash_v6(q),
  'proposed_owner',q.proposed_owner,'effect','change_global_video_approval_owner');
$$;

create function public.global_video_owner_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.global_video_owner_reviews_v6%rowtype;
 owner_now uuid; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.client_id is not null or r.source_system<>'aa_console'
  or r.source_kind<>'global_video_owner'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not coalesce(public.is_admin(),false))
  then return 'unverified'; end if;
 select * into q from public.global_video_owner_reviews_v6
  where id=r.source_id::uuid and canonical_request_id=r.id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.global_video_owner_reviews_v6 n
  where n.request_epoch>q.request_epoch) then return 'superseded'; end if;
 select owner_user_id into owner_now from public.content_approval_settings where singleton;
 if q.applied_at is not null then
  if owner_now=q.proposed_owner and exists(
   select 1 from public.approval_decision_events_v6 d where d.request_id=r.id
    and d.decision='approved' and d.actor_aal='aal2' and d.actor_id=q.applied_by
    and d.artifact_hash=q.source_hash and r.artifact_hash=q.source_hash)
   then return 'source_decided'; end if;
  return 'source_held';
 end if;
 h:=public.global_video_owner_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.global_video_owner_preview_v6(q)
  or r.scope is distinct from public.global_video_owner_scope_v6(q)
  or r.destination is distinct from 'agency:video_approval_owner'
  or r.owner_role is distinct from 'admin' then return 'superseded'; end if;
 if owner_now=q.proposed_owner or not exists(select 1 from public.profiles p
  where p.id=q.proposed_owner and p.role='admin') then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.request_global_video_owner_v6(p_user_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.global_video_owner_reviews_v6%rowtype; h text; owner_now uuid;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) then
  raise exception 'A provisioned admin must request global video owner changes.' using errcode='42501'; end if;
 if p_user_id is null or not exists(select 1 from public.profiles p
  where p.id=p_user_id and p.role='admin') then
  raise exception 'Choose a current admin account for video owner.' using errcode='23514'; end if;
 select owner_user_id into owner_now from public.content_approval_settings where singleton for update;
 if owner_now=p_user_id then raise exception 'This admin already owns video approval.' using errcode='23514'; end if;
 select * into q from public.global_video_owner_reviews_v6 order by request_epoch desc limit 1;
 if q.id is not null and q.proposed_owner=p_user_id
  and q.source_hash=public.global_video_owner_hash_v6(q)
  and public.global_video_owner_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 x
   where x.id=q.canonical_request_id and x.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.global_video_owner_reviews_v6(proposed_owner)
  values(p_user_id) returning * into q;
 h:=public.global_video_owner_hash_v6(q);
 update public.global_video_owner_reviews_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'source_system','aa_console','source_kind','global_video_owner',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Assign global video approval owner','artifact_hash',h,
  'preview',public.global_video_owner_preview_v6(q),
  'destination','agency:video_approval_owner',
  'scope',public.global_video_owner_scope_v6(q),'owner_role','admin',
  'requested_by',auth.uid(),'requester_kind','human',
  'expires_at',now()+interval '1 day','owning_path','/approvals'));
 update public.global_video_owner_reviews_v6 set canonical_request_id=q.canonical_request_id
  where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.guard_global_video_owner_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare rid uuid; q public.global_video_owner_reviews_v6%rowtype;
 d public.approval_decision_events_v6%rowtype;
begin
 if tg_op='UPDATE' and new.owner_user_id=old.owner_user_id then return new; end if;
 if nullif(current_setting('aa.global_video_owner_request_id',true),'') is null or
  current_setting('aa.global_video_owner_request_id',true)
   !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'Assign the video owner through its exact agency Approval Inbox decision.' using errcode='42501'; end if;
 rid:=current_setting('aa.global_video_owner_request_id',true)::uuid;
 select * into q from public.global_video_owner_reviews_v6
  where canonical_request_id=rid and proposed_owner=new.owner_user_id;
 select * into d from public.approval_decision_events_v6
  where request_id=rid order by event_order desc limit 1;
 if q.id is null or q.applied_at is not null or d.decision<>'approved'
  or d.actor_aal<>'aal2' or d.actor_id is distinct from auth.uid()
  or d.artifact_hash is distinct from q.source_hash
  or public.global_video_owner_source_state_v6(rid)<>'pending'
  then raise exception 'Global video owner review is missing or stale.' using errcode='42501'; end if;
 return new;
end $$;
create trigger global_video_owner_guard_v6 before insert or update
 on public.content_approval_settings for each row execute function public.guard_global_video_owner_v6();

create function public.invalidate_global_video_owner_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_table_name='profiles' then
  update public.global_video_owner_reviews_v6 set request_token=gen_random_uuid()
   where proposed_owner=new.id and applied_at is null;
 elsif tg_op='UPDATE' and new.owner_user_id is distinct from old.owner_user_id then
  update public.global_video_owner_reviews_v6 set request_token=gen_random_uuid()
   where applied_at is null and canonical_request_id::text is distinct from
    nullif(current_setting('aa.global_video_owner_request_id',true),'');
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger global_video_owner_invalidation_v6 after update
 on public.content_approval_settings for each row execute function public.invalidate_global_video_owner_v6();
create trigger global_video_owner_profile_invalidation_v6 after update of role
 on public.profiles for each row execute function public.invalidate_global_video_owner_v6();

create function public.decide_global_video_owner_v6(p_review_id uuid,p_request_id uuid,
 p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.global_video_owner_reviews_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 admin must decide global video owner.' using errcode='42501'; end if;
 select * into q from public.global_video_owner_reviews_v6 where id=p_review_id for update;
 if q.id is null or q.canonical_request_id is distinct from p_request_id then
  raise exception 'Global video owner review is unavailable.' using errcode='23514'; end if;
 if p_approved and q.proposed_owner=auth.uid() then
  raise exception 'An admin cannot approve their own owner assignment.' using errcode='42501'; end if;
 perform 1 from public.content_approval_settings where singleton for update;
 h:=public.global_video_owner_hash_v6(q);
 if public.global_video_owner_source_state_v6(p_request_id)<>'pending' or
  not exists(select 1 from public.approval_inbox_v6 x where x.id=p_request_id
   and x.status='pending' and x.preview_blocker is null) then
  raise exception 'Review the current global owner card in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null then
  raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'global_video_owner:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  perform set_config('aa.global_video_owner_request_id',p_request_id::text,true);
  perform public.set_content_approval_owner(q.proposed_owner);
  update public.global_video_owner_reviews_v6 set applied_at=now(),applied_by=auth.uid()
   where id=q.id;
  perform set_config('aa.global_video_owner_request_id','',true);
 end if;
 return q.id;
end $$;

revoke all on function public.global_video_owner_preview_v6(public.global_video_owner_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.global_video_owner_hash_v6(public.global_video_owner_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.global_video_owner_scope_v6(public.global_video_owner_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.global_video_owner_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.global_video_owner_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_global_video_owner_v6(uuid) from public,anon,service_role;
grant execute on function public.request_global_video_owner_v6(uuid) to authenticated;
revoke all on function public.decide_global_video_owner_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_global_video_owner_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_global_video_owner_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_global_video_owner_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
