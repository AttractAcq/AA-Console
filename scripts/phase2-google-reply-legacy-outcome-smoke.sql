-- Rollback-only historical-state projection: never turn old status into proof.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','legacy-reply-audit@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','legacy-reply-audit@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Legacy reply audit fixture','LR');
insert into public.client_google_locations(id,client_id,location_ref,title,verification_state)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'accounts/test_account/locations/test_location','Fixture location','verified');
insert into public.google_reviews(id,client_id,location_id,review_ref,author_name,star_rating,comment)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc','review_1','Customer',5,'Helpful service'),
 ('ffffffff-ffff-4fff-8fff-ffffffffffff','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc','review_2','Customer',5,'Helpful service');
insert into public.google_review_replies(id,client_id,review_id,body,body_hash)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd','Thank you',
 encode(sha256(convert_to('Thank you','UTF8')),'hex')),
 ('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'ffffffff-ffff-4fff-8fff-ffffffffffff','Thanks again',
 encode(sha256(convert_to('Thanks again','UTF8')),'hex'));
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $audit$
declare cid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 reply_id uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 legacy_id uuid:='11111111-1111-4111-8111-111111111111';
 card public.approval_requests_v6%rowtype;
 claim jsonb; v_attempt uuid; v_key uuid;
begin
 select * into card from public.approval_requests_v6
  where source_kind='google_review_reply' and source_id=reply_id::text;
 perform public.decide_google_review_reply_from_inbox_v6(reply_id,
  card.source_version,card.artifact_hash,true,null);
 select * into card from public.approval_requests_v6
  where source_kind='google_review_reply' and source_id=legacy_id::text;
 perform public.decide_google_review_reply_from_inbox_v6(legacy_id,
  card.source_version,card.artifact_hash,true,null);
 perform set_config('request.jwt.claim.role','service_role',true);
 claim:=public.claim_google_reply_execution_v6(reply_id);
 v_attempt:=(claim->>'attempt_id')::uuid;
 v_key:=(claim->>'claim_key')::uuid;
 if v_attempt is null or not public.begin_google_reply_write_v6(v_attempt,v_key) then
  raise exception 'Exact old reply attempt was not prepared'; end if;
 if not public.finish_google_reply_execution_v6(v_attempt,v_key,
  'uncertain',null,null,null,'Historical response lost') then
  raise exception 'Historical uncertain attempt missing'; end if;
 -- Simulate records written before the APPROVED moderation guard existed.
 execute 'alter table public.google_reply_execution_attempts_v6 disable trigger google_reply_confirmed_moderation_v6';
 execute 'alter table public.google_review_replies disable trigger google_reply_inbox_status_guard_v6';
 update public.google_reply_execution_attempts_v6 a
  set status='confirmed',observed_body_hash=a.body_hash,provider_state='PENDING'
  where a.id=(claim->>'attempt_id')::uuid;
 update public.google_review_replies g
  set status='posted',posted_at=clock_timestamp(),
   external_ref='accounts/test_account/locations/test_location/reviews/review_1'
  where g.id=reply_id;
 update public.google_review_replies g
  set status='posted',posted_at=clock_timestamp(),
   external_ref='accounts/test_account/locations/test_location/reviews/review_2'
  where g.id=legacy_id;
 execute 'alter table public.google_review_replies enable trigger google_reply_inbox_status_guard_v6';
 execute 'alter table public.google_reply_execution_attempts_v6 enable trigger google_reply_confirmed_moderation_v6';
 perform set_config('request.jwt.claim.role','authenticated',true);
 if (select o.outcome from public.client_external_outcomes_v6 o
  where o.outcome_id=(claim->>'attempt_id')::uuid) is distinct from 'unverified'
  or (select o.external_ref from public.client_external_outcomes_v6 o
   where o.outcome_id=(claim->>'attempt_id')::uuid) is not null then
  raise exception 'Historical pending moderation was shown as confirmed'; end if;
 if (select o.outcome from public.client_external_outcomes_v6 o
  where o.outcome_id=legacy_id and o.client_id=cid) is distinct from 'unverified'
  or (select o.external_ref from public.client_external_outcomes_v6 o
   where o.outcome_id=legacy_id and o.client_id=cid) is not null then
  raise exception 'Historical posted status without attempt was shown as receipt'; end if;
end $audit$;
rollback;
