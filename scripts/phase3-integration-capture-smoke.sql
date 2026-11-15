-- Rollback-only source and removal checks for Google review integration capture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','review-capture-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','review-capture-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Review capture fixture','RC');
insert into public.client_google_locations(id,client_id,location_ref,title)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'accounts/test/locations/test','Test location');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare review_id uuid; proof_id uuid; proof public.client_proof_assets%rowtype;
  rights_request_id uuid;
begin
  insert into public.google_reviews(client_id,location_id,review_ref,comment,review_url,reviewed_at)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'good','A dated review','https://example.invalid/review/good',now()) returning id into review_id;
  proof_id:=public.capture_google_review_as_proof_v6(review_id);
  select * into proof from public.client_proof_assets where id=proof_id;
  if proof.source<>'https://example.invalid/review/good' or proof.usage_rights<>'not_cleared'
    or proof.capture_method<>'integration' or proof.source_kind<>'Online Reviews'
    or proof.captured_on is null then raise exception 'Captured proof lost source or rights hold'; end if;
  rights_request_id:=public.request_proof_rights_v6(proof_id,'Owner permission confirmed');
  if public.proof_rights_source_state_v6(rights_request_id)<>'pending' then
    raise exception 'Current review was not reviewable for rights'; end if;
  update public.google_reviews set gone_at=now() where id=review_id;
  select * into proof from public.client_proof_assets where id=proof_id;
  if proof.google_source_changed_at is null or
    public.proof_rights_source_state_v6(rights_request_id)='pending' then
    raise exception 'Removed review did not invalidate pending rights'; end if;
  if public.capture_google_review_as_proof_v6(review_id)<>proof_id then
    raise exception 'Historical capture retry was not idempotent'; end if;

  insert into public.google_reviews(client_id,location_id,review_ref,comment,review_url,reviewed_at)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'edited','Original words','https://example.invalid/review/edited',now()) returning id into review_id;
  proof_id:=public.capture_google_review_as_proof_v6(review_id);
  rights_request_id:=public.request_proof_rights_v6(proof_id,'Owner permission confirmed');
  update public.google_reviews set comment='Changed words' where id=review_id;
  select * into proof from public.client_proof_assets where id=proof_id;
  if proof.body<>'Original words' or proof.google_source_changed_at is null
    or public.proof_rights_source_state_v6(rights_request_id)='pending' then
    raise exception 'Edited review silently changed proof or kept its old rights request'; end if;

  insert into public.google_reviews(client_id,location_id,review_ref,comment,review_url,reviewed_at,gone_at)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'gone','Removed review','https://example.invalid/review/gone',now(),now()) returning id into review_id;
  begin
    perform public.capture_google_review_as_proof_v6(review_id);
    raise exception 'Removed review was captured' using errcode='XX000';
  exception when sqlstate 'P0001' then null; end;

  insert into public.google_reviews(client_id,location_id,review_ref,comment,reviewed_at)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'no-url','Unsourced review',now()) returning id into review_id;
  begin
    perform public.capture_google_review_as_proof_v6(review_id);
    raise exception 'Review without URL was captured' using errcode='XX000';
  exception when sqlstate 'P0001' then null; end;

  insert into public.google_reviews(client_id,location_id,review_ref,comment,review_url)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'no-date','Undated review','https://example.invalid/review/undated') returning id into review_id;
  begin
    perform public.capture_google_review_as_proof_v6(review_id);
    raise exception 'Review without date was captured' using errcode='XX000';
  exception when sqlstate 'P0001' then null; end;
end $checks$;
rollback;
