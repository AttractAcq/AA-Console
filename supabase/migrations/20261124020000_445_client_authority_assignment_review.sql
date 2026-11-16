-- SMM and creative-director assignments grant decision authority. Each
-- activation and ending needs an exact client-scoped decision. Historical
-- periods remain separate rows when a member is assigned again.
begin;
alter table public.client_assignments
 drop constraint client_assignments_member_id_client_id_key;
create unique index client_assignments_one_active_period_v6
 on public.client_assignments(member_id,client_id) where ended_at is null;

create table public.client_authority_assignment_reviews_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 client_id uuid not null references public.clients(id) on delete cascade,
 member_id uuid not null references public.team_members(id),
 action text not null check(action in ('assign','end')),
 due_date date,
 compensation numeric(12,2),
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 applied_assignment_id uuid references public.client_assignments(id),
 applied_at timestamptz,
 applied_by uuid references auth.users(id),
 created_at timestamptz not null default now()
);
create index authority_assignment_review_latest_v6
 on public.client_authority_assignment_reviews_v6(client_id,member_id,request_epoch desc);
alter table public.client_authority_assignment_reviews_v6 enable row level security;
revoke all on public.client_authority_assignment_reviews_v6 from public,anon,authenticated,service_role;

create function public.client_authority_assignment_preview_v6(q public.client_authority_assignment_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object(
  'client_id',q.client_id,'member_id',q.member_id,'request_token',q.request_token,
  'action',q.action,'member',jsonb_build_object(
   'id',m.id,'user_id',m.user_id,'category',m.category,
   'name',m.name,'active',m.active,'profile_role',p.role),
  'current_assignment',(
   select jsonb_build_object('id',ca.id,'created_at',ca.created_at,
    'ended_at',ca.ended_at,'due_date',ca.due_date,'compensation',ca.compensation)
   from public.client_assignments ca
   where ca.client_id=q.client_id and ca.member_id=q.member_id
   order by ca.created_at desc,ca.id desc limit 1),
  'active_same_category',coalesce((select jsonb_agg(jsonb_build_object(
   'assignment_id',ca.id,'member_id',tm.id,'user_id',tm.user_id)
   order by ca.created_at,ca.id)
   from public.client_assignments ca join public.team_members tm on tm.id=ca.member_id
   where ca.client_id=q.client_id and ca.ended_at is null
    and tm.category=m.category),'[]'::jsonb),
  'current_decision_seat',case when m.category::text='smm'
   then public.active_video_approval_manager(q.client_id)
   else public.active_creative_director(q.client_id) end,
  'proposed_due_date',q.due_date,'proposed_compensation',q.compensation,
  'scope','This client and this approval seat until reviewed ending or emergency deactivation',
  'consequence',case when q.action='assign' then
   'Give this employee client access and the category decision seat'
   else 'End this employee client access and remove this decision seat' end,
  'asset_note','Seat assignment never approves a creative asset')
 from public.team_members m left join public.profiles p on p.id=m.user_id
 where m.id=q.member_id;
$$;
create function public.client_authority_assignment_hash_v6(q public.client_authority_assignment_reviews_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.client_authority_assignment_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.client_authority_assignment_scope_v6(q public.client_authority_assignment_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'member_id',q.member_id,
  'review_id',q.id,'request_token',q.request_token,
  'content_hash',public.client_authority_assignment_hash_v6(q),
  'action',q.action,'effect','change_client_approval_seat');
$$;

create function public.client_authority_assignment_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.client_authority_assignment_reviews_v6%rowtype;
 m public.team_members%rowtype; a public.client_assignments%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console'
  or r.source_kind<>'client_authority_assignment'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_access_client(r.client_id))
  then return 'unverified'; end if;
 select * into q from public.client_authority_assignment_reviews_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.client_authority_assignment_reviews_v6 n
  where n.client_id=q.client_id and n.member_id=q.member_id
   and n.request_epoch>q.request_epoch) then return 'superseded'; end if;
 select * into m from public.team_members where id=q.member_id;
 if m.id is null then return 'cancelled'; end if;
 if q.applied_at is not null then
  select * into a from public.client_assignments where id=q.applied_assignment_id
   and client_id=q.client_id and member_id=q.member_id;
  if a.id is not null and ((q.action='assign' and a.ended_at is null)
   or (q.action='end' and a.ended_at is not null)) and exists(
   select 1 from public.approval_decision_events_v6 d where d.request_id=r.id
    and d.decision='approved' and d.actor_aal='aal2' and d.actor_id=q.applied_by
    and d.artifact_hash=q.source_hash and r.artifact_hash=q.source_hash)
   then return 'source_decided'; end if;
  return 'source_held';
 end if;
 h:=public.client_authority_assignment_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.client_authority_assignment_preview_v6(q)
  or r.scope is distinct from public.client_authority_assignment_scope_v6(q)
  or r.destination is distinct from ('client:approval_seat:'||q.client_id::text||':'||q.member_id::text)
  or r.owner_role is distinct from 'admin' then return 'superseded'; end if;
 if m.category::text not in ('smm','creative_director') or m.user_id is null
  then return 'source_held'; end if;
 if q.action='assign' then
  if not m.active or not exists(select 1 from public.profiles p
   where p.id=m.user_id and p.role='employee') or exists(
    select 1 from public.client_assignments ca
    join public.team_members tm on tm.id=ca.member_id
    where ca.client_id=q.client_id and ca.ended_at is null
     and tm.category=m.category) then return 'source_held'; end if;
 else
  if not exists(select 1 from public.client_assignments ca
   where ca.client_id=q.client_id and ca.member_id=q.member_id
    and ca.ended_at is null) then return 'source_held'; end if;
 end if;
 return 'pending';
end $$;

create function public.request_client_authority_assignment_v6(
 p_member_id uuid,p_client_id uuid,p_action text,
 p_due_date date default null,p_compensation numeric default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare m public.team_members%rowtype; q public.client_authority_assignment_reviews_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) then
  raise exception 'A provisioned admin must request client approval seats.' using errcode='42501'; end if;
 if p_client_id is null or p_member_id is null or p_action is null or p_action not in ('assign','end')
  or p_compensation<0 then raise exception 'A client, member and valid action are required.' using errcode='22023'; end if;
 perform 1 from public.clients where id=p_client_id for update;
 if not found then raise exception 'No such client.' using errcode='23514'; end if;
 select * into m from public.team_members where id=p_member_id for update;
 if m.id is null or m.category::text not in ('smm','creative_director')
  or m.user_id is null then raise exception 'Choose a linked SMM or creative director.' using errcode='23514'; end if;
 if p_action='assign' then
  if not m.active or not exists(select 1 from public.profiles p
    where p.id=m.user_id and p.role='employee') or exists(
    select 1 from public.client_assignments ca
    join public.team_members tm on tm.id=ca.member_id
    where ca.client_id=p_client_id and ca.ended_at is null
     and tm.category=m.category) then
   raise exception 'End the current active category seat before assigning a new one.' using errcode='23514'; end if;
 else
  if not exists(select 1 from public.client_assignments ca
   where ca.client_id=p_client_id and ca.member_id=p_member_id
    and ca.ended_at is null) then
   raise exception 'This member has no active assignment to end.' using errcode='23514'; end if;
 end if;
 select * into q from public.client_authority_assignment_reviews_v6
  where client_id=p_client_id and member_id=p_member_id
  order by request_epoch desc limit 1;
 if q.id is not null and q.action=p_action
  and q.due_date is not distinct from p_due_date
  and q.compensation is not distinct from p_compensation
  and q.source_hash=public.client_authority_assignment_hash_v6(q)
  and public.client_authority_assignment_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 x
   where x.id=q.canonical_request_id and x.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.client_authority_assignment_reviews_v6
  (client_id,member_id,action,due_date,compensation)
 values(p_client_id,p_member_id,p_action,p_due_date,p_compensation)
 returning * into q;
 h:=public.client_authority_assignment_hash_v6(q);
 update public.client_authority_assignment_reviews_v6 set source_hash=h where id=q.id
  returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',p_client_id,'source_system','aa_console',
  'source_kind','client_authority_assignment','source_id',q.id::text,
  'source_version',h||':'||q.request_token::text,
  'title',case when p_action='assign' then 'Assign ' else 'End ' end||
    m.category::text||' seat: '||m.name,
  'artifact_hash',h,'preview',public.client_authority_assignment_preview_v6(q),
  'destination','client:approval_seat:'||p_client_id::text||':'||p_member_id::text,
  'scope',public.client_authority_assignment_scope_v6(q),'owner_role','admin',
  'requested_by',auth.uid(),'requester_kind','human',
  'expires_at',now()+interval '1 day',
  'owning_path','/clients/'||p_client_id::text||'/delivery/approval-inbox?tab=unified'));
 update public.client_authority_assignment_reviews_v6
  set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.guard_client_authority_assignment_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare m public.team_members%rowtype; old_m public.team_members%rowtype;
 rid uuid; q public.client_authority_assignment_reviews_v6%rowtype;
 d public.approval_decision_events_v6%rowtype; action_now text;
begin
 select * into m from public.team_members where id=case when tg_op='DELETE' then old.member_id else new.member_id end;
 if tg_op='UPDATE' then
  select * into old_m from public.team_members where id=old.member_id;
 end if;
 if m.category::text not in ('smm','creative_director')
  and (tg_op<>'UPDATE' or old_m.category::text not in ('smm','creative_director')) then
  if tg_op='DELETE' then return old; end if;
  return new;
 end if;
 if tg_op='DELETE' then
  raise exception 'End an approval seat through its exact review; preserve assignment history.' using errcode='42501';
 end if;
 if tg_op='UPDATE' then
  if new.client_id is distinct from old.client_id or new.member_id is distinct from old.member_id then
   raise exception 'End and reassign an approval seat; do not move its historical row.' using errcode='42501'; end if;
  if (new.ended_at is null)=(old.ended_at is null) then return new; end if;
 end if;
 if new.ended_at is null then action_now:='assign'; else action_now:='end'; end if;
 if tg_op='INSERT' and action_now='end' then return new; end if;
 if nullif(current_setting('aa.client_authority_request_id',true),'') is null or
  current_setting('aa.client_authority_request_id',true)
   !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'Change the approval seat through its exact Inbox decision.' using errcode='42501'; end if;
 rid:=current_setting('aa.client_authority_request_id',true)::uuid;
 select * into q from public.client_authority_assignment_reviews_v6
  where canonical_request_id=rid and client_id=new.client_id
   and member_id=new.member_id and action=action_now;
 select * into d from public.approval_decision_events_v6
  where request_id=rid order by event_order desc limit 1;
 if q.id is null or q.applied_at is not null or d.decision<>'approved'
  or d.actor_aal<>'aal2' or d.actor_id is distinct from auth.uid()
  or d.artifact_hash is distinct from q.source_hash
  or public.client_authority_assignment_source_state_v6(rid)<>'pending'
  then raise exception 'The client approval-seat review is missing or stale.' using errcode='42501'; end if;
 return new;
end $$;
create trigger client_authority_assignment_guard_v6 before insert or update or delete
 on public.client_assignments for each row execute function public.guard_client_authority_assignment_v6();

create function public.guard_assigned_authority_member_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from public.client_assignments ca where ca.member_id=old.id
  and ca.ended_at is null) and
  (old.category::text in ('smm','creative_director')
   or new.category::text in ('smm','creative_director')) and
  (new.category is distinct from old.category
   or new.user_id is distinct from old.user_id
   or (not old.active and new.active)) then
  raise exception 'End reviewed approval-seat assignments before changing member identity or reactivating.' using errcode='42501'; end if;
 return new;
end $$;
create trigger assigned_authority_member_guard_v6 before update of category,user_id,active
 on public.team_members for each row execute function public.guard_assigned_authority_member_v6();

create function public.guard_assigned_authority_profile_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.role='employee' and old.role<>'employee' and exists(
  select 1 from public.team_members tm join public.client_assignments ca
   on ca.member_id=tm.id where tm.user_id=new.id and tm.active
    and tm.category::text in ('smm','creative_director') and ca.ended_at is null) then
  raise exception 'End reviewed approval-seat assignments before restoring employee authority.' using errcode='42501'; end if;
 return new;
end $$;
create trigger assigned_authority_profile_guard_v6 before update of role
 on public.profiles for each row execute function public.guard_assigned_authority_profile_v6();

create function public.invalidate_client_authority_assignment_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare cid uuid; mid uuid;
begin
 if tg_table_name='client_assignments' then
  if tg_op<>'INSERT' then
   update public.client_authority_assignment_reviews_v6 set request_token=gen_random_uuid()
    where client_id=old.client_id and applied_at is null
     and canonical_request_id::text is distinct from
      nullif(current_setting('aa.client_authority_request_id',true),'');
  end if;
  if tg_op<>'DELETE' then
   update public.client_authority_assignment_reviews_v6 set request_token=gen_random_uuid()
    where client_id=new.client_id and applied_at is null
     and canonical_request_id::text is distinct from
      nullif(current_setting('aa.client_authority_request_id',true),'');
  end if;
 elsif tg_table_name='team_members' then
  mid:=new.id;
  update public.client_authority_assignment_reviews_v6 set request_token=gen_random_uuid()
   where member_id=mid and applied_at is null;
 elsif tg_table_name='profiles' then
  update public.client_authority_assignment_reviews_v6 q set request_token=gen_random_uuid()
   from public.team_members tm where tm.id=q.member_id and tm.user_id=new.id
    and q.applied_at is null;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger client_authority_assignment_invalidation_v6 after insert or update or delete
 on public.client_assignments for each row execute function public.invalidate_client_authority_assignment_v6();
create trigger client_authority_member_invalidation_v6 after update
 on public.team_members for each row execute function public.invalidate_client_authority_assignment_v6();
create trigger client_authority_profile_invalidation_v6 after update of role
 on public.profiles for each row execute function public.invalidate_client_authority_assignment_v6();

-- The earlier creative-requirement invalidator is also attached to team_members.
-- Resolve the record shape per table before reading client_id; a CASE expression
-- still dereferences NEW.client_id on a team_members update in PL/pgSQL.
create or replace function public.invalidate_creative_requirement_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare cid uuid;
begin
 if tg_table_name='team_members' then
  update public.creative_requirement_reviews_v6 q set request_token=gen_random_uuid()
   from public.client_assignments ca where ca.member_id=new.id
    and ca.client_id=q.client_id and q.applied_at is null;
 elsif tg_table_name='client_assignments' then
  if tg_op='DELETE' then cid:=old.client_id; else cid:=new.client_id; end if;
  update public.creative_requirement_reviews_v6 set request_token=gen_random_uuid()
   where client_id=cid and applied_at is null
    and canonical_request_id::text is distinct from
     nullif(current_setting('aa.creative_requirement_request_id',true),'');
  if tg_op='UPDATE' and old.client_id is distinct from new.client_id then
   update public.creative_requirement_reviews_v6 set request_token=gen_random_uuid()
    where client_id=old.client_id and applied_at is null;
  end if;
 elsif tg_table_name='client_engine_settings' then
  update public.creative_requirement_reviews_v6 set request_token=gen_random_uuid()
   where client_id=new.client_id and applied_at is null
    and canonical_request_id::text is distinct from
     nullif(current_setting('aa.creative_requirement_request_id',true),'');
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;

create function public.decide_client_authority_assignment_v6(
 p_review_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.client_authority_assignment_reviews_v6%rowtype;
 m public.team_members%rowtype; assignment_id uuid; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 admin must decide a client approval seat.' using errcode='42501'; end if;
 select * into q from public.client_authority_assignment_reviews_v6
  where id=p_review_id for update;
 if q.id is null or q.canonical_request_id is distinct from p_request_id then
  raise exception 'Client approval-seat review is unavailable.' using errcode='23514'; end if;
 perform 1 from public.clients where id=q.client_id for update;
 select * into m from public.team_members where id=q.member_id for update;
 if p_approved and m.user_id=auth.uid() then
  raise exception 'An admin cannot decide their own approval-seat assignment.' using errcode='42501'; end if;
 h:=public.client_authority_assignment_hash_v6(q);
 if public.client_authority_assignment_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 x where x.id=p_request_id
   and x.status='pending' and x.preview_blocker is null) then
  raise exception 'Review the current client approval seat in Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null then
  raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'client_authority_assignment:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  perform set_config('aa.client_authority_request_id',p_request_id::text,true);
  if q.action='assign' then
   insert into public.client_assignments(member_id,client_id,due_date,compensation,created_at)
    values(q.member_id,q.client_id,q.due_date,q.compensation,clock_timestamp())
    returning id into assignment_id;
  else
   update public.client_assignments set ended_at=clock_timestamp()
    where client_id=q.client_id and member_id=q.member_id and ended_at is null
    returning id into assignment_id;
  end if;
  if assignment_id is null then
   raise exception 'Approval-seat effect was not confirmed.' using errcode='23514'; end if;
  update public.client_authority_assignment_reviews_v6
   set applied_assignment_id=assignment_id,applied_at=now(),applied_by=auth.uid()
   where id=q.id;
  perform set_config('aa.client_authority_request_id','',true);
 end if;
 return q.id;
end $$;

revoke all on function public.client_authority_assignment_preview_v6(public.client_authority_assignment_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.client_authority_assignment_hash_v6(public.client_authority_assignment_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.client_authority_assignment_scope_v6(public.client_authority_assignment_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.client_authority_assignment_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.client_authority_assignment_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_client_authority_assignment_v6(uuid,uuid,text,date,numeric) from public,anon,service_role;
grant execute on function public.request_client_authority_assignment_v6(uuid,uuid,text,date,numeric) to authenticated;
revoke all on function public.decide_client_authority_assignment_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_client_authority_assignment_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_client_authority_assignment_v6() from public,anon,authenticated,service_role;
revoke all on function public.guard_assigned_authority_member_v6() from public,anon,authenticated,service_role;
revoke all on function public.guard_assigned_authority_profile_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_client_authority_assignment_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
