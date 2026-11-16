-- A completed MP4 cannot enter content approval before exact cut acceptance.
begin;
do $checks$
declare
  c public.clients%rowtype;
  p public.motion_design_projects%rowtype;
  m public.client_media_assets%rowtype;
  refused boolean := false;
begin
  insert into public.clients(name,initials)
    values('Motion attachment fixture','MA') returning * into c;
  insert into public.motion_design_projects
    (client_id,prompt,preset,aspect,duration_sec,brand_mode,status,render_path)
    values(c.id,'A completed but unreviewed motion design','explainer',
      'horizontal',8,'on_brand','completed',c.id::text||'/motion.mp4')
    returning * into p;
  insert into public.client_media_assets
    (client_id,media_type,content_format,storage_path,render_path)
    values(c.id,'video','single',p.render_path,p.render_path)
    returning * into m;
  begin
    insert into public.motion_design_attachments
      (project_id,asset_id,destination)
      values(p.id,m.id,'standalone');
  exception when others then refused:=true; end;
  if not refused or exists(select 1 from public.motion_design_attachments
      where project_id=p.id) then
    raise exception 'Unaccepted motion cut entered content approvals';
  end if;
end $checks$;
rollback;
