-- Google profile proposals receive exact human decisions. No provider PATCH
-- route is released by this migration.
begin;
alter table public.google_profile_changes
 add column approved_request_id uuid references public.approval_requests_v6(id),
 add column approved_content_hash text check (approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$');

create table public.google_profile_review_requests_v6 (
 id uuid primary key default gen_random_uuid(),
 review_epoch bigint generated always as identity unique,
 change_id uuid not null references public.google_profile_changes(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check (source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 created_at timestamptz not null default now()
);
create index google_profile_review_latest_v6 on public.google_profile_review_requests_v6(change_id,review_epoch desc);
alter table public.google_profile_review_requests_v6 enable row level security;
revoke all on public.google_profile_review_requests_v6 from public,anon,authenticated,service_role;

create function public.google_profile_review_preview_v6(q public.google_profile_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',m.client_id,'change_id',m.id,
  'request_token',q.request_token,'location_id',l.id,
  'location_ref',l.location_ref,'location_title',l.title,
  'verification_state',l.verification_state,'last_read_at',l.last_read_at,
  'field',m.field,
  'current_value',m.current_value,'proposed_value',m.proposed_value,
  'reason',m.reason,
  'consequence','Approve these exact before/after words as a proposal; provider application remains held')
 from public.google_profile_changes m
 join public.client_google_locations l on l.id=m.location_id and l.client_id=m.client_id
 where m.id=q.change_id and m.client_id=q.client_id;
$$;
create function public.google_profile_review_hash_v6(q public.google_profile_review_requests_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.google_profile_review_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.google_profile_review_scope_v6(q public.google_profile_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'change_id',q.change_id,
  'review_id',q.id,'request_token',q.request_token,
  'location_id',(select m.location_id from public.google_profile_changes m where m.id=q.change_id),
  'content_hash',public.google_profile_review_hash_v6(q),
  'effect','google_profile_proposal_only');
$$;

create function public.google_profile_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype;
 q public.google_profile_review_requests_v6%rowtype;
 m public.google_profile_changes%rowtype;
 l public.client_google_locations%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'google_profile_change'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_review_approval_request_v6(r.client_id,r.owner_role))
  then return 'unverified'; end if;
 select * into q from public.google_profile_review_requests_v6 where id=r.source_id::uuid
  and client_id=r.client_id and canonical_request_id=r.id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.google_profile_review_requests_v6 newer
  where newer.change_id=q.change_id and newer.review_epoch>q.review_epoch)
  then return 'superseded'; end if;
 select * into m from public.google_profile_changes where id=q.change_id and client_id=q.client_id;
 if m.id is null then return 'cancelled'; end if;
 select * into l from public.client_google_locations where id=m.location_id and client_id=m.client_id;
 if l.id is null then return 'source_held'; end if;
 h:=public.google_profile_review_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.google_profile_review_preview_v6(q)
  or r.scope is distinct from public.google_profile_review_scope_v6(q)
  or r.destination is distinct from 'google_profile:'||l.location_ref||':'||m.field
  or r.account_ref is distinct from l.location_ref
  then return 'superseded'; end if;
 if m.status in ('drafted','awaiting_approval') then return 'pending'; end if;
 if m.status in ('approved','rejected') and m.approved_request_id=r.id
  and m.approved_content_hash=h then return 'source_decided'; end if;
 return 'source_held';
end $$;

create function public.request_google_profile_review_v6(p_change_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare m public.google_profile_changes%rowtype;
 l public.client_google_locations%rowtype;
 q public.google_profile_review_requests_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  then raise exception 'A provisioned human must request Google profile review.' using errcode='42501'; end if;
 select * into m from public.google_profile_changes where id=p_change_id for update;
 if m.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(m.client_id),false))
  then raise exception 'The Google profile change owner is unavailable.' using errcode='42501'; end if;
 if m.status not in ('drafted','awaiting_approval') then
  raise exception 'Only a pending proposal can request review.' using errcode='23514'; end if;
 select * into l from public.client_google_locations where id=m.location_id and client_id=m.client_id for share;
 if l.id is null then raise exception 'The Google location belongs to another client or is unavailable.' using errcode='23514'; end if;
 select * into q from public.google_profile_review_requests_v6 where change_id=m.id order by review_epoch desc limit 1;
 if q.id is not null and q.canonical_request_id is not null
  and q.source_hash=public.google_profile_review_hash_v6(q)
  and public.google_profile_review_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 i where i.id=q.canonical_request_id and i.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.google_profile_review_requests_v6(change_id,client_id)
  values(m.id,m.client_id) returning * into q;
 h:=public.google_profile_review_hash_v6(q);
 update public.google_profile_review_requests_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',q.client_id,'source_system','aa_console','source_kind','google_profile_change',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Review Google profile '||m.field||' at '||l.title,
  'artifact_hash',h,'preview',public.google_profile_review_preview_v6(q),
  'destination','google_profile:'||l.location_ref||':'||m.field,
  'account_ref',l.location_ref,
  'scope',public.google_profile_review_scope_v6(q),
  'owner_role','admin_or_active_client_manager','requested_by',auth.uid(),
  'requester_kind','human','expires_at',now()+interval '7 days',
  'owning_path','/clients/'||m.client_id::text||'/delivery/approval-inbox?tab=unified'));
 update public.google_profile_review_requests_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.guard_google_profile_approval_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.google_profile_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 if new.status='applied' and old.status is distinct from 'applied' then
  raise exception 'Google profile PATCH is held until a verified adapter and receipt exist.'
   using errcode='42501'; end if;
 if new.status<>'approved' or old.status='approved' then return new; end if;
 select * into q from public.google_profile_review_requests_v6
  where canonical_request_id=new.approved_request_id and change_id=new.id and client_id=new.client_id;
 select * into e from public.approval_decision_events_v6 where request_id=q.canonical_request_id
  order by event_order desc limit 1;
 if q.id is null or new.approved_content_hash is distinct from q.source_hash
  or e.decision is distinct from 'approved' or e.actor_aal<>'aal2'
  or e.actor_id is distinct from auth.uid() or e.artifact_hash is distinct from q.source_hash
  or public.google_profile_review_source_state_v6(q.canonical_request_id)<>'pending'
  then raise exception 'Approve the exact Google profile proposal in Approval Inbox.' using errcode='42501'; end if;
 return new;
end $$;
create trigger google_profile_approval_guard_v6 before update of status on public.google_profile_changes
 for each row execute function public.guard_google_profile_approval_v6();

create function public.decide_google_profile_inbox_v6(
 p_review_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.google_profile_review_requests_v6%rowtype;
 m public.google_profile_changes%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 human must decide Google profile changes.' using errcode='42501'; end if;
 select * into q from public.google_profile_review_requests_v6 where id=p_review_id for update;
 select * into m from public.google_profile_changes where id=q.change_id for update;
 if q.id is null or m.id is null or m.client_id<>q.client_id
  or not (coalesce(public.is_admin(),false)
   or coalesce(auth.uid()=public.active_video_approval_manager(m.client_id),false))
  then raise exception 'The Google profile decision owner is unavailable.' using errcode='42501'; end if;
 h:=public.google_profile_review_hash_v6(q);
 if q.canonical_request_id is distinct from p_request_id
  or public.google_profile_review_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 i
   where i.id=p_request_id and i.status='pending' and i.preview_blocker is null)
  then raise exception 'Review the current Google profile proposal in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null
  then raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'google_profile_change:'||q.id::text||':'||q.request_token::text,p_reason);
 update public.google_profile_changes set
  status=case when p_approved then 'approved' else 'rejected' end,
  approved_by=case when p_approved then auth.uid() else null end,
  approved_at=case when p_approved then now() else null end,
  approved_request_id=p_request_id,approved_content_hash=h,
  rejection_reason=case when p_approved then null else btrim(p_reason) end
  where id=m.id;
 return m.id;
end $$;

revoke all on function public.google_profile_review_preview_v6(public.google_profile_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.google_profile_review_hash_v6(public.google_profile_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.google_profile_review_scope_v6(public.google_profile_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.google_profile_review_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.google_profile_review_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_google_profile_review_v6(uuid) from public,anon,service_role;
grant execute on function public.request_google_profile_review_v6(uuid) to authenticated;
revoke all on function public.decide_google_profile_inbox_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_google_profile_inbox_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_google_profile_approval_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
