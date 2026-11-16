-- Keep approved-but-stale single-file creative visible to operators while
-- showing that its historic timestamp is not current signoff authority.
begin;
create view public.ordinary_media_current_status_v6
with (security_invoker=true) as
select a.client_id,a.id as asset_id,
  public.ordinary_media_signoff_current_v6(a.id) as current_signoff
from public.client_media_assets a
where a.media_type in ('image','text')
  and a.content_format='single' and a.render_path is null
  and a.review_status='approved' and a.human_approved_at is not null;
revoke all on public.ordinary_media_current_status_v6
  from public,anon,authenticated,service_role;
grant select on public.ordinary_media_current_status_v6
  to authenticated,service_role;
commit;
