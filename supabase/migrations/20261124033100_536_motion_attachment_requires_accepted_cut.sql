-- Motion Design remains a producer in the current client navigation. Its
-- attachment is a pending content asset, and must come from the exact cut
-- accepted through the Motion Render Inbox rather than any completed MP4.
create function public.guard_motion_attachment_v7() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.motion_design_projects%rowtype;
  m public.client_media_assets%rowtype;
begin
  select * into p from public.motion_design_projects where id=new.project_id;
  select * into m from public.client_media_assets where id=new.asset_id;
  if not found or p.id is null or p.status<>'completed'
     or m.client_id<>p.client_id or m.media_type<>'video'
     or m.review_status<>'pending'
     or m.render_path is distinct from p.render_path
     or m.storage_path is distinct from p.render_path
     or m.brief_id is distinct from new.brief_id
     or not exists (
       select 1 from public.motion_render_candidates c
       where c.project_id=p.id and c.client_id=p.client_id
         and c.render_path=p.render_path
         and c.brand_qa='pass' and c.claim_qa='pass'
         and c.accepted_at is not null
         and c.accepted_request_id is not null
         and c.accepted_content_hash is not null
     ) then
    raise exception 'Accept the exact motion cut in Approval Inbox before attaching it to content.'
      using errcode='42501';
  end if;
  return new;
end $$;
create trigger motion_attachment_accepted_cut_v7
  before insert or update on public.motion_design_attachments
  for each row execute function public.guard_motion_attachment_v7();
revoke all on function public.guard_motion_attachment_v7()
  from public,anon,authenticated,service_role;

comment on function public.guard_motion_attachment_v7() is
  'A completed project may enter Content Production only as an exact accepted render candidate. Attachment still creates a pending asset and never approves distribution.';
