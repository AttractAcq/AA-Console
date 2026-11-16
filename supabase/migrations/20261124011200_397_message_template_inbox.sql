-- Exact standing approval for one immutable message version, purpose,
-- channel and human-asserted consent basis.
begin;
alter table public.message_template_approvals
 add column approved_request_id uuid references public.approval_requests_v6(id),
 add column approved_content_hash text check (approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$');

create table public.message_template_review_requests_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 template_version_id uuid not null references public.message_template_versions(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 request_token uuid not null default gen_random_uuid(),
 consent_basis text not null check(length(btrim(consent_basis)) between 1 and 1000),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 created_at timestamptz not null default now()
);
create index message_template_review_latest_v6
 on public.message_template_review_requests_v6(template_version_id,request_epoch desc);
alter table public.message_template_review_requests_v6 enable row level security;
revoke all on public.message_template_review_requests_v6 from public,anon,authenticated,service_role;

-- Rotate the review token on every relevant metadata edit, so restoring old
-- words cannot revive a previously stale standing approval.
create function public.invalidate_message_template_reviews_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.name,new.purpose,new.channel_key,new.campaign_id,new.archived_at) is distinct from
  (old.name,old.purpose,old.channel_key,old.campaign_id,old.archived_at) then
  update public.message_template_review_requests_v6 q set request_token=gen_random_uuid()
   where q.template_version_id in
    (select v.id from public.message_template_versions v where v.template_id=new.id);
 end if;
 return new;
end $$;
create trigger message_template_review_invalidation_v6
 after update on public.message_templates for each row
 execute function public.invalidate_message_template_reviews_v6();

create function public.message_template_review_preview_v6(q public.message_template_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',t.client_id,'template_id',t.id,
  'template_version_id',v.id,'request_token',q.request_token,
  'name',t.name,'purpose',t.purpose,'channel',t.channel_key,
  'campaign_id',t.campaign_id,'archived_at',t.archived_at,
  'version',v.version,'subject',v.subject,'body',v.body,
  'placeholders',v.placeholders,'payload_hash',v.payload_hash,
  'consent_basis',q.consent_basis,'channel_supported',ch.supported,
  'consequence','Standing permission to send this exact version to individually eligible leads; each send rechecks consent and suppression')
 from public.message_template_versions v
 join public.message_templates t on t.id=v.template_id and t.client_id=v.client_id
 join public.message_channels ch on ch.channel_key=t.channel_key
 where v.id=q.template_version_id and v.client_id=q.client_id;
$$;
create function public.message_template_review_hash_v6(q public.message_template_review_requests_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.message_template_review_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.message_template_review_scope_v6(q public.message_template_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'template_version_id',q.template_version_id,
  'review_id',q.id,'request_token',q.request_token,
  'content_hash',public.message_template_review_hash_v6(q),
  'effect','standing_template_send_permission');
$$;

create function public.message_template_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype;
 q public.message_template_review_requests_v6%rowtype;
 v public.message_template_versions%rowtype;
 t public.message_templates%rowtype;
 a public.message_template_approvals%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'message_template'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_access_client(r.client_id))
  then return 'unverified'; end if;
 select * into q from public.message_template_review_requests_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.message_template_review_requests_v6 newer
  where newer.template_version_id=q.template_version_id and newer.request_epoch>q.request_epoch)
  then return 'superseded'; end if;
 select * into v from public.message_template_versions where id=q.template_version_id and client_id=q.client_id;
 select * into t from public.message_templates where id=v.template_id and client_id=v.client_id;
 if v.id is null or t.id is null then return 'cancelled'; end if;
 h:=public.message_template_review_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.message_template_review_preview_v6(q)
  or r.scope is distinct from public.message_template_review_scope_v6(q)
  or r.destination is distinct from 'outbound_template:'||t.channel_key||':'||v.id::text
  then return 'superseded'; end if;
 select * into a from public.message_template_approvals
  where template_version_id=v.id and channel_key=t.channel_key;
 if a.id is not null and a.status='revoked' and a.approved_request_id=r.id
  then return 'revoked'; end if;
 if t.archived_at is not null or not exists(select 1 from public.message_channels ch
  where ch.channel_key=t.channel_key and ch.supported) or v.payload_hash is distinct from
  public.message_payload_hash_v6(v.subject,v.body,t.channel_key)
  then return 'source_held'; end if;
 if a.id is not null and a.status='approved' and a.client_id=t.client_id
  and a.purpose=t.purpose and a.consent_basis=q.consent_basis
  and a.approved_request_id=r.id and a.approved_content_hash=h
  then return 'source_decided'; end if;
 return 'pending';
end $$;

create function public.request_message_template_review_v6(p_version_id uuid,p_consent_basis text)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare v public.message_template_versions%rowtype;
 t public.message_templates%rowtype; q public.message_template_review_requests_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  then raise exception 'A provisioned human must request message review.' using errcode='42501'; end if;
 select * into v from public.message_template_versions where id=p_version_id for update;
 select * into t from public.message_templates where id=v.template_id and client_id=v.client_id;
 if v.id is null or t.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(t.client_id),false))
  then raise exception 'The message or review owner is unavailable.' using errcode='42501'; end if;
 if nullif(btrim(coalesce(p_consent_basis,'')),'') is null or length(p_consent_basis)>1000
  then raise exception 'A specific consent basis is required.' using errcode='22023'; end if;
 if t.archived_at is not null or v.payload_hash is distinct from
  public.message_payload_hash_v6(v.subject,v.body,t.channel_key)
  or not exists(select 1 from public.message_channels ch
   where ch.channel_key=t.channel_key and ch.supported)
  then raise exception 'This version or channel is not reviewable.' using errcode='23514'; end if;
 select * into q from public.message_template_review_requests_v6
  where template_version_id=v.id order by request_epoch desc limit 1;
 if q.id is not null and q.consent_basis=btrim(p_consent_basis)
  and q.source_hash=public.message_template_review_hash_v6(q)
  and public.message_template_review_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 i
   where i.id=q.canonical_request_id and i.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.message_template_review_requests_v6(template_version_id,client_id,consent_basis)
  values(v.id,t.client_id,btrim(p_consent_basis)) returning * into q;
 h:=public.message_template_review_hash_v6(q);
 update public.message_template_review_requests_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',q.client_id,'source_system','aa_console','source_kind','message_template',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Approve message: '||t.name||' v'||v.version::text,
  'artifact_hash',h,'preview',public.message_template_review_preview_v6(q),
  'destination','outbound_template:'||t.channel_key||':'||v.id::text,
  'scope',public.message_template_review_scope_v6(q),
  'owner_role','admin_or_active_client_manager','requested_by',auth.uid(),
  'requester_kind','human','expires_at',now()+interval '7 days',
  'owning_path','/clients/'||t.client_id::text||'/delivery/approval-inbox?tab=unified'));
 update public.message_template_review_requests_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.guard_message_template_approval_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.message_template_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 if new.status<>'approved' then return new; end if;
 if tg_op='UPDATE' and old.status='approved'
  and (new.template_version_id,new.client_id,new.channel_key,new.purpose,new.consent_basis,
    new.approved_request_id,new.approved_content_hash) is not distinct from
   (old.template_version_id,old.client_id,old.channel_key,old.purpose,old.consent_basis,
    old.approved_request_id,old.approved_content_hash) then return new; end if;
 select * into q from public.message_template_review_requests_v6
  where canonical_request_id=new.approved_request_id
   and template_version_id=new.template_version_id and client_id=new.client_id;
 select * into e from public.approval_decision_events_v6 where request_id=q.canonical_request_id
  order by event_order desc limit 1;
 if q.id is null or new.consent_basis is distinct from q.consent_basis
  or new.approved_content_hash is distinct from q.source_hash
  or e.decision is distinct from 'approved' or e.actor_aal<>'aal2'
  or e.actor_id is distinct from auth.uid() or e.artifact_hash is distinct from q.source_hash
  or public.message_template_review_source_state_v6(q.canonical_request_id)<>'pending'
  then raise exception 'Approve this exact message in Approval Inbox.' using errcode='42501'; end if;
 return new;
end $$;
create trigger message_template_approval_guard_v6
 before insert or update on public.message_template_approvals
 for each row execute function public.guard_message_template_approval_v6();

create function public.decide_message_template_inbox_v6(
 p_review_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.message_template_review_requests_v6%rowtype;
 v public.message_template_versions%rowtype;
 t public.message_templates%rowtype; h text; a_id uuid;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 human must decide message approval.' using errcode='42501'; end if;
 select * into q from public.message_template_review_requests_v6 where id=p_review_id for update;
 select * into v from public.message_template_versions where id=q.template_version_id for update;
 select * into t from public.message_templates where id=v.template_id;
 if q.id is null or v.id is null or t.id is null or v.client_id<>q.client_id
  or t.client_id<>q.client_id or not (coalesce(public.is_admin(),false)
   or coalesce(auth.uid()=public.active_video_approval_manager(t.client_id),false))
  then raise exception 'The message decision owner is unavailable.' using errcode='42501'; end if;
 h:=public.message_template_review_hash_v6(q);
 if q.canonical_request_id is distinct from p_request_id
  or public.message_template_review_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 i
   where i.id=p_request_id and i.status='pending' and i.preview_blocker is null)
  then raise exception 'Review the current message in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null
  then raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'message_template:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  insert into public.message_template_approvals(template_version_id,client_id,channel_key,
   purpose,consent_basis,approved_by,approved_request_id,approved_content_hash)
   values(v.id,t.client_id,t.channel_key,t.purpose,q.consent_basis,auth.uid(),p_request_id,h)
   on conflict(template_version_id,channel_key) do update set
    status='approved',consent_basis=excluded.consent_basis,
    purpose=excluded.purpose,approved_by=excluded.approved_by,approved_at=now(),
    approved_request_id=excluded.approved_request_id,approved_content_hash=excluded.approved_content_hash,
    revoked_by=null,revoked_at=null,revoked_reason=null
   returning id into a_id;
 end if;
 return coalesce(a_id,v.id);
end $$;

create or replace function public.approve_message_template_v6(p_template_version_id uuid,p_consent_basis text)
returns public.message_template_approvals language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 raise exception 'Approve the exact message and consent basis in Approval Inbox.' using errcode='42501';
end $$;

revoke all on function public.message_template_review_preview_v6(public.message_template_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.message_template_review_hash_v6(public.message_template_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.message_template_review_scope_v6(public.message_template_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.message_template_review_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.message_template_review_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_message_template_review_v6(uuid,text) from public,anon,service_role;
grant execute on function public.request_message_template_review_v6(uuid,text) to authenticated;
revoke all on function public.decide_message_template_inbox_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_message_template_inbox_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_message_template_approval_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_message_template_reviews_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
