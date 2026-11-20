-- New video attachments require the filed, byte-verified thumbnail from the
-- same first-aspect candidate. Existing historical attachments remain readable
-- with a null thumbnail reference and are not retroactively claimed complete.
alter table public.video_project_attachments_v1
  add column thumbnail_attempt_id uuid
    references public.video_project_thumbnail_attempts_v1(id);

create function public.video_attachment_thumbnail_guard_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public,storage as $$
declare t public.video_project_thumbnail_attempts_v1%rowtype;
  o storage.objects%rowtype;
begin
  select * into t from public.video_project_thumbnail_attempts_v1
    where project_id=new.project_id and ir_version=new.ir_version
      and first_candidate_id=new.first_candidate_id;
  select * into o from storage.objects
    where bucket_id='client-media' and name=t.storage_path;
  if t.id is null or t.client_id is distinct from new.client_id
    or t.state is distinct from 'filed'
    or t.file_sha256 !~ '^[0-9a-f]{64}$'
    or t.file_bytes not between 101 and 8388608
    or t.storage_path is distinct from
      (t.client_id::text||'/video/projects/'||t.project_id::text||
        '/ir-v'||t.ir_version::text||'/thumbnail-'||t.id::text||
        '-'||t.file_sha256||'.jpg')
    or o.id is null or o.id is distinct from t.object_id
    or o.version is distinct from t.object_version
    or o.updated_at is distinct from t.object_updated_at
    or (new.thumbnail_attempt_id is not null
      and new.thumbnail_attempt_id is distinct from t.id) then
    raise exception 'Video attachment requires its exact filed thumbnail.'
      using errcode='23514'; end if;
  new.thumbnail_attempt_id:=t.id;
  return new;
end $$;
revoke all on function public.video_attachment_thumbnail_guard_v1()
  from public,anon,authenticated,service_role;
create trigger video_attachment_thumbnail_guard_v1
  before insert on public.video_project_attachments_v1 for each row
  execute function public.video_attachment_thumbnail_guard_v1();

create function public.video_attachment_thumbnail_immutable_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if new.thumbnail_attempt_id is distinct from old.thumbnail_attempt_id then
    raise exception 'Attached video thumbnail lineage is immutable.'
      using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.video_attachment_thumbnail_immutable_v1()
  from public,anon,authenticated,service_role;
create trigger video_attachment_thumbnail_immutable_v1
  before update on public.video_project_attachments_v1 for each row
  execute function public.video_attachment_thumbnail_immutable_v1();

comment on column public.video_project_attachments_v1.thumbnail_attempt_id is
  'Filed 1280x720 thumbnail receipt required for new attachments. Null on legacy attachments means thumbnail evidence is unknown.';
