-- A manually archived idea can have no brief, and an archived asset can
-- belong to a brief that is still active. Neither appears in content_archive,
-- which deliberately lists completed brief chains only. Keep these records
-- discoverable and restorable without changing the chain view's contract.
create view public.content_archive_unlinked
with (security_invoker = on)
as
select
  i.id,
  i.client_id,
  'idea'::text as record_kind,
  null::text as reference,
  i.title,
  i.media_type::text as media_type,
  i.status::text as status,
  i.archived_at,
  i.body as detail,
  null::uuid as brief_id
from public.client_ideas i
where i.archived_at is not null
  and not exists (
    select 1 from public.client_briefs b where b.source_idea_id = i.id
  )
union all
select
  a.id,
  a.client_id,
  'asset'::text as record_kind,
  a.ref_number as reference,
  a.title,
  a.media_type::text as media_type,
  a.review_status::text as status,
  a.archived_at,
  null::text as detail,
  a.brief_id
from public.client_media_assets a
left join public.client_briefs b on b.id = a.brief_id
where a.archived_at is not null
  and a.purpose = 'client'
  and (b.id is null or b.archived_at is null);

comment on view public.content_archive_unlinked is
  'Archived client ideas without a brief and archived client assets whose brief is still active or absent. The complete brief chain remains in content_archive.';
grant select on public.content_archive_unlinked to authenticated;
