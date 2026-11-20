begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('ab000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','archive-loose-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('ab000000-0000-4000-8000-000000000002','admin','archive-loose-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('ab000000-0000-4000-8000-000000000001','Archive loose fixture','AL');
do $checks$
declare
  cid uuid := 'ab000000-0000-4000-8000-000000000001';
  loose_idea uuid;
  linked_idea uuid;
  active_brief uuid;
  archived_brief uuid;
  loose_asset uuid;
  linked_asset uuid;
begin
  insert into public.client_ideas(client_id,title,body,source,archived_at)
    values(cid,'Archived before briefing','Original idea retained','manual',now())
    returning id into loose_idea;
  insert into public.client_ideas(client_id,title,source)
    values(cid,'Linked idea','manual') returning id into linked_idea;
  insert into public.client_briefs(client_id,source_idea_id,title)
    values(cid,linked_idea,'Still active brief') returning id into active_brief;
  insert into public.client_briefs(client_id,title,archived_at)
    values(cid,'Finished brief',now()) returning id into archived_brief;
  insert into public.client_media_assets(client_id,brief_id,title,media_type,storage_path,archived_at)
    values(cid,active_brief,'Archived alternative','image','fixture/alternative.png',now())
    returning id into loose_asset;
  insert into public.client_media_assets(client_id,brief_id,title,media_type,storage_path,archived_at)
    values(cid,archived_brief,'Archived in chain','image','fixture/finished.png',now())
    returning id into linked_asset;
  -- Asset creation normally archives its brief. Restore this brief to model
  -- a manually archived asset inside an otherwise active production chain.
  update public.client_briefs set archived_at=null where id=active_brief;

  if (select count(*) from public.content_archive_unlinked where client_id=cid) <> 2 then
    raise exception 'An archived content record is missing or duplicated';
  end if;
  if not exists(select 1 from public.content_archive_unlinked
                where id=loose_idea and record_kind='idea'
                  and detail='Original idea retained')
     or not exists(select 1 from public.content_archive_unlinked
                   where id=loose_asset and record_kind='asset' and brief_id=active_brief)
     or exists(select 1 from public.content_archive_unlinked
               where id in (linked_idea,linked_asset)) then
    raise exception 'Loose archive and completed chain overlap';
  end if;
  if not exists(select 1 from public.content_archive where brief_id=archived_brief) then
    raise exception 'Completed chain disappeared from its archive';
  end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000002',true);
  perform set_config('request.jwt.claims',
    '{"sub":"ab000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}',true);
  perform public.set_content_archived_v6('idea',loose_idea,false);
  perform public.set_content_archived_v6('asset',loose_asset,false);
  if exists(select 1 from public.content_archive_unlinked where client_id=cid)
     or (select archived_at from public.client_ideas where id=loose_idea) is not null
     or (select archived_at from public.client_media_assets where id=loose_asset) is not null then
    raise exception 'Restored content remained archived';
  end if;
end $checks$;
insert into public.clients(id,name,initials) values
  ('ab000000-0000-4000-8000-000000000003','Other archive loose fixture','OL');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('ab000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','archive-loose-client@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('ab000000-0000-4000-8000-000000000004','client','archive-loose-client@example.invalid');
insert into public.client_users(client_id,user_id) values
  ('ab000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000004');
insert into public.client_ideas(client_id,title,source,archived_at) values
  ('ab000000-0000-4000-8000-000000000001','Visible to assigned client','manual',now()),
  ('ab000000-0000-4000-8000-000000000003','Hidden from assigned client','manual',now());
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000004',true);
select set_config('request.jwt.claims',
  '{"sub":"ab000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
set local role authenticated;
do $scope$
begin
  if (select count(*) from public.content_archive_unlinked) <> 1
     or not exists(select 1 from public.content_archive_unlinked
                   where title='Visible to assigned client')
     or exists(select 1 from public.content_archive_unlinked
               where title='Hidden from assigned client') then
    raise exception 'Unlinked archive leaked another client or hid own records';
  end if;
end $scope$;
rollback;
