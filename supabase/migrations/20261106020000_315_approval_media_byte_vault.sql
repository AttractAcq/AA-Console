-- Phase D / 315: a private immutable byte vault for future media decisions.
-- This migration grants no media approval or distribution authority. A later
-- source adapter must capture and verify the bytes, attach them to an exact
-- approval entry, and make every consumer read the frozen version.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('approval-review-media', 'approval-review-media', false, 524288000, null)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from storage.buckets
      where id = 'approval-review-media' and name = 'approval-review-media'
        and public = false) then
    raise exception 'The approval review media bucket must be private.'
      using errcode = '23514';
  end if;
end;
$$;

-- Keep the review vault private after creation. A later storage configuration
-- change must not turn its frozen bytes into public assets.
create function public.guard_approval_review_bucket_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if old.id = 'approval-review-media' then
    raise exception 'The approval review media bucket is immutable.'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger approval_review_media_bucket_immutable_v6
  before update or delete on storage.buckets
  for each row execute function public.guard_approval_review_bucket_v6();
revoke all on function public.guard_approval_review_bucket_v6()
  from public, anon, authenticated, service_role;

-- No authenticated storage policy is granted for this bucket. Only the
-- trusted service role may put objects in it. Even that role cannot replace
-- or delete a vault object after insertion.
create function public.guard_approval_review_media_immutable_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if old.bucket_id = 'approval-review-media' then
    raise exception 'Frozen approval media cannot be changed or deleted.'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger approval_review_media_objects_immutable_v6
  before update or delete on storage.objects
  for each row execute function public.guard_approval_review_media_immutable_v6();
revoke all on function public.guard_approval_review_media_immutable_v6()
  from public, anon, authenticated, service_role;

-- A storage path and metadata alone are not trusted media bytes. The runtime
-- must hash downloaded bytes, copy them into the vault without upsert, and
-- record the vault object id and hash here. This row is an inventory of that
-- capture, not approval evidence until the owning source rechecks it.
create table public.media_approval_byte_snapshots_v6 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  asset_id uuid not null references public.client_media_assets(id) on delete restrict,
  source_path text not null,
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'
    and source_snapshot <> '{}'::jsonb),
  frozen_path text not null unique,
  frozen_object_id uuid not null unique,
  byte_sha256 text not null check (byte_sha256 ~ '^[0-9a-f]{64}$'),
  byte_count bigint not null check (byte_count > 0),
  captured_at timestamptz not null default now(),
  check (source_path like client_id::text || '/%'),
  check (frozen_path like client_id::text || '/' || byte_sha256 || '/%')
);
create index media_approval_byte_snapshots_v6_asset_idx
  on public.media_approval_byte_snapshots_v6 (asset_id, captured_at desc);
create function public.verify_media_approval_byte_snapshot_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.client_media_assets a
      where a.id = new.asset_id and a.client_id = new.client_id)
    or not exists (select 1 from storage.objects o
      where o.id = new.frozen_object_id
        and o.bucket_id = 'approval-review-media'
        and o.name = new.frozen_path) then
    raise exception 'Media capture does not match the client asset and frozen object.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger media_approval_byte_snapshots_v6_verify
  before insert on public.media_approval_byte_snapshots_v6
  for each row execute function public.verify_media_approval_byte_snapshot_v6();
revoke all on function public.verify_media_approval_byte_snapshot_v6()
  from public, anon, authenticated, service_role;
create trigger media_approval_byte_snapshots_v6_append_only
  before update or delete on public.media_approval_byte_snapshots_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger media_approval_byte_snapshots_v6_no_truncate
  before truncate on public.media_approval_byte_snapshots_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
alter table public.media_approval_byte_snapshots_v6 enable row level security;
create policy media_approval_byte_snapshots_v6_scoped_read
  on public.media_approval_byte_snapshots_v6 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.media_approval_byte_snapshots_v6
  from public, anon, authenticated, service_role;
grant select on public.media_approval_byte_snapshots_v6
  to authenticated, service_role;
grant insert on public.media_approval_byte_snapshots_v6 to service_role;

comment on table public.media_approval_byte_snapshots_v6 is
  'Append-only inventory of trusted runtime byte captures. The vault alone does not authorize a media decision or external distribution.';

select public.lock_down_definer_functions();
