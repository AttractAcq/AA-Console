-- Rollback-only Facebook Page identity and reviewed-credential prewrite gate.
-- No Meta provider action is made.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','meta-profile-target@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','meta-profile-target@example.invalid');
insert into public.clients(id,name,initials) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Meta target fixture','MT');
insert into public.meta_profile_changes(id,client_id,platform,field,current_value,proposed_value,reason)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'facebook','about','Old words','New words','New service positioning');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $test$
declare cid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 change_id uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 iid uuid; rid uuid; qid uuid; profile_rid uuid; profile_qid uuid;
 claim jsonb; attempt_id uuid; claim_key uuid;
begin
 iid:=public.admin_store_integration_credential(cid,'meta','Facebook Page','fixture-secret','write');
 update public.client_integrations set meta_page_id='123456' where id=iid;
 rid:=public.request_integration_grant_v6(iid,false);
 select id into qid from public.integration_grant_reviews_v6 where canonical_request_id=rid;
 perform public.decide_integration_grant_v6(qid,rid,true);
 profile_rid:=public.request_meta_profile_review_v6(change_id);
 if (select preview->'target'->>'account_ref' from public.approval_inbox_v6
     where id=profile_rid)<>'123456' then
  raise exception 'Facebook Page ID missing from exact proposal preview'; end if;
 select id into profile_qid from public.meta_profile_review_requests_v6
  where canonical_request_id=profile_rid;
 perform public.decide_meta_profile_inbox_v6(profile_qid,profile_rid,true);
 if public.meta_profile_prewrite_current_v6(change_id) then
  raise exception 'Authenticated caller passed service-only profile prewrite'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 if not public.meta_profile_prewrite_current_v6(change_id) then
  raise exception 'Exact Facebook proposal and credential did not pass prewrite'; end if;
 claim:=public.claim_meta_profile_execution_v6(change_id);
 if claim is null or claim->>'page_id'<>'123456'
  or claim->>'proposed_value'<>'New words'
  or public.claim_meta_profile_execution_v6(change_id) is not null then
  raise exception 'Meta Page proposal did not receive exactly one reservation'; end if;
 attempt_id:=(claim->>'attempt_id')::uuid;
 claim_key:=(claim->>'claim_key')::uuid;
 if public.begin_meta_profile_write_v6(attempt_id,gen_random_uuid())
  or not public.begin_meta_profile_write_v6(attempt_id,claim_key)
  or public.begin_meta_profile_write_v6(attempt_id,claim_key) then
  raise exception 'Meta Page write did not begin exactly once'; end if;
 begin
  perform public.finish_meta_profile_execution_v6(attempt_id,claim_key,
   'confirmed','Wrong words','facebook_page:123456#about');
  raise exception 'Wrong Facebook readback was confirmed';
 exception when check_violation then null; end;
 begin
  perform public.finish_meta_profile_execution_v6(attempt_id,claim_key,
   'refused',null,null,'After write');
  raise exception 'Started Facebook write was falsely refused';
 exception when check_violation then null; end;
 if not public.finish_meta_profile_execution_v6(attempt_id,claim_key,
  'confirmed','New words','facebook_page:123456#about')
  or public.finish_meta_profile_execution_v6(attempt_id,claim_key,
   'confirmed','New words','facebook_page:123456#about') then
  raise exception 'Meta Page outcome was not immutable'; end if;
 if (select v.status from public.meta_profile_execution_overview_v6 v
  where v.change_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')<>'confirmed' then
  raise exception 'Meta Page outcome was not visible to the client'; end if;
 update public.client_integrations set meta_page_id='222222' where id=iid;
 update public.client_integrations set meta_page_id='123456' where id=iid;
 if public.meta_profile_prewrite_current_v6(change_id)
  or (select status from public.approval_inbox_v6 where id=profile_rid)<>'superseded' then
  raise exception 'Changed-and-restored Page ID revived old profile approval'; end if;
end $test$;
rollback;
