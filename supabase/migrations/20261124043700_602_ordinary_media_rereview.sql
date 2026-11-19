-- A changed file needs a fresh exact review. Keep every historical signoff,
-- clear only stale source authority, and require a new Inbox decision.
begin;

alter table public.ordinary_media_signoffs_v6
  drop constraint ordinary_media_signoffs_v6_pkey;
alter table public.ordinary_media_signoffs_v6
  add column id uuid not null default gen_random_uuid();
alter table public.ordinary_media_signoffs_v6
  add constraint ordinary_media_signoffs_v6_pkey primary key(id);
alter table public.ordinary_media_signoffs_v6
  alter column approved_at set default clock_timestamp();
create index ordinary_media_signoffs_asset_latest_v8
  on public.ordinary_media_signoffs_v6(asset_id,approved_at desc,id desc);

create table public.ordinary_media_reopen_events_v8 (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.client_media_assets(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  prior_request_id uuid not null references public.approval_requests_v6(id),
  reopened_by uuid not null references public.profiles(id),
  reopened_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason))>0)
);
alter table public.ordinary_media_reopen_events_v8 enable row level security;
create policy ordinary_media_reopen_read_v8 on public.ordinary_media_reopen_events_v8
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.ordinary_media_reopen_events_v8
  from public,anon,authenticated,service_role;
grant select on public.ordinary_media_reopen_events_v8 to authenticated,service_role;
create trigger ordinary_media_reopen_immutable_v8
  before update or delete on public.ordinary_media_reopen_events_v8
  for each row execute function public.reject_approval_ledger_mutation_v6();

create or replace function public.ordinary_media_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public,storage set timezone='UTC' as $$
declare r public.approval_requests_v6%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  a public.client_media_assets%rowtype;
  s public.ordinary_media_signoffs_v6%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'ordinary_media'
    or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where id=r.source_id::uuid and client_id=r.client_id and canonical_request_id=r.id;
  if q.id is null then return 'cancelled'; end if;
  select * into a from public.client_media_assets
    where id=q.asset_id and client_id=q.client_id;
  if a.id is null then return 'cancelled'; end if;
  h:=public.ordinary_media_review_hash_v6(q);
  if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
    or r.source_version is distinct from h||':'||q.request_token::text
    or r.preview is distinct from public.ordinary_media_review_preview_v6(q)
    or r.scope is distinct from public.ordinary_media_review_scope_v6(q)
    or r.destination is distinct from 'creative_source:'||a.id::text
    then return 'superseded'; end if;
  if a.media_type not in ('image','text') or a.content_format<>'single'
    or a.render_path is not null or a.edit_stage<>'review_ready'
    or a.archived_at is not null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null or exists(select 1 from public.content_slots cs
      where cs.asset_id=a.id and cs.stage='awaiting_approval')
    then return 'source_held'; end if;
  if exists(select 1 from public.ordinary_media_review_requests_v6 newer
    where newer.asset_id=a.id and (newer.created_at,newer.id)>(q.created_at,q.id))
    then return 'source_held'; end if;
  select * into s from public.ordinary_media_signoffs_v6
    where approved_request_id=r.id and asset_id=a.id and client_id=a.client_id;
  if a.human_approved_at is not null then
    if s.id is not null and s.approved_hash=h then return 'source_decided'; end if;
    return 'source_held';
  end if;
  if s.id is not null and s.approved_hash<>h then return 'source_held'; end if;
  if a.review_status not in ('pending','approved') then return 'source_held'; end if;
  return 'pending';
end $$;

create or replace function public.guard_ordinary_media_human_approval_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare s public.ordinary_media_signoffs_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
begin
  if new.human_approved_at is null
    or new.media_type not in ('image','text') or new.content_format<>'single'
    or exists(select 1 from public.content_slots cs
      where cs.asset_id=new.id and cs.stage='awaiting_approval')
    then return new; end if;
  select * into s from public.ordinary_media_signoffs_v6
    where asset_id=new.id order by approved_at desc,id desc limit 1;
  select * into r from public.approval_requests_v6
    where id=s.approved_request_id and client_id=new.client_id
      and source_system='aa_console' and source_kind='ordinary_media';
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  if s.id is null or r.id is null or s.approved_by is distinct from auth.uid()
    or d.decision is distinct from 'approved' or d.actor_aal<>'aal2'
    or d.actor_id is distinct from auth.uid()
    or d.artifact_hash is distinct from s.approved_hash
    or public.ordinary_media_review_source_state_v6(r.id)<>'pending'
    then raise exception 'Approve this exact creative in Approval Inbox.'
      using errcode='42501'; end if;
  return new;
end $$;

create or replace function public.ordinary_media_signoff_current_v6(p_asset_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public,storage set timezone='UTC' as $$
declare a public.client_media_assets%rowtype;
  s public.ordinary_media_signoffs_v6%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if auth.role() not in ('authenticated','service_role') then return false; end if;
  select * into a from public.client_media_assets where id=p_asset_id;
  if a.id is null or (auth.role()='authenticated'
    and not public.can_access_client(a.client_id)) then return false; end if;
  if a.media_type not in ('image','text') or a.content_format<>'single'
    or a.render_path is not null or a.edit_stage<>'review_ready'
    or a.archived_at is not null or a.review_status<>'approved'
    or a.human_approved_at is null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null then return false; end if;
  select * into s from public.ordinary_media_signoffs_v6
    where asset_id=a.id and client_id=a.client_id
    order by approved_at desc,id desc limit 1;
  if s.id is null then return false; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where canonical_request_id=s.approved_request_id
      and asset_id=a.id and client_id=a.client_id;
  if q.id is null then return false; end if;
  h:=public.ordinary_media_review_hash_v6(q);
  select * into r from public.approval_requests_v6
    where id=s.approved_request_id and client_id=a.client_id
      and source_system='aa_console' and source_kind='ordinary_media'
      and source_id=q.id::text;
  if r.id is null or h is null or q.source_hash is distinct from h
    or s.approved_hash is distinct from h or r.artifact_hash is distinct from h
    or r.source_version is distinct from h||':'||q.request_token::text
    or r.preview is distinct from public.ordinary_media_review_preview_v6(q)
    or r.scope is distinct from public.ordinary_media_review_scope_v6(q)
    or r.destination is distinct from 'creative_source:'||a.id::text
    or exists(select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id=r.id)
    or exists(select 1 from public.ordinary_media_review_requests_v6 newer
      where newer.asset_id=a.id and (newer.created_at,newer.id)>(q.created_at,q.id))
    then return false; end if;
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  return d.decision='approved' and d.actor_aal='aal2'
    and d.actor_id=s.approved_by and d.artifact_hash=h
    and d.source_decision_ref='ordinary_media:'||q.id::text||':'||q.request_token::text;
end $$;

create or replace function public.request_ordinary_media_review_v6(p_asset_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.client_media_assets%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  s public.ordinary_media_signoffs_v6%rowtype;
  h text;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must request creative review.' using errcode='42501';
  end if;
  select * into a from public.client_media_assets where id=p_asset_id for update;
  if a.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(a.client_id),false)
    or coalesce(public.is_client_user(a.client_id),false)) then
    raise exception 'The asset or decision owner is unavailable.' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ordinary_media_review:'||a.id::text,0));
  if a.media_type not in ('image','text') or a.content_format<>'single'
    or a.render_path is not null or a.edit_stage<>'review_ready'
    or a.archived_at is not null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null or a.review_status not in ('pending','approved')
    or exists(select 1 from public.content_slots cs
      where cs.asset_id=a.id and cs.stage='awaiting_approval') then
    raise exception 'This asset needs current bytes, rights and its owning review route.'
      using errcode='23514';
  end if;
  if a.human_approved_at is not null then
    if public.ordinary_media_signoff_current_v6(a.id) then
      raise exception 'This exact creative is already approved.' using errcode='23514';
    end if;
    select * into s from public.ordinary_media_signoffs_v6
      where asset_id=a.id and client_id=a.client_id
      order by approved_at desc,id desc limit 1;
    if s.id is null then
      raise exception 'Legacy approval needs a separate reconciliation.' using errcode='23514';
    end if;
    insert into public.ordinary_media_reopen_events_v8
      (asset_id,client_id,prior_request_id,reopened_by,reason)
    values(a.id,a.client_id,s.approved_request_id,auth.uid(),
      'The prior exact creative signoff is stale; request a new review.');
    update public.client_media_assets
      set human_approved_at=null,review_status='pending' where id=a.id;
  end if;
  select * into q from public.ordinary_media_review_requests_v6
    where asset_id=a.id order by created_at desc,id desc limit 1;
  if q.id is not null and q.canonical_request_id is not null
    and q.source_hash=public.ordinary_media_review_hash_v6(q)
    and exists(select 1 from public.approval_requests_v6 r
      where r.id=q.canonical_request_id and r.expires_at>now()
        and r.artifact_hash=q.source_hash)
    and not exists(select 1 from public.approval_decision_events_v6 d
      where d.request_id=q.canonical_request_id)
    then return q.canonical_request_id; end if;
  insert into public.ordinary_media_review_requests_v6(asset_id,client_id,created_at)
    values(a.id,a.client_id,clock_timestamp()) returning * into q;
  h:=public.ordinary_media_review_hash_v6(q);
  if h is null then raise exception 'Creative Storage identity is unavailable.'
    using errcode='23514'; end if;
  update public.ordinary_media_review_requests_v6 set source_hash=h
    where id=q.id returning * into q;
  q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
    'client_id',q.client_id,'source_system','aa_console',
    'source_kind','ordinary_media','source_id',q.id::text,
    'source_version',h||':'||q.request_token::text,
    'title','Review creative: '||coalesce(nullif(a.title,''),a.id::text),
    'artifact_hash',h,'preview',public.ordinary_media_review_preview_v6(q),
    'destination','creative_source:'||a.id::text,
    'scope',public.ordinary_media_review_scope_v6(q),
    'owner_role','admin_or_active_client_manager',
    'requested_by',auth.uid(),'requester_kind','human',
    'expires_at',now()+interval '7 days',
    'owning_path','/clients/'||a.client_id::text||'/delivery/approval-inbox?tab=assets'));
  update public.ordinary_media_review_requests_v6
    set canonical_request_id=q.canonical_request_id where id=q.id;
  return q.canonical_request_id;
end $$;

revoke all on function public.ordinary_media_review_source_state_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.ordinary_media_review_source_state_v6(uuid)
  to authenticated,service_role;
revoke all on function public.ordinary_media_signoff_current_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.ordinary_media_signoff_current_v6(uuid)
  to authenticated,service_role;
revoke all on function public.request_ordinary_media_review_v6(uuid)
  from public,anon,service_role;
grant execute on function public.request_ordinary_media_review_v6(uuid)
  to authenticated;
revoke all on function public.guard_ordinary_media_human_approval_v6()
  from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
