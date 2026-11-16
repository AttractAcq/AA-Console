-- Rollback-only client SMM and creative-director seat governance.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','seat-admin@example.invalid','',now(),now()),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','00000000-0000-0000-0000-000000000000','authenticated','authenticated','seat-smm@example.invalid','',now(),now()),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000','authenticated','authenticated','seat-editor@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','seat-admin@example.invalid'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','employee','seat-smm@example.invalid'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','employee','seat-editor@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Seat fixture','SF');
insert into public.team_members(id,user_id,category,name,initials)
values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','smm','Fixture SMM','FS');
insert into public.team_members(id,user_id,category,name,initials)
values('ffffffff-ffff-4fff-8fff-ffffffffffff',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc','editors','Fixture editor','FE');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare cid uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 mid uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 request_id uuid; review_id uuid; first_assignment uuid; second_assignment uuid;
begin
 begin
  insert into public.client_assignments(member_id,client_id) values(mid,cid);
  raise exception 'Direct SMM assignment succeeded';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_client_authority_assignment_v6(mid,cid,'assign');
 select id into review_id from public.client_authority_assignment_reviews_v6
  where canonical_request_id=request_id;
 if public.request_client_authority_assignment_v6(mid,cid,'assign')<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending'
  then raise exception 'Seat assignment was not pending and deduplicated'; end if;
 begin
  perform public.decide_client_authority_assignment_v6(review_id,request_id,true);
  raise exception 'AAL1 assigned a client approval seat';
 exception when insufficient_privilege then null; end;
 update public.team_members set name='Changed SMM' where id=mid;
 update public.team_members set name='Fixture SMM' where id=mid;
 if public.client_authority_assignment_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted member identity revived the old request'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_client_authority_assignment_v6(review_id,request_id,true);
  raise exception 'Stale seat request was approved';
 exception when check_violation then null; end;
 request_id:=public.request_client_authority_assignment_v6(mid,cid,'assign');
 select id into review_id from public.client_authority_assignment_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_client_authority_assignment_v6(review_id,request_id,true);
 select id into first_assignment from public.client_assignments
  where member_id=mid and client_id=cid and ended_at is null;
 if first_assignment is null or
  (select status from public.approval_inbox_v6 where id=request_id)<>'approved' then
  raise exception 'Reviewed assignment did not create the seat'; end if;
 begin
  update public.client_assignments set ended_at=now() where id=first_assignment;
  raise exception 'Direct seat ending succeeded';
 exception when insufficient_privilege then null; end;
 begin
  update public.client_assignments set member_id='ffffffff-ffff-4fff-8fff-ffffffffffff'
   where id=first_assignment;
  raise exception 'Moving an SMM row to a non-authority member succeeded';
 exception when insufficient_privilege then null; end;
 begin
  update public.team_members set category='editors' where id=mid;
  raise exception 'Category bypass succeeded';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_client_authority_assignment_v6(mid,cid,'end');
 select id into review_id from public.client_authority_assignment_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_client_authority_assignment_v6(review_id,request_id,true);
 if (select ended_at from public.client_assignments where id=first_assignment) is null
  or (select status from public.approval_inbox_v6 where id=request_id)<>'approved' then
  raise exception 'Reviewed ending did not close the seat'; end if;
 request_id:=public.request_client_authority_assignment_v6(mid,cid,'assign');
 select id into review_id from public.client_authority_assignment_reviews_v6
  where canonical_request_id=request_id;
 perform public.decide_client_authority_assignment_v6(review_id,request_id,true);
 select id into second_assignment from public.client_assignments
  where member_id=mid and client_id=cid and ended_at is null;
 if second_assignment is null or second_assignment=first_assignment
  or (select count(*) from public.client_assignments where member_id=mid and client_id=cid)<>2
  then raise exception 'Reassignment did not preserve the old period'; end if;
end $checks$;
rollback;
