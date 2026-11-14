-- Rollback-only exact Google reply decision and prewrite fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','google-reply-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','google-reply-admin@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Google reply fixture','GR');
insert into public.client_google_locations(id,client_id,location_ref,title,verification_state)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'accounts/test_account/locations/test_location','Fixture location','verified');
insert into public.google_reviews(id,client_id,location_id,review_ref,author_name,star_rating,comment)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc','review_1','Customer',5,'Helpful service');
insert into public.google_review_replies(id,client_id,review_id,body,body_hash)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd','Thank you',
 encode(sha256(convert_to('Thank you','UTF8')),'hex'));
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $decision$
declare r public.approval_requests_v6%rowtype;
begin
 select * into r from public.approval_requests_v6
  where source_kind='google_review_reply'
    and source_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 if r.id is null then raise exception 'Exact Google reply card missing'; end if;
 if public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Human role passed service-only prewrite'; end if;
 perform public.decide_google_review_reply_from_inbox_v6(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',r.source_version,r.artifact_hash,true,null);
end $decision$;
select set_config('request.jwt.claim.role','service_role',true);
do $checks$
begin
 if not public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Current exact reply decision was not eligible'; end if;
 update public.google_reviews set comment='Changed review'
  where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 if public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Changed review kept the old reply approval'; end if;
 update public.google_reviews set comment='Helpful service'
  where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 if public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Edited-and-reverted review revived old approval'; end if;
 update public.client_google_locations set verification_state='suspended'
  where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 if public.google_reply_prewrite_current_v6('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') then
  raise exception 'Suspended location passed prewrite'; end if;
end $checks$;
rollback;
