-- A single-file image or text creative can request an exact review. Video,
-- carousels and Engine slots keep their distinct owning gates.
begin;
create table public.ordinary_media_review_requests_v6 (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.client_media_assets(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  request_token uuid not null default gen_random_uuid(),
  source_hash text check (source_hash ~ '^[0-9a-f]{64}$'),
  canonical_request_id uuid unique references public.approval_requests_v6(id),
  created_at timestamptz not null default now(),
  foreign key(asset_id,client_id)
    references public.client_media_assets(id,client_id)
);
create index ordinary_media_review_latest_v6
  on public.ordinary_media_review_requests_v6(asset_id,created_at desc);
alter table public.ordinary_media_review_requests_v6 enable row level security;
revoke all on public.ordinary_media_review_requests_v6
  from public,anon,authenticated,service_role;

create function public.ordinary_media_review_preview_v6(
  p_review public.ordinary_media_review_requests_v6)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, storage as $$
  select jsonb_build_object(
    'client_id',p_review.client_id,'asset_id',a.id,
    'request_token',p_review.request_token,
    'asset',jsonb_build_object(
      'id',a.id,'client_id',a.client_id,'brief_id',a.brief_id,
      'source_asset_id',a.source_asset_id,'title',a.title,
      'media_type',a.media_type,'content_format',a.content_format,
      'storage_path',a.storage_path,'render_path',a.render_path,
      'file_sha256',a.delivery_bytes_sha256,
      'usage_rights',a.usage_rights,'intake_source',a.intake_source,
      'edit_stage',a.edit_stage,'archived_at',a.archived_at),
    'storage',jsonb_build_object('object_id',o.id,'version',o.version,
      'updated_at',o.updated_at,'bucket','client-media'),
    'consequence','Human source approval of this exact image or text file; publication requires a separate destination decision')
  from public.client_media_assets a
  join storage.objects o on o.bucket_id='client-media' and o.name=a.storage_path
  where a.id=p_review.asset_id and a.client_id=p_review.client_id
    and a.render_path is null;
$$;
create function public.ordinary_media_review_hash_v6(
  p_review public.ordinary_media_review_requests_v6)
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    (public.ordinary_media_review_preview_v6(p_review)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.ordinary_media_review_scope_v6(
  p_review public.ordinary_media_review_requests_v6)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object('client_id',p_review.client_id,
    'asset_id',p_review.asset_id,'review_id',p_review.id,
    'request_token',p_review.request_token,
    'content_hash',public.ordinary_media_review_hash_v6(p_review),
    'effect','creative_source_signoff');
$$;

create function public.ordinary_media_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare r public.approval_requests_v6%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  a public.client_media_assets%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if r.id is null or r.source_system <> 'aa_console'
    or r.source_kind <> 'ordinary_media'
    or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where id=r.source_id::uuid and client_id=r.client_id
      and canonical_request_id=r.id;
  if q.id is null then return 'cancelled'; end if;
  select * into a from public.client_media_assets
    where id=q.asset_id and client_id=q.client_id;
  if a.id is null then return 'cancelled'; end if;
  h := public.ordinary_media_review_hash_v6(q);
  if h is null or q.source_hash is distinct from h
    or r.artifact_hash is distinct from h
    or r.source_version is distinct from h||':'||q.request_token::text
    or r.preview is distinct from public.ordinary_media_review_preview_v6(q)
    or r.scope is distinct from public.ordinary_media_review_scope_v6(q)
    or r.destination is distinct from 'creative_source:'||a.id::text
    then return 'superseded'; end if;
  if a.media_type not in ('image','text') or a.content_format <> 'single'
    or a.render_path is not null or a.edit_stage <> 'review_ready'
    or a.archived_at is not null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null
    or exists(select 1 from public.content_slots s
      where s.asset_id=a.id and s.stage='awaiting_approval')
    then return 'source_held'; end if;
  if a.human_approved_at is not null then return 'source_decided'; end if;
  if a.review_status not in ('pending','approved') then return 'source_held'; end if;
  return 'pending';
end $$;

create function public.request_ordinary_media_review_v6(p_asset_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone='UTC' as $$
declare a public.client_media_assets%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  h text;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must request creative review.'
      using errcode='42501'; end if;
  select * into a from public.client_media_assets where id=p_asset_id for update;
  if a.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(a.client_id),false)
    or coalesce(public.is_client_user(a.client_id),false))
    then raise exception 'The asset or decision owner is unavailable.'
      using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ordinary_media_review:'||a.id::text,0));
  if a.media_type not in ('image','text') or a.content_format <> 'single'
    or a.render_path is not null or a.edit_stage <> 'review_ready'
    or a.archived_at is not null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null or a.human_approved_at is not null
    or a.review_status not in ('pending','approved')
    or exists(select 1 from public.content_slots s
      where s.asset_id=a.id and s.stage='awaiting_approval') then
    raise exception 'This asset needs current bytes, rights and its owning review route.'
      using errcode='23514'; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where asset_id=a.id order by created_at desc limit 1;
  if q.id is not null and q.canonical_request_id is not null
    and q.source_hash=public.ordinary_media_review_hash_v6(q)
    and exists(select 1 from public.approval_requests_v6 r
      where r.id=q.canonical_request_id and r.expires_at>now()
        and r.artifact_hash=q.source_hash)
    and not exists(select 1 from public.approval_decision_events_v6 d
      where d.request_id=q.canonical_request_id)
    then return q.canonical_request_id; end if;
  insert into public.ordinary_media_review_requests_v6(asset_id,client_id)
    values(a.id,a.client_id) returning * into q;
  h := public.ordinary_media_review_hash_v6(q);
  if h is null then raise exception 'Creative Storage identity is unavailable.'
    using errcode='23514'; end if;
  update public.ordinary_media_review_requests_v6 set source_hash=h
    where id=q.id returning * into q;
  q.canonical_request_id := public.register_approval_request_v6(jsonb_build_object(
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

revoke all on function public.ordinary_media_review_preview_v6(
  public.ordinary_media_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.ordinary_media_review_hash_v6(
  public.ordinary_media_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.ordinary_media_review_scope_v6(
  public.ordinary_media_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.ordinary_media_review_source_state_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.ordinary_media_review_source_state_v6(uuid)
  to authenticated,service_role;
revoke all on function public.request_ordinary_media_review_v6(uuid)
  from public,anon,service_role;
grant execute on function public.request_ordinary_media_review_v6(uuid)
  to authenticated;
select public.lock_down_definer_functions();
commit;
