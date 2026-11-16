-- Rollback-only exact creative-director requirement changes in both directions.
begin;
-- Exercise creative-requirement invalidation against legacy seat changes;
-- direct-write protection is covered by the authority-assignment fixture.
alter table public.client_assignments disable trigger client_authority_assignment_guard_v6;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','creative-admin@example.invalid','',now(),now()),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','00000000-0000-0000-0000-000000000000','authenticated','authenticated','creative-director@example.invalid','',now(),now()),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000','authenticated','authenticated','second-director@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','creative-admin@example.invalid'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','employee','creative-director@example.invalid'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','employee','second-director@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Creative requirement fixture','CR');
insert into public.client_engine_settings(client_id) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare cid uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 request_id uuid; review_id uuid;
begin
 begin
  perform public.request_creative_requirement_v6(cid,true);
  raise exception 'Enabled a requirement without an assigned director';
 exception when check_violation then null; end;
 insert into public.team_members(id,user_id,category,name,initials)
 values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','creative_director','Fixture director','FD');
 insert into public.client_assignments(member_id,client_id)
 values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',cid);
 begin
  update public.client_engine_settings set creative_director_required=true where client_id=cid;
  raise exception 'Direct requirement enable succeeded';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_creative_requirement_v6(cid,true);
 select id into review_id from public.creative_requirement_reviews_v6
  where canonical_request_id=request_id;
 if public.request_creative_requirement_v6(cid,true)<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending'
  then raise exception 'Creative requirement request was not pending and deduplicated'; end if;
 begin
  perform public.decide_creative_requirement_v6(review_id,request_id,true);
  raise exception 'AAL1 changed creative authority';
 exception when insufficient_privilege then null; end;
 update public.client_assignments set ended_at=now()
  where member_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 update public.client_assignments set ended_at=null
  where member_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 if public.creative_requirement_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted seat assignment revived old authority review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_creative_requirement_v6(review_id,request_id,true);
  raise exception 'Stale authority review changed the requirement';
 exception when check_violation then null; end;
 request_id:=public.request_creative_requirement_v6(cid,true);
 select id into review_id from public.creative_requirement_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_creative_requirement_v6(review_id,request_id,true);
 if not (select creative_director_required from public.client_engine_settings where client_id=cid)
  or (select status from public.approval_inbox_v6 where id=request_id)<>'approved'
  then raise exception 'Exact review did not require the director'; end if;
 begin
  update public.client_engine_settings set creative_director_required=false where client_id=cid;
  raise exception 'Direct requirement removal succeeded';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_creative_requirement_v6(cid,false);
 select id into review_id from public.creative_requirement_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_creative_requirement_v6(review_id,request_id,true);
 if (select creative_director_required from public.client_engine_settings where client_id=cid)
  or (select status from public.approval_inbox_v6 where id=request_id)<>'approved'
  then raise exception 'Exact review did not remove the requirement'; end if;
 insert into public.team_members(id,user_id,category,name,initials)
 values('ffffffff-ffff-4fff-8fff-ffffffffffff',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc','creative_director','Second director','SD');
 insert into public.client_assignments(member_id,client_id,created_at)
 values('ffffffff-ffff-4fff-8fff-ffffffffffff',cid,now()+interval '1 second');
 update public.profiles set role='admin' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 perform set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
 perform set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","aal":"aal2"}',true);
 request_id:=public.request_creative_requirement_v6(cid,true);
 select id into review_id from public.creative_requirement_reviews_v6
  where canonical_request_id=request_id;
 begin
  perform public.decide_creative_requirement_v6(review_id,request_id,true);
  raise exception 'Assigned creative director approved their own authority';
 exception when insufficient_privilege then null; end;
end $checks$;
rollback;
