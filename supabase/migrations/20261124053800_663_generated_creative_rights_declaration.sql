-- A generated file has no inferred ownership. Record a human rights claim
-- against the attested bytes before asking for exact creative review.
begin;

-- The original single-file attestation retained the digest but not the object
-- identity it was read from. Keep that identity for subsequent declarations.
create table public.generated_creative_storage_attestations_v8 (
  asset_id uuid primary key references public.client_media_assets(id) on delete cascade,
  storage_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes bigint not null check (file_bytes>0),
  object_id uuid not null,
  object_version text,
  object_updated_at timestamptz not null,
  attested_at timestamptz not null default clock_timestamp()
);
alter table public.generated_creative_storage_attestations_v8 enable row level security;
revoke all on public.generated_creative_storage_attestations_v8
  from public,anon,authenticated,service_role;

create or replace function public.attest_creative_storage_bytes_v6(
  p_asset_id uuid,p_storage_path text,p_sha256 text,p_file_bytes bigint,
  p_object_id uuid,p_object_version text,p_object_updated_at timestamptz)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare a public.client_media_assets%rowtype;
  o storage.objects%rowtype;
begin
  if auth.role()<>'service_role' then
    raise exception 'Only the trusted verifier may attest creative bytes.'
      using errcode='42501'; end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' or p_file_bytes is null or p_file_bytes<=0 then
    raise exception 'A nonempty file and SHA-256 digest are required.'
      using errcode='23514'; end if;
  select * into a from public.client_media_assets where id=p_asset_id for update;
  if a.id is null or p_storage_path is distinct from
    coalesce(nullif(btrim(a.render_path),''),a.storage_path) then
    raise exception 'Asset path changed during verification.' using errcode='23514'; end if;
  select * into o from storage.objects
    where bucket_id='client-media' and name=p_storage_path;
  if o.id is null or o.id is distinct from p_object_id
    or o.version is distinct from p_object_version
    or o.updated_at is distinct from p_object_updated_at then
    raise exception 'Creative Storage object changed during verification.'
      using errcode='23514'; end if;
  update public.client_media_assets set delivery_bytes_sha256=p_sha256
    where id=a.id;
  insert into public.generated_creative_storage_attestations_v8
    (asset_id,storage_path,sha256,file_bytes,object_id,object_version,object_updated_at)
  values(a.id,p_storage_path,p_sha256,p_file_bytes,o.id,o.version,o.updated_at)
  on conflict(asset_id) do update set
    storage_path=excluded.storage_path,sha256=excluded.sha256,
    file_bytes=excluded.file_bytes,object_id=excluded.object_id,
    object_version=excluded.object_version,
    object_updated_at=excluded.object_updated_at,attested_at=clock_timestamp();
  perform public.refresh_delivery_entity_v6('content_asset',a.id::text,a.client_id);
  return a.id;
end $$;

create table public.generated_creative_rights_declarations_v8 (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.client_media_assets(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  usage_rights text not null check (usage_rights in ('client_owned','licensed','agency_owned')),
  basis text not null check (length(btrim(basis)) between 20 and 1000),
  declared_by uuid not null references public.profiles(id),
  declared_at timestamptz not null default clock_timestamp(),
  foreign key(asset_id,client_id) references public.client_media_assets(id,client_id)
);
create index generated_creative_rights_asset_latest_v8
  on public.generated_creative_rights_declarations_v8(asset_id,declared_at desc,id desc);
alter table public.generated_creative_rights_declarations_v8 enable row level security;
create policy generated_creative_rights_read_v8
  on public.generated_creative_rights_declarations_v8 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.generated_creative_rights_declarations_v8
  from public,anon,authenticated,service_role;
grant select on public.generated_creative_rights_declarations_v8
  to authenticated,service_role;
create trigger generated_creative_rights_immutable_v8
  before update or delete on public.generated_creative_rights_declarations_v8
  for each row execute function public.reject_approval_ledger_mutation_v6();

create function public.generated_creative_rights_source_hash_v8(p_asset_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public,storage as $$
declare a public.client_media_assets%rowtype;
  o storage.objects%rowtype;
  v_attestation public.generated_creative_storage_attestations_v8%rowtype;
  v_frames jsonb;
begin
  select * into a from public.client_media_assets where id=p_asset_id;
  if a.id is null or auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(a.client_id))
    or a.media_type not in ('image','text')
    or a.content_format not in ('single','carousel','story')
    or a.render_path is not null or a.delivery_bytes_sha256 is null
    or a.archived_at is not null then return null; end if;
  select * into o from storage.objects
    where bucket_id='client-media' and name=a.storage_path;
  if o.id is null then return null; end if;
  select * into v_attestation from public.generated_creative_storage_attestations_v8
    where asset_id=a.id;
  if v_attestation.asset_id is null
    or v_attestation.storage_path is distinct from a.storage_path
    or v_attestation.sha256 is distinct from a.delivery_bytes_sha256
    or v_attestation.object_id is distinct from o.id
    or v_attestation.object_version is distinct from o.version
    or v_attestation.object_updated_at is distinct from o.updated_at then
    return null; end if;
  if a.content_format in ('carousel','story') then
    if not public.framed_creative_evidence_current_v8(a.id) then return null; end if;
    select jsonb_agg(jsonb_build_object(
      'frame_id',f.id,'position',f.position,'path',f.storage_path,
      'caption',f.caption,'sha256',b.sha256,'bytes',b.file_bytes,
      'object_id',b.object_id,'object_version',b.object_version,
      'object_updated_at',b.object_updated_at) order by f.position)
      into v_frames
    from public.client_media_frames f
    join public.creative_frame_bytes_v8 b on b.frame_id=f.id and b.asset_id=a.id
    where f.asset_id=a.id;
  end if;
  return encode(sha256(convert_to(jsonb_build_object(
    'asset_id',a.id,'client_id',a.client_id,'storage_path',a.storage_path,
    'file_sha256',a.delivery_bytes_sha256,'object_id',o.id,
    'object_version',o.version,'object_updated_at',o.updated_at,
    'file_bytes',v_attestation.file_bytes,
    'frames',v_frames)::text,'UTF8')),'hex');
end $$;
revoke all on function public.generated_creative_rights_source_hash_v8(uuid)
  from public,anon,authenticated;
grant execute on function public.generated_creative_rights_source_hash_v8(uuid)
  to authenticated,service_role;

create function public.declare_generated_creative_rights_v8(
  p_asset_id uuid,p_rights text,p_basis text
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage set timezone='UTC' as $$
declare a public.client_media_assets%rowtype;
  v_hash text; v_id uuid;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must declare creative rights.' using errcode='42501';
  end if;
  select * into a from public.client_media_assets where id=p_asset_id for update;
  if a.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(a.client_id),false)) then
    raise exception 'Only the client manager or admin may declare creative rights.' using errcode='42501';
  end if;
  if p_rights not in ('client_owned','licensed','agency_owned')
    or length(btrim(coalesce(p_basis,''))) not between 20 and 1000 then
    raise exception 'Choose a rights category and record its evidence in 20–1000 characters.'
      using errcode='23514';
  end if;
  if a.review_status<>'pending' or a.human_approved_at is not null
    or not exists(select 1 from public.creative_renders r
      where r.asset_id=a.id and r.status='done') then
    raise exception 'Only a pending, completed generated creative may receive this declaration.'
      using errcode='23514';
  end if;
  v_hash:=public.generated_creative_rights_source_hash_v8(a.id);
  if v_hash is null then
    raise exception 'Attest the current stored file and every frame before declaring rights.'
      using errcode='23514';
  end if;
  insert into public.generated_creative_rights_declarations_v8
    (asset_id,client_id,source_hash,file_sha256,usage_rights,basis,declared_by)
  values(a.id,a.client_id,v_hash,a.delivery_bytes_sha256,p_rights,btrim(p_basis),auth.uid())
  returning id into v_id;
  update public.client_media_assets set usage_rights=p_rights where id=a.id;
  return v_id;
end $$;
revoke all on function public.declare_generated_creative_rights_v8(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.declare_generated_creative_rights_v8(uuid,text,text)
  to authenticated;

alter table public.ordinary_media_review_requests_v6
  add column rights_declaration_id uuid
    references public.generated_creative_rights_declarations_v8(id);
create function public.bind_generated_creative_rights_review_v8()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare a public.client_media_assets%rowtype;
  d public.generated_creative_rights_declarations_v8%rowtype;
begin
  select * into a from public.client_media_assets
    where id=new.asset_id and client_id=new.client_id;
  if a.id is null then return new; end if;
  if not exists(select 1 from public.creative_renders r
      where r.asset_id=a.id) then return new; end if;
  select * into d from public.generated_creative_rights_declarations_v8
    where asset_id=a.id and client_id=a.client_id
    order by declared_at desc,id desc limit 1;
  if d.id is null or d.source_hash is distinct from
      public.generated_creative_rights_source_hash_v8(a.id)
    or d.usage_rights is distinct from a.usage_rights
    or d.file_sha256 is distinct from a.delivery_bytes_sha256 then
    raise exception 'Declare rights for the current generated file before review.'
      using errcode='23514';
  end if;
  new.rights_declaration_id:=d.id;
  return new;
end $$;
create trigger ordinary_media_generated_rights_v8
  before insert on public.ordinary_media_review_requests_v6
  for each row execute function public.bind_generated_creative_rights_review_v8();
create function public.guard_generated_rights_review_binding_v8()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if new.rights_declaration_id is distinct from old.rights_declaration_id then
    raise exception 'The reviewed rights declaration cannot change.' using errcode='42501';
  end if;
  return new;
end $$;
create trigger ordinary_media_rights_binding_immutable_v8
  before update of rights_declaration_id on public.ordinary_media_review_requests_v6
  for each row execute function public.guard_generated_rights_review_binding_v8();

-- Preserve the exact old preview for historical requests with no declaration.
-- New requests freeze the human basis alongside rights, bytes and destination.
create or replace function public.ordinary_media_review_preview_v6(
  p_review public.ordinary_media_review_requests_v6
) returns jsonb language sql stable security definer
set search_path=pg_catalog,public,storage as $$
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
    || case when a.content_format in ('carousel','story') then jsonb_build_object(
      'consequence','Human source approval of every ordered frame; publication requires a separate destination decision',
      'frames',(select jsonb_agg(jsonb_build_object(
        'frame_id',f.id,'position',f.position,'caption',f.caption,
        'storage_path',f.storage_path,'file_sha256',b.sha256,
        'file_bytes',b.file_bytes,'object_id',o_frame.id,
        'object_version',o_frame.version,'object_updated_at',o_frame.updated_at)
        order by f.position)
        from public.client_media_frames f
        left join public.creative_frame_bytes_v8 b on b.frame_id=f.id and b.asset_id=a.id
        left join storage.objects o_frame on o_frame.bucket_id='client-media'
          and o_frame.name=f.storage_path
        where f.asset_id=a.id))
      else '{}'::jsonb end
    || case when d.id is not null then jsonb_build_object('rights_declaration',
      jsonb_build_object('id',d.id,'usage_rights',d.usage_rights,
        'basis',d.basis,'declared_by',d.declared_by,'declared_at',d.declared_at,
        'source_hash',d.source_hash)) else '{}'::jsonb end
  from public.client_media_assets a
  join storage.objects o on o.bucket_id='client-media'
    and o.name=coalesce(nullif(btrim(a.render_path),''),a.storage_path)
  left join public.generated_creative_rights_declarations_v8 d
    on d.id=p_review.rights_declaration_id and d.asset_id=a.id
  where a.id=p_review.asset_id and a.client_id=p_review.client_id
    and (a.content_format='single' or a.render_path is null);
$$;

revoke all on function public.bind_generated_creative_rights_review_v8()
  from public,anon,authenticated,service_role;
revoke all on function public.guard_generated_rights_review_binding_v8()
  from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
