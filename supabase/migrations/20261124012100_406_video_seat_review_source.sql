-- Exact rendered-video signoff requests for owner, SMM and optional client.
begin;
alter table public.video_approval_signoffs
 add column approved_request_id uuid references public.approval_requests_v6(id),
 add column approved_content_hash text check(approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$');

create table public.video_seat_review_requests_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 asset_id uuid not null references public.client_media_assets(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 approval_role text not null check(approval_role in ('owner','manager','client')),
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 created_at timestamptz not null default now(),
 foreign key(asset_id,client_id) references public.client_media_assets(id,client_id)
);
create index video_seat_review_latest_v6 on
 public.video_seat_review_requests_v6(asset_id,approval_role,request_epoch desc);
alter table public.video_seat_review_requests_v6 enable row level security;
revoke all on public.video_seat_review_requests_v6 from public,anon,authenticated,service_role;

create or replace function public.can_review_approval_request_v6(p_client_id uuid,p_owner_role text)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(public.is_admin(),false) or coalesce((
  p_client_id is not null and case
   when p_owner_role='admin_or_active_client_manager' then
    auth.uid()=public.active_video_approval_manager(p_client_id)
   when p_owner_role='client_media_reviewer' then public.can_access_client(p_client_id)
   when p_owner_role ~* '^video_(owner|manager|client):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then auth.uid()=split_part(p_owner_role,':',2)::uuid
   else false end),false);
$$;

create function public.video_seat_reviewer_v6(p_asset_id uuid,p_role text)
returns uuid language sql stable security definer set search_path=pg_catalog,public as $$
 select case p_role
  when 'owner' then (select s.owner_user_id from public.content_approval_settings s
   join public.profiles p on p.id=s.owner_user_id and p.role='admin' where s.singleton)
  when 'manager' then public.active_video_approval_manager(a.client_id)
  when 'client' then (select r.client_user_id from public.video_client_approval_requests r
   join public.client_users cu on cu.client_id=a.client_id and cu.user_id=r.client_user_id
   join public.profiles p on p.id=cu.user_id and p.role='client'
   where r.asset_id=a.id and r.rejected_at is null)
  else null end
 from public.client_media_assets a where a.id=p_asset_id;
$$;

create function public.video_seat_review_preview_v6(q public.video_seat_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,storage as $$
 select jsonb_build_object('client_id',a.client_id,'asset_id',a.id,
  'request_token',q.request_token,'approval_role',q.approval_role,
  'assigned_reviewer',public.video_seat_reviewer_v6(a.id,q.approval_role),
  'client_review_requested_at',case when q.approval_role='client' then cr.requested_at else null end,
  'client_review_requested_by',case when q.approval_role='client' then cr.requested_by else null end,
  'asset',jsonb_build_object('title',a.title,'brief_id',a.brief_id,
   'source_asset_id',a.source_asset_id,'media_type',a.media_type,
   'content_format',a.content_format,'render_path',coalesce(nullif(btrim(a.render_path),''),a.storage_path),
   'file_sha256',a.delivery_bytes_sha256,'usage_rights',a.usage_rights,
   'edit_stage',a.edit_stage,'archived_at',a.archived_at),
  'storage',jsonb_build_object('bucket','client-media','object_id',o.id,
   'version',o.version,'updated_at',o.updated_at),
  'consequence','One human seat signs these exact rendered video bytes; final asset release requires every required seat and a separate distribution gate')
 from public.client_media_assets a
 left join public.video_client_approval_requests cr on cr.asset_id=a.id
 join storage.objects o on o.bucket_id='client-media'
  and o.name=coalesce(nullif(btrim(a.render_path),''),a.storage_path)
 where a.id=q.asset_id and a.client_id=q.client_id;
$$;
create function public.video_seat_review_hash_v6(q public.video_seat_review_requests_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.video_seat_review_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.video_seat_review_scope_v6(q public.video_seat_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'asset_id',q.asset_id,
  'review_id',q.id,'approval_role',q.approval_role,
  'assigned_reviewer',public.video_seat_reviewer_v6(q.asset_id,q.approval_role),
  'request_token',q.request_token,'content_hash',public.video_seat_review_hash_v6(q),
  'effect','rendered_video_seat_signoff');
$$;

create function public.video_seat_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public,storage as $$
declare r public.approval_requests_v6%rowtype;
 q public.video_seat_review_requests_v6%rowtype;
 a public.client_media_assets%rowtype;
 sig public.video_approval_signoffs%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'video_seat'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated'
   or not public.can_access_client(r.client_id))
  then return 'unverified'; end if;
 select * into q from public.video_seat_review_requests_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.video_seat_review_requests_v6 newer
  where newer.asset_id=q.asset_id and newer.approval_role=q.approval_role
   and newer.request_epoch>q.request_epoch) then return 'superseded'; end if;
 select * into a from public.client_media_assets where id=q.asset_id and client_id=q.client_id;
 if a.id is null then return 'cancelled'; end if;
 h:=public.video_seat_review_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.video_seat_review_preview_v6(q)
  or r.scope is distinct from public.video_seat_review_scope_v6(q)
  or r.destination is distinct from 'video_seat:'||q.approval_role||':'||a.id::text
  or r.owner_role is distinct from 'video_'||q.approval_role||':'||
    public.video_seat_reviewer_v6(a.id,q.approval_role)::text
  then return 'superseded'; end if;
 if a.media_type<>'video' or a.edit_stage<>'review_ready'
  or a.archived_at is not null
  or a.delivery_bytes_sha256 is null or a.usage_rights is null
  or public.video_seat_reviewer_v6(a.id,q.approval_role) is null
  then return 'source_held'; end if;
 select * into sig from public.video_approval_signoffs
  where asset_id=a.id and approval_role=q.approval_role;
 if sig.asset_id is not null and sig.approved_request_id=r.id
  and sig.approved_content_hash=h and sig.user_id=public.video_seat_reviewer_v6(a.id,q.approval_role)
  and sig.render_path=coalesce(nullif(btrim(a.render_path),''),a.storage_path)
  then return 'source_decided'; end if;
 if a.human_approved_at is not null then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.request_video_seat_review_v6(p_asset_id uuid,p_role text)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.client_media_assets%rowtype;
 q public.video_seat_review_requests_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  then raise exception 'A provisioned human must request video review.' using errcode='42501'; end if;
 select * into a from public.client_media_assets where id=p_asset_id for update;
 if a.id is null or p_role not in ('owner','manager','client')
  or not public.can_access_client(a.client_id)
  then raise exception 'The video or review role is unavailable.' using errcode='42501'; end if;
 if not (coalesce(public.is_admin(),false)
  or auth.uid()=public.active_video_approval_manager(a.client_id)
  or auth.uid()=public.video_seat_reviewer_v6(a.id,p_role))
  then raise exception 'Only the assigned reviewer, SMM or admin may request video review.' using errcode='42501'; end if;
 if a.media_type<>'video' or a.edit_stage<>'review_ready'
  or a.human_approved_at is not null or a.archived_at is not null
  or a.delivery_bytes_sha256 is null or a.usage_rights is null
  or public.video_seat_reviewer_v6(a.id,p_role) is null
  or not exists(select 1 from storage.objects o where o.bucket_id='client-media'
   and o.name=coalesce(nullif(btrim(a.render_path),''),a.storage_path))
  then raise exception 'Verify the finished render bytes, rights and assigned reviewer first.' using errcode='23514'; end if;
 select * into q from public.video_seat_review_requests_v6
  where asset_id=a.id and approval_role=p_role order by request_epoch desc limit 1;
 if q.id is not null and q.source_hash=public.video_seat_review_hash_v6(q)
  and public.video_seat_review_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 i
   where i.id=q.canonical_request_id and i.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.video_seat_review_requests_v6(asset_id,client_id,approval_role)
  values(a.id,a.client_id,p_role) returning * into q;
 h:=public.video_seat_review_hash_v6(q);
 update public.video_seat_review_requests_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',a.client_id,'source_system','aa_console','source_kind','video_seat',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Sign video as '||p_role||': '||coalesce(nullif(a.title,''),a.id::text),
  'artifact_hash',h,'preview',public.video_seat_review_preview_v6(q),
  'destination','video_seat:'||p_role||':'||a.id::text,
  'scope',public.video_seat_review_scope_v6(q),
  'owner_role','video_'||p_role||':'||public.video_seat_reviewer_v6(a.id,p_role)::text,
  'requested_by',auth.uid(),
  'requester_kind','human','expires_at',now()+interval '7 days',
  'owning_path','/clients/'||a.client_id::text||'/delivery/approval-inbox?tab=assets'));
 update public.video_seat_review_requests_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

revoke all on function public.video_seat_reviewer_v6(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.video_seat_reviewer_v6(uuid,text) to authenticated,service_role;
revoke all on function public.video_seat_review_preview_v6(public.video_seat_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.video_seat_review_hash_v6(public.video_seat_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.video_seat_review_scope_v6(public.video_seat_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.video_seat_review_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.video_seat_review_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_video_seat_review_v6(uuid,text) from public,anon,service_role;
grant execute on function public.request_video_seat_review_v6(uuid,text) to authenticated;
select public.lock_down_definer_functions();
commit;
