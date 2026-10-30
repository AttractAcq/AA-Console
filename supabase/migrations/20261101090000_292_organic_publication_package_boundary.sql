-- B011 / 292: exact outgoing organic packages are captured, but no package
-- can yet be approved or sent. The old Engine decision approves an asset and
-- a slot, not the final bytes, words, account, time and rights. A current
-- source row or human_approved_at is never publication authority.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('publication-media', 'publication-media', false, 524288000, null)
on conflict (id) do nothing;

-- Only the trusted runtime can upload. No authenticated policy grants read,
-- update or delete. This trigger also prevents a service-role upsert from
-- replacing bytes after a human has inspected a content-addressed path.
create function public.guard_publication_media_immutable_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if old.bucket_id = 'publication-media' then
    raise exception 'Frozen publication media cannot be changed or deleted.'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger publication_media_objects_immutable_v6
  before update or delete on storage.objects
  for each row execute function public.guard_publication_media_immutable_v6();
revoke all on function public.guard_publication_media_immutable_v6()
  from public, anon, authenticated, service_role;

create table public.organic_publication_packages_v6 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  scheduled_post_id uuid not null references public.scheduled_posts(id) on delete restrict,
  slot_id uuid not null references public.content_slots(id) on delete restrict,
  source_snapshot_hash text not null check (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  artifact_hash text not null check (artifact_hash ~ '^[0-9a-f]{64}$'),
  registered_at timestamptz not null default now(),
  unique (scheduled_post_id, source_snapshot_hash),
  unique (scheduled_post_id, artifact_hash)
);
create index organic_publication_packages_v6_client_idx
  on public.organic_publication_packages_v6 (client_id, registered_at desc);
create trigger organic_publication_packages_v6_append_only
  before update or delete on public.organic_publication_packages_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger organic_publication_packages_v6_no_truncate
  before truncate on public.organic_publication_packages_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
alter table public.organic_publication_packages_v6 enable row level security;
create policy organic_publication_packages_v6_scoped_read
  on public.organic_publication_packages_v6 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.organic_publication_packages_v6
  from public, anon, authenticated, service_role;
grant select on public.organic_publication_packages_v6
  to authenticated, service_role;

-- This is the database portion of the package. The runtime adds verified
-- downloaded-byte digests and private frozen object paths. All fields the
-- current provider request may use are named, including the raw copy whose
-- composition the runtime will later have to re-check before each write.
create function public.organic_publication_source_snapshot_v6(p_post_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_post public.scheduled_posts%rowtype;
  v_slot public.content_slots%rowtype;
  v_asset public.client_media_assets%rowtype;
  v_brief public.client_briefs%rowtype;
  v_idea public.client_ideas%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_copy public.post_copy_effective%rowtype;
  v_provider text;
  v_account text;
  v_account_count integer;
  v_paths jsonb;
begin
  select * into v_post from public.scheduled_posts where id = p_post_id;
  if not found or v_post.client_id is null or v_post.asset_id is null
    or v_post.platform is null or v_post.scheduled_at is null
    or v_post.channel is distinct from 'organic'::public.post_channel
    or v_post.publication_status <> 'scheduled' or v_post.published_at is not null
    then return null; end if;
  select * into v_asset from public.client_media_assets
    where id = v_post.asset_id and client_id = v_post.client_id;
  if not found or v_asset.review_status is distinct from 'approved'::public.review_status
    or v_asset.human_approved_at is null
    or v_asset.content_format is null
    or v_post.media_type is distinct from v_asset.media_type then return null; end if;
  select * into v_brief from public.client_briefs
    where id = v_asset.brief_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_idea from public.client_ideas
    where id = v_brief.source_idea_id and client_id = v_post.client_id;
  if not found then return null; end if;
  select * into v_campaign from public.client_campaigns
    where id = v_idea.campaign_id and client_id = v_post.client_id;
  if not found or v_campaign.acquisition_mode is distinct from 'organic'
    or v_campaign.paid_platform is not null then return null; end if;
  if (select count(*) from public.content_slots
      where scheduled_post_id = v_post.id) <> 1 then return null; end if;
  select * into v_slot from public.content_slots
    where scheduled_post_id = v_post.id;
  if v_slot.stage is distinct from 'scheduled'::public.slot_stage
    or (v_slot.client_id, v_slot.asset_id, v_slot.brief_id,
        v_slot.idea_id, v_slot.platform, v_slot.scheduled_at)
       is distinct from
       (v_post.client_id, v_asset.id, v_brief.id,
        v_idea.id, v_post.platform, v_post.scheduled_at)
    then return null; end if;
  select * into v_copy from public.post_copy_effective
    where scheduled_post_id = v_post.id and platform = v_post.platform;
  if not found or nullif(btrim(coalesce(v_copy.caption, '')), '') is null
    then return null; end if;
  select provider into v_provider from public.platform_publishing
    where platform = v_post.platform and supported;
  if v_provider is null or v_provider not in ('instagram','meta')
    then return null; end if;
  if not exists (select 1 from public.platform_format_publishing pfp
      where pfp.platform = v_post.platform
        and pfp.content_format = v_asset.content_format
        and (pfp.media_type = v_post.media_type or pfp.media_type is null)
        and pfp.supported) then return null; end if;
  select count(*)::integer,
         max(case when v_provider = 'instagram' then credential_label
                  else meta_page_id end)
    into v_account_count, v_account
    from public.client_integrations
   where client_id = v_post.client_id and provider = v_provider
     and status = 'connected' and credential_secret_id is not null;
  if v_account_count <> 1 or nullif(btrim(v_account), '') is null
    or not coalesce(public.integration_usable(v_post.client_id, v_provider), false)
    then return null; end if;
  if v_asset.content_format in ('carousel','story') then
    if exists (select 1 from public.client_media_frames f
      where f.asset_id = v_asset.id and
        (f.storage_path is null
         or f.storage_path not like v_post.client_id::text || '/%'
         or position('..' in f.storage_path) > 0)) then return null; end if;
    select coalesce(jsonb_agg(f.storage_path order by f.position), '[]'::jsonb)
      into v_paths from public.client_media_frames f where f.asset_id = v_asset.id;
    if jsonb_array_length(v_paths) < (case when v_asset.content_format = 'carousel' then 2 else 1 end)
      or jsonb_array_length(v_paths) > 10 then return null; end if;
  else
    if nullif(btrim(coalesce(v_asset.render_path, v_asset.storage_path)), '') is null
      or coalesce(v_asset.render_path, v_asset.storage_path)
        not like v_post.client_id::text || '/%'
      or position('..' in coalesce(v_asset.render_path, v_asset.storage_path)) > 0
      then return null; end if;
    v_paths := jsonb_build_array(coalesce(v_asset.render_path, v_asset.storage_path));
  end if;
  return jsonb_build_object(
    'client_id',v_post.client_id,'scheduled_post_id',v_post.id,
    'slot_id',v_slot.id,'campaign_id',v_campaign.id,
    'idea_id',v_idea.id,'brief_id',v_brief.id,'asset_id',v_asset.id,
    'platform',v_post.platform,'provider',v_provider,
    'account_ref',v_account,'scheduled_at',v_post.scheduled_at,
    'content_format',v_asset.content_format,'media_type',v_post.media_type,
    'source_paths',v_paths,
    'copy',jsonb_build_object(
      'caption',v_copy.caption,'hashtags',v_copy.hashtags,
      'alt_text',v_copy.alt_text,'link_url',v_copy.link_url,
      'first_comment',v_copy.first_comment),
    'rights',jsonb_build_object(
      'usage_rights',v_asset.usage_rights,
      'intake_source',v_asset.intake_source,
      'asset_human_approved_at',v_asset.human_approved_at));
end;
$$;
revoke all on function public.organic_publication_source_snapshot_v6(uuid)
  from public, anon, authenticated, service_role;

-- A service-role worker may discover work without acquiring publication
-- authority. Repeated sweeps skip a frozen package for the same DB snapshot.
create function public.organic_publication_package_candidates_v6(p_limit integer default 5)
returns table (post_id uuid, client_id uuid, platform text, copy jsonb,
  source_paths jsonb, source_snapshot_hash text)
language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the publication packager may read candidates.' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Choose between 1 and 50 candidates.' using errcode = '22023';
  end if;
  return query
  select s.id, s.client_id, snapshot.payload->>'platform',
         snapshot.payload->'copy', snapshot.payload->'source_paths',
         encode(sha256(convert_to(snapshot.payload::text, 'UTF8')), 'hex')
    from public.scheduled_posts s
    cross join lateral (select public.organic_publication_source_snapshot_v6(s.id) payload) snapshot
   where snapshot.payload is not null
     and not exists (
       select 1 from public.organic_publication_packages_v6 p
        where p.scheduled_post_id = s.id
          and p.source_snapshot_hash =
            encode(sha256(convert_to(snapshot.payload::text, 'UTF8')), 'hex'))
   order by s.scheduled_at, s.id limit p_limit;
end;
$$;
revoke all on function public.organic_publication_package_candidates_v6(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.organic_publication_package_candidates_v6(integer)
  to service_role;

insert into public.agents
  (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values (
  'organic_package_builder', 'Organic package builder', 'OP', 'content',
  'Copies approved Engine media into an immutable private byte-addressed location and registers a held exact outgoing package. It cannot publish.',
  array[]::text[], false)
on conflict (agent_key) do nothing;

create function public.enqueue_organic_package_sweep_v6()
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare v_job uuid;
begin
  if exists (select 1 from public.agent_jobs
      where agent_key = 'organic_package_builder'
        and status in ('queued','claimed','running')) then return null; end if;
  if not exists (
    select 1 from public.scheduled_posts s
    cross join lateral (select public.organic_publication_source_snapshot_v6(s.id) payload) src
    where s.publication_status = 'scheduled' and s.published_at is null
      and src.payload is not null
      and not exists (select 1 from public.organic_publication_packages_v6 p
        where p.scheduled_post_id = s.id
          and p.source_snapshot_hash =
            encode(sha256(convert_to(src.payload::text, 'UTF8')), 'hex'))
  ) then return null; end if;
  insert into public.agent_jobs (agent_key, params)
    values ('organic_package_builder', jsonb_build_object('limit',5))
    returning id into v_job;
  return v_job;
end;
$$;
revoke all on function public.enqueue_organic_package_sweep_v6()
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_organic_package_sweep_v6()
  to service_role;
select cron.unschedule('organic-package-sweep-v6')
where exists (select 1 from cron.job where jobname = 'organic-package-sweep-v6');
select cron.schedule('organic-package-sweep-v6','*/10 * * * *',
  $cron$select public.enqueue_organic_package_sweep_v6();$cron$);

create function public.register_organic_publication_package_v6(
  p_post_id uuid, p_expected_source_hash text, p_media jsonb,
  p_provider_copy jsonb
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_snapshot jsonb;
  v_source_hash text;
  v_manifest jsonb;
  v_hash text;
  v_id uuid;
  v_existing public.organic_publication_packages_v6%rowtype;
  v_item jsonb;
  v_index integer;
  v_expected_path text;
  v_client_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the trusted packager may register media bytes.' using errcode = '42501';
  end if;
  if p_media is null or jsonb_typeof(p_media) <> 'array'
    or jsonb_array_length(p_media) = 0 or jsonb_array_length(p_media) > 10 then
    raise exception 'An ordered media-byte manifest is required.' using errcode = '22023';
  end if;
  if p_provider_copy is null or jsonb_typeof(p_provider_copy) <> 'object'
    or nullif(btrim(p_provider_copy->>'caption'), '') is null
    or not (p_provider_copy ? 'first_comment')
    or (p_provider_copy->'first_comment') <> 'null'::jsonb
       and jsonb_typeof(p_provider_copy->'first_comment') <> 'string' then
    raise exception 'The exact provider caption and first comment are required.' using errcode = '22023';
  end if;
  -- This row lock serializes same-post registration and conflicts with a
  -- concurrent schedule edit. Other live source fields are re-read below.
  perform 1 from public.scheduled_posts where id = p_post_id for update;
  if not found then raise exception 'Scheduled post not found.' using errcode = 'P0002'; end if;
  v_snapshot := public.organic_publication_source_snapshot_v6(p_post_id);
  if v_snapshot is null then
    raise exception 'The post lacks a verified organic slot, copy or account.' using errcode = '23514';
  end if;
  v_source_hash := encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex');
  if p_expected_source_hash is distinct from v_source_hash then
    raise exception 'The publication source changed while media was archived.' using errcode = '23514';
  end if;
  v_client_id := (v_snapshot->>'client_id')::uuid;
  if jsonb_array_length(p_media) <> jsonb_array_length(v_snapshot->'source_paths') then
    raise exception 'The archived media count differs from the post.' using errcode = '23514';
  end if;
  for v_item,v_index in
    select value, (ordinality - 1)::integer from jsonb_array_elements(p_media) with ordinality
  loop
    v_expected_path := v_snapshot->'source_paths'->>v_index;
    if jsonb_typeof(v_item) <> 'object'
      or v_expected_path not like v_client_id::text || '/%'
      or v_item->>'source_path' is distinct from v_expected_path
      or coalesce(v_item->>'sha256','') !~ '^[0-9a-f]{64}$'
      or v_item->>'frozen_bucket' is distinct from 'publication-media'
      or v_item->>'frozen_path' is distinct from
        (v_client_id::text || '/' || (v_item->>'sha256'))
      or coalesce(v_item->>'mime_type','') !~ '^[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+$'
      or coalesce(v_item->>'byte_size','') !~ '^[1-9][0-9]*$'
      or (v_item->>'byte_size')::bigint > 524288000
      or not exists (select 1 from storage.objects o
           where o.bucket_id = 'publication-media'
             and o.name = v_item->>'frozen_path') then
      raise exception 'The frozen media evidence is incomplete or mismatched.' using errcode = '23514';
    end if;
  end loop;
  v_manifest := v_snapshot || jsonb_build_object(
    'media',p_media,'provider_copy',p_provider_copy);
  v_hash := encode(sha256(convert_to(v_manifest::text, 'UTF8')), 'hex');
  select * into v_existing from public.organic_publication_packages_v6
    where scheduled_post_id = p_post_id and source_snapshot_hash = v_source_hash;
  if found then
    if v_existing.artifact_hash = v_hash and v_existing.manifest = v_manifest
      then return v_existing.id; end if;
    raise exception 'This source version already has different frozen bytes.' using errcode = '23505';
  end if;
  insert into public.organic_publication_packages_v6
    (client_id,scheduled_post_id,slot_id,source_snapshot_hash,manifest,artifact_hash)
  values (v_client_id,p_post_id,(v_snapshot->>'slot_id')::uuid,
    v_source_hash,v_manifest,v_hash) returning id into v_id;
  perform public.register_approval_request_v6(jsonb_build_object(
    'client_id',v_client_id,'source_system','aa_console',
    'source_kind','organic_publication','source_id',v_id::text,
    'source_version',v_hash,'title','Organic publication: ' ||
      (v_snapshot->>'platform') || ' · ' || p_post_id::text,
    'artifact_hash',v_hash,'preview',v_manifest,
    'destination','organic:' || (v_snapshot->>'platform'),
    'account_ref',v_snapshot->>'account_ref',
    'scope',jsonb_build_object('client_id',v_client_id,
      'scheduled_post_id',p_post_id,'slot_id',v_snapshot->>'slot_id',
      'source_snapshot_hash',v_source_hash),
    'owner_role','client_media_reviewer','requester_kind','service',
    'requester_ref','organic_publication_packages_v6:' || v_id::text,
    -- A post may be due already or scheduled more than seven days ahead.
    -- Keep its held evidence visible through the planned send window.
    'expires_at',greatest((v_snapshot->>'scheduled_at')::timestamptz
      + interval '1 day', now() + interval '7 days'),
    'preview_blocker',
      'Media bytes are frozen, but rights provenance and the exact AAL2 publication decision and provider prewrite attestation are not yet connected.',
    'owning_path','/clients/' || v_client_id::text ||
      '/delivery/approval-inbox?tab=engine'));
  return v_id;
end;
$$;
revoke all on function public.register_organic_publication_package_v6(uuid,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.register_organic_publication_package_v6(uuid,text,jsonb,jsonb)
  to service_role;

-- Reconcile the held Inbox card against its immutable package and the live
-- Engine source. This exposes stale or missing packages without granting a
-- decision. The publication object remains frozen even if the mutable
-- authoring source later changes.
create function public.organic_publication_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_package public.organic_publication_packages_v6%rowtype;
  v_live jsonb;
  v_live_hash text;
begin
  select * into v_request from public.approval_requests_v6 where id = p_request_id;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'organic_publication' then
    return 'unverified';
  end if;
  if auth.role() is distinct from 'service_role'
    and (auth.role() is distinct from 'authenticated'
      or not public.can_review_approval_request_v6(
        v_request.client_id, v_request.owner_role)) then
    return 'unverified';
  end if;
  if v_request.source_id !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into v_package from public.organic_publication_packages_v6
    where id = v_request.source_id::uuid;
  if not found then return 'cancelled'; end if;
  if v_request.client_id is distinct from v_package.client_id
    or v_request.owner_role is distinct from 'client_media_reviewer'
    or v_request.requester_kind is distinct from 'service'
    or v_request.requester_ref is distinct from
      ('organic_publication_packages_v6:' || v_package.id::text)
    or v_request.source_version is distinct from v_package.artifact_hash
    or v_request.artifact_hash is distinct from v_package.artifact_hash
    or v_request.preview is distinct from v_package.manifest
    or v_request.destination is distinct from
      ('organic:' || (v_package.manifest->>'platform'))
    or v_request.account_ref is distinct from
      (v_package.manifest->>'account_ref')
    or v_request.scope is distinct from jsonb_build_object(
      'client_id',v_package.client_id,
      'scheduled_post_id',v_package.scheduled_post_id,
      'slot_id',v_package.slot_id,
      'source_snapshot_hash',v_package.source_snapshot_hash) then
    return 'superseded';
  end if;
  v_live := public.organic_publication_source_snapshot_v6(
    v_package.scheduled_post_id);
  if v_live is null then return 'superseded'; end if;
  v_live_hash := encode(sha256(convert_to(v_live::text, 'UTF8')), 'hex');
  if v_live_hash is distinct from v_package.source_snapshot_hash
    then return 'superseded'; end if;
  return 'source_held';
end;
$$;
revoke all on function public.organic_publication_source_state_v6(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.organic_publication_source_state_v6(uuid)
  to authenticated, service_role;

-- This worker gate is deliberately closed until a later migration binds a
-- source-owned AAL2 decision, exact prewrite claim and publication receipt.
-- Its presence gives the runtime a named fail-closed check before credentials
-- or provider calls, including a direct legacy job or stale service-role row.
create function public.require_organic_publication_prewrite_v6(p_post_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the publisher may verify publication authority.' using errcode = '42501';
  end if;
  raise exception 'Organic publication requires an exact Inbox decision and byte-bound prewrite gate.'
    using errcode = '42501';
end;
$$;
revoke all on function public.require_organic_publication_prewrite_v6(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.require_organic_publication_prewrite_v6(uuid)
  to service_role;

-- Preserve the existing 287 blocker order. A valid slot is lineage, not
-- publication permission. Add this stop before any client switch can expose
-- a null blocker; publish_due remains the Console's explanation of why a
-- post is held, while claim consumes only null-blocker rows.
create or replace view public.publish_due with (security_invoker = true) as
select
  sp.id as post_id, sp.client_id, c.name as client_name, sp.platform,
  sp.scheduled_at, sp.media_type, sp.publication_status,
  sp.publish_attempts, sp.publish_claimed_at,
  a.id as asset_id, a.title as asset_title,
  coalesce(a.render_path, a.storage_path) as media_path,
  a.human_approved_at, pce.caption, pce.hashtags, pce.alt_text,
  pce.link_url, pce.first_comment, pp.provider,
  pp.supported as platform_supported,
  case
    when sp.asset_id is null or a.id is null then 'The asset is gone. This post can never be published.'
    when sp.client_id is null or a.client_id is distinct from sp.client_id
      then 'The scheduled post and asset belong to different clients.'
    when sp.channel is distinct from 'organic'::public.post_channel
      then 'Paid posts use the Ads Studio route, not the organic publisher.'
    when b.id is null or b.client_id is distinct from sp.client_id
      then 'The asset has no verified brief for this client.'
    when i.id is null or i.client_id is distinct from sp.client_id
      then 'The brief has no verified campaign idea for this client.'
    when ca.id is null or ca.client_id is distinct from sp.client_id
      then 'The idea has no verified campaign for this client.'
    when ca.acquisition_mode = 'paid'
      then 'This asset belongs to a paid campaign and cannot use organic publishing.'
    when ca.acquisition_mode is distinct from 'organic' or ca.paid_platform is not null
      then 'This campaign has no explicit organic publishing route.'
    when coalesce(sr.slot_count, 0) = 0
      then 'This calendar entry has no approved Engine slot. An exact-version publication approval must be connected through Approval Inbox before it can publish.'
    when sr.slot_count <> 1 or not coalesce(sr.matches, false)
      then 'The Engine slot and asset campaign lineage do not match this post.'
    when a.review_status is distinct from 'approved'::public.review_status
      then 'The asset approval was revoked.'
    when a.human_approved_at is null then 'Nobody has approved the asset.'
    when sp.platform is null then 'The post has no platform.'
    when pp.platform is null or not pp.supported
      then 'There is no adapter for ' || coalesce(sp.platform::text, 'this platform') || '.'
    when pfp.platform is not null and not pfp.supported and pfp.media_type is not null
      then 'A ' || a.content_format::text || ' made of ' || sp.media_type::text
           || ' cannot be sent to ' || sp.platform::text || ' yet.'
    when pfp.platform is null or not pfp.supported
      then 'A ' || a.content_format::text || ' cannot be sent to ' || sp.platform::text
           || ' yet. Publishing it now would post the first frame on its own and record it as published.'
    when a.content_format = 'carousel' and coalesce(fr.frames, 0) < 2
      then 'A carousel needs at least two frames. This one has '
           || coalesce(fr.frames, 0)::text || ' on file.'
    when a.content_format = 'carousel' and fr.frames > 10
      then 'This carousel has ' || fr.frames::text || ' frames. Ten is the most either platform takes.'
    when a.content_format = 'story' and coalesce(fr.frames, 0) < 1
      then 'This story has no frames on file.'
    when not coalesce(ces.publishing_enabled, false)
      then 'Publishing is off for this client.'
    when not public.integration_usable(sp.client_id, pp.provider)
      then 'No usable ' || pp.provider || ' integration for this client.'
    when pce.caption is null or btrim(pce.caption) = ''
      then 'There is no caption for ' || sp.platform::text || '.'
    when sp.scheduled_at > now() then 'Not due yet.'
    when not exists (select 1 from public.organic_publication_packages_v6 p
      where p.scheduled_post_id = sp.id)
      then 'No immutable outgoing media-byte package exists for this post. Approval Inbox must review the exact destination, account, copy, time and rights.'
    else 'The immutable outgoing package is held until its exact AAL2 Inbox decision and provider prewrite checks are connected.'
  end as blocker,
  a.content_format, coalesce(pfp.supported, false) as format_supported
from public.scheduled_posts sp
left join public.clients c on c.id = sp.client_id
left join public.client_media_assets a on a.id = sp.asset_id
left join public.client_briefs b on b.id = a.brief_id
left join public.client_ideas i on i.id = b.source_idea_id
left join public.client_campaigns ca on ca.id = i.campaign_id
left join lateral (
  select count(*)::int as slot_count,
         bool_and(s.stage = 'scheduled' and s.client_id = sp.client_id
           and s.asset_id = sp.asset_id and s.brief_id = b.id
           and s.idea_id = i.id and s.platform = sp.platform
           and s.scheduled_at = sp.scheduled_at) as matches
    from public.content_slots s where s.scheduled_post_id = sp.id
) sr on true
left join public.client_engine_settings ces on ces.client_id = sp.client_id
left join public.platform_publishing pp on pp.platform = sp.platform
left join lateral (
  select x.platform, x.supported, x.media_type
    from public.platform_format_publishing x
   where x.platform = sp.platform and x.content_format = a.content_format
     and (x.media_type is null or x.media_type = sp.media_type)
   order by x.media_type nulls last limit 1
) pfp on true
left join lateral (
  select count(*)::int as frames from public.client_media_frames f
   where f.asset_id = a.id
) fr on true
left join public.post_copy_effective pce
  on pce.scheduled_post_id = sp.id and pce.platform = sp.platform
where sp.publication_status in ('scheduled','publishing')
  and sp.published_at is null;
comment on view public.publish_due is
  'Organic publication is held at the exact outgoing package boundary. Legacy Engine approval and matching lineage alone cannot authorize an external write.';
grant select on public.publish_due to authenticated;

-- The 287 claim already requires `publish_due.blocker is null`. Make the
-- invariant explicit as defense in depth against a future view regression:
-- a later migration must replace this function as part of activating the
-- exact AAL2 prewrite contract. Historical rows are preserved, not claimed.
create or replace function public.claim_posts_for_publishing(p_limit integer default 5)
returns table (post_id uuid, client_id uuid, platform public.post_platform,
  provider text, media_type public.media_type, media_path text, asset_id uuid,
  caption text, hashtags text[], alt_text text, link_url text,
  first_comment text, scheduled_at timestamptz, attempt integer,
  content_format public.content_format, frame_paths text[])
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Posts are claimed by the publisher.' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Claim between 1 and 50 posts at a time.' using errcode = '22023';
  end if;
  return;
end;
$$;
revoke all on function public.claim_posts_for_publishing(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_posts_for_publishing(integer)
  to service_role;

-- Preserve the 290 Inbox column contract and existing source adapters, while
-- making this held organic class visible and dynamically stale-aware.
create or replace view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when r.source_system = 'aa_console'
      and r.source_kind in ('production_release', 'recruitment_meta_build', 'organic_publication')
      and s.source_state = 'source_held'
      and r.expires_at is not null and r.expires_at <= now() then 'expired'
    when s.source_state in ('cancelled','superseded','source_held','unverified')
      then s.source_state
    when d.decision = 'revoked' then 'revoked'
    when d.decision = 'rejected' then 'rejected'
    when r.expires_at is not null and r.expires_at <= now() then 'expired'
    when d.decision = 'approved' then 'approved'
    when s.source_state <> 'pending' then s.source_state
    else 'pending'
  end as status,
  r.requested_at, r.requested_by, r.requester_kind, r.requester_ref,
  r.expires_at,
  coalesce(e.artifact_hash, r.artifact_hash) as artifact_hash,
  coalesce(e.preview, r.preview) as preview,
  coalesce(e.destination, r.destination) as destination,
  coalesce(e.account_ref, r.account_ref) as account_ref,
  coalesce(e.budget, r.budget) as budget,
  coalesce(e.scope, r.scope) as scope,
  r.owner_role,
  case
    when r.source_system = 'aa_console'
      and r.source_kind = 'production_release' then coalesce(
        nullif(btrim(r.preview_blocker), ''),
        'Release source and external effects are not independently attested.')
    when r.source_system = 'aa_console'
      and r.source_kind = 'recruitment_meta_build' then coalesce(
        nullif(btrim(r.preview_blocker), ''),
        'Recruitment Meta creation still lacks exact media bytes and an AAL2 prewrite gate.')
    when r.source_system = 'aa_console'
      and r.source_kind = 'organic_publication' then coalesce(
        nullif(btrim(r.preview_blocker), ''),
        'Organic publication lacks rights provenance, exact AAL2 approval and prewrite attestation.')
    when r.expires_at is null then 'An expiry is missing.'
    when nullif(btrim(coalesce(r.owner_role, '')), '') is null then 'The decision owner is missing.'
    when e.id is not null then null
    when nullif(btrim(coalesce(r.preview_blocker, '')), '') is not null then r.preview_blocker
    when r.artifact_hash is null then 'The exact artifact hash is missing.'
    when r.preview is null or jsonb_typeof(r.preview) <> 'object'
      or r.preview = '{}'::jsonb then 'The exact artifact preview is missing.'
    when r.scope is null or r.scope = '{}'::jsonb then 'The exact scope is missing.'
    else null
  end as preview_blocker,
  r.owning_path,
  s.source_state
from public.approval_requests_v6 r
left join public.approval_request_evidence_v6 e on e.request_id = r.id
left join lateral (
  select de.decision from public.approval_decision_events_v6 de
  where de.request_id = r.id
  order by de.event_order desc limit 1
) d on true
cross join lateral (
  select case
    when r.source_system = 'aa_console' and r.source_kind = 'production_release'
      then public.production_release_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'recruitment_meta_build'
      then public.recruitment_meta_build_source_state_v6(r.id)
    when r.source_system = 'aa_console' and r.source_kind = 'organic_publication'
      then public.organic_publication_source_state_v6(r.id)
    else public.approval_source_state_v6(r.id)
  end as source_state
) s;
revoke all on public.approval_inbox_v6 from public, anon, authenticated, service_role;
grant select on public.approval_inbox_v6 to authenticated, service_role;

insert into public.approval_class_coverage_versions_v6 (
  class_id, revision, class_key, title, source_state, source_evidence,
  decision_state, decision_evidence, executor_state, executor_evidence, blocker
) values (
  1, 2, 'engine_slot', 'Engine slot release',
  'blocked', '292 frozen media-byte package and source-held Inbox card',
  'missing', null, 'missing', null,
  'Rights provenance, source-owned AAL2 exact outgoing decision and provider prewrite attestation are absent.'
);

select public.lock_down_definer_functions();
