-- A path names a storage object, but it is not a fingerprint of its bytes.
-- Existing assets remain unverified until a trusted worker hashes the file.
alter table public.client_media_assets
  add column delivery_bytes_sha256 text
  check (delivery_bytes_sha256 is null
    or delivery_bytes_sha256 ~ '^[0-9a-f]{64}$');

create function public.guard_delivery_asset_bytes_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  if new.storage_path is distinct from old.storage_path
     or to_jsonb(new)->>'render_path' is distinct from
       to_jsonb(old)->>'render_path' then
    new.delivery_bytes_sha256 := null;
    return new;
  end if;
  if new.delivery_bytes_sha256 is not null
     and new.delivery_bytes_sha256 is distinct from old.delivery_bytes_sha256
     and auth.role() is distinct from 'service_role' then
    raise exception 'Only a trusted asset worker may register byte evidence.'
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger client_media_assets_delivery_bytes_v6
  before update on public.client_media_assets
  for each row execute function public.guard_delivery_asset_bytes_v6();

create function public.register_delivery_asset_bytes_v6(
  p_asset_id uuid, p_storage_path text, p_sha256 text
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  a public.client_media_assets%rowtype;
  v_expected_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted asset worker is required.' using errcode = '42501';
  end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 digest of the exact file bytes is required.';
  end if;
  select * into a from public.client_media_assets
    where id = p_asset_id for update;
  if not found then raise exception 'Asset not found.'; end if;
  v_expected_path := coalesce(to_jsonb(a)->>'render_path', a.storage_path);
  if p_storage_path is distinct from v_expected_path then
    raise exception 'Digest path does not match the current asset render.';
  end if;
  update public.client_media_assets
    set delivery_bytes_sha256 = p_sha256 where id = a.id;
  return public.refresh_delivery_entity_v6('content_asset', a.id::text, a.client_id);
end $$;
revoke all on function public.register_delivery_asset_bytes_v6(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.register_delivery_asset_bytes_v6(uuid,text,text)
  to service_role;

-- The new work contract can only claim reviewable creative when a trusted
-- byte hash has been registered for the exact asset version it references.
create function public.guard_delivery_asset_output_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
declare v_digest text;
begin
  if tg_op = 'INSERT' and exists (
    select 1 from public.delivery_entity_versions_v6 e
    where e.id = new.entity_version_id and e.entity_kind = 'content_asset'
  ) then
    select a.delivery_bytes_sha256 into v_digest
    from public.delivery_entity_versions_v6 e
    join public.client_media_assets a on a.id::text = e.source_key
      and a.client_id = e.client_id
    join public.delivery_entity_heads_v6 h
      on h.client_id = e.client_id and h.entity_kind = e.entity_kind
        and h.source_key = e.source_key and h.entity_version_id = e.id
    where e.id = new.entity_version_id;
    if v_digest is null then
      raise exception 'Content output needs an exact byte SHA-256 before review.';
    end if;
  end if;
  return new;
end $$;
create trigger delivery_work_outputs_v6_asset_bytes
  before insert on public.delivery_work_outputs_v6
  for each row execute function public.guard_delivery_asset_output_v6();

-- When the action card names a known destination or exact artifact digest,
-- bind those source versions as well as its campaign and offer. This covers
-- existing cards and new cards; unknown payloads remain for the source
-- adapter to bind with bind_delivery_approval_dependency_v6.
create function public.bind_delivery_campaign_action_media_v6(
  p_request_id uuid
) returns void language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  r public.approval_requests_v6%rowtype;
  a public.campaign_action_approvals%rowtype;
begin
  select * into r from public.approval_requests_v6
    where id = p_request_id and source_kind = 'campaign_action';
  if r.id is null then return; end if;
  select * into a from public.campaign_action_approvals
    where id::text = r.source_id and client_id = r.client_id;
  if a.id is null then return; end if;
  insert into public.delivery_approval_dependencies_v6 (
    approval_request_id, entity_version_id, client_id
  )
  select r.id, h.entity_version_id, r.client_id
  from public.delivery_entity_heads_v6 h
  where h.client_id = r.client_id and (
    (h.entity_kind = 'destination' and h.source_key in (
      r.client_id::text || ':' || a.destination,
      r.client_id::text || ':' || (a.scope->>'destination_key')))
    or (h.entity_kind = 'proof_artifact' and exists (
      select 1 from public.proof_artifact_versions v
      where v.id::text = h.source_key and v.client_id = r.client_id
        and v.content_hash = a.artifact_version_hash))
    or (h.entity_kind = 'proof_source' and exists (
      select 1 from public.proof_artifact_versions v
      where v.client_id = r.client_id and v.content_hash = a.artifact_version_hash
        and v.source_proof_id::text = h.source_key))
    or (h.entity_kind = 'content_asset' and exists (
      select 1 from public.client_media_assets m
      where m.id::text = h.source_key and m.client_id = r.client_id
        and m.delivery_bytes_sha256 = a.artifact_version_hash))
  ) on conflict do nothing;
end $$;
create function public.bind_delivery_campaign_action_media_trigger_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  perform public.bind_delivery_campaign_action_media_v6(new.id);
  return null;
end $$;
create trigger approval_campaign_media_v6
  after insert on public.approval_requests_v6
  for each row when (new.source_kind = 'campaign_action')
  execute function public.bind_delivery_campaign_action_media_trigger_v6();
do $$ declare r record;
begin
  for r in select id from public.approval_requests_v6
    where source_kind = 'campaign_action' and client_id is not null loop
    perform public.bind_delivery_campaign_action_media_v6(r.id);
  end loop;
end $$;
revoke all on function public.bind_delivery_campaign_action_media_v6(uuid)
  from public, anon, authenticated, service_role;

select public.lock_down_definer_functions();
