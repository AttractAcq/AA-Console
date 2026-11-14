-- Rollback-only proof that a blocked Engine preview cannot schedule a slot.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','engine-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','engine-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Engine hold fixture','EH');
insert into public.client_media_assets
  (id,client_id,media_type,content_format,title,storage_path,usage_rights)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','image','single','Engine image',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/engine.png','agency_owned');
insert into public.content_slots
  (id,client_id,platform,scheduled_at,stage,asset_id)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','instagram',now()+interval '2 days',
  'awaiting_approval','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
insert into public.slot_events(slot_id,from_stage,to_stage,actor)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','qa','awaiting_approval','engine');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare v_request uuid;
begin
  select id into v_request from public.approval_requests_v6
    where source_kind='engine_slot'
      and source_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  if v_request is null or (select preview_blocker from public.approval_inbox_v6
    where id=v_request) is null then
    raise exception 'The blocked Engine source preview was not registered';
  end if;
  begin
    perform public.advance_slot(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd','scheduled','human');
    raise exception 'AAL1 scheduled an Engine slot';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.advance_slot(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd','scheduled','human');
    raise exception 'Engine slot scheduled without exact Inbox decision';
  exception when check_violation then
    if SQLERRM not like '%exact Engine media, copy or destination%' then raise; end if;
  end;
  if (select stage::text from public.content_slots
    where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd') <> 'awaiting_approval'
    or exists(select 1 from public.slot_events where slot_id=
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd' and to_stage::text='scheduled') then
    raise exception 'A refused schedule changed the slot';
  end if;
end $checks$;
rollback;
