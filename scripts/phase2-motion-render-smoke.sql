-- Rollback-only motion render exact-review fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','motion-owner@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','motion-owner@example.invalid');
insert into public.clients(id,name,initials) values
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Motion fixture','MF');
insert into public.motion_design_projects(id,client_id,prompt,preset,aspect,duration_sec,brand_mode,status)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'Exact review of a motion render','explainer','vertical',12,'on_brand','completed');
insert into public.motion_render_candidates(id,project_id,client_id,attempt,render_path,brand_qa,claim_qa)
values ('ffffffff-ffff-4fff-8fff-ffffffffffff','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/motion/r1.mp4','pass','pass');
insert into storage.objects(id,bucket_id,name,version)
values ('11111111-1111-4111-8111-111111111111','client-media',
 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/motion/r1.mp4','v1');
select set_config('request.jwt.claim.role','service_role',true);
do $attest$
declare i jsonb;
begin
 i:=public.motion_render_storage_identity_v6('ffffffff-ffff-4fff-8fff-ffffffffffff');
 perform public.attest_motion_render_bytes_v6('ffffffff-ffff-4fff-8fff-ffffffffffff',
  i->>'storage_path',repeat('a',64),12,(i->>'object_id')::uuid,
  i->>'object_version',(i->>'object_updated_at')::timestamptz);
end $attest$;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
do $checks$
declare candidate_id uuid:='ffffffff-ffff-4fff-8fff-ffffffffffff';
 request_id uuid; review_id uuid; second_id uuid:='22222222-2222-4222-8222-222222222222';
 i jsonb;
begin
 begin
  perform public.accept_motion_candidate_v6(candidate_id,true);
  raise exception 'Direct render acceptance succeeded';
 exception when insufficient_privilege then null; end;
 begin
  update public.motion_render_candidates set rejected_reason='Direct rejection' where id=candidate_id;
  raise exception 'Direct render rejection succeeded';
 exception when insufficient_privilege then null; end;
 request_id:=public.request_motion_render_review_v6(candidate_id);
 select id into review_id from public.motion_render_review_requests_v6 where canonical_request_id=request_id;
 if request_id is null or public.request_motion_render_review_v6(candidate_id)<>request_id
  or (select status from public.approval_inbox_v6 where id=request_id)<>'pending' then
  raise exception 'Render request was not pending and deduplicated'; end if;
 begin
  perform public.decide_motion_render_inbox_v6(review_id,request_id,true);
  raise exception 'AAL1 accepted a render';
 exception when insufficient_privilege then null; end;
 update public.motion_render_candidates set brand_qa_detail='Edited QA' where id=candidate_id;
 update public.motion_render_candidates set brand_qa_detail=null where id=candidate_id;
 if public.motion_render_review_source_state_v6(request_id)<>'superseded' then
  raise exception 'Reverted QA revived old review'; end if;
 perform set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
 begin
  perform public.decide_motion_render_inbox_v6(review_id,request_id,true);
  raise exception 'Stale review accepted';
 exception when check_violation then null; end;
 request_id:=public.request_motion_render_review_v6(candidate_id);
 select id into review_id from public.motion_render_review_requests_v6 where canonical_request_id=request_id;
 perform public.decide_motion_render_inbox_v6(review_id,request_id,true);
 if not public.motion_render_acceptance_current_v6(candidate_id) then
  raise exception 'Accepted render is not current'; end if;
 begin
  perform public.decide_motion_render_inbox_v6(review_id,request_id,true);
  raise exception 'Duplicate render decision succeeded';
 exception when check_violation then null; end;
 perform set_config('request.jwt.claim.role','service_role',true);
 update storage.objects set version='v2' where id='11111111-1111-4111-8111-111111111111';
 if public.motion_render_acceptance_current_v6(candidate_id) then
  raise exception 'Changed render retained acceptance'; end if;
 if (select render_bytes_sha256 from public.motion_render_candidates where id=candidate_id) is not null then
  raise exception 'Changed Storage object retained byte attestation'; end if;
 begin
  update public.motion_render_candidates set accepted_at=null where id=candidate_id;
  raise exception 'Direct acceptance clearing succeeded';
 exception when insufficient_privilege then null; end;
 insert into public.motion_render_candidates(id,project_id,client_id,attempt,render_path,brand_qa,claim_qa)
 values (second_id,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',2,
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd/motion/r2.mp4','pass','pass');
 insert into storage.objects(id,bucket_id,name,version)
 values ('33333333-3333-4333-8333-333333333333','client-media',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd/motion/r2.mp4','v1');
 i:=public.motion_render_storage_identity_v6(second_id);
 perform public.attest_motion_render_bytes_v6(second_id,i->>'storage_path',repeat('b',64),18,
  (i->>'object_id')::uuid,i->>'object_version',(i->>'object_updated_at')::timestamptz);
 perform set_config('request.jwt.claim.role','authenticated',true);
 request_id:=public.request_motion_render_review_v6(second_id);
 select id into review_id from public.motion_render_review_requests_v6 where canonical_request_id=request_id;
 perform public.decide_motion_render_inbox_v6(review_id,request_id,false,'Pacing is wrong');
 if (select rejected_reason from public.motion_render_candidates where id=second_id)<>'Pacing is wrong' then
  raise exception 'Exact Inbox rejection was not recorded'; end if;
 begin
  update public.motion_render_candidates set rejected_reason=null where id=second_id;
  raise exception 'Direct rejection clearing succeeded';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.role','service_role',true);
 insert into public.client_proof_assets(id,client_id,media_type,title,body,usage_rights)
 values ('99999999-9999-4999-8999-999999999999','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'text','Uncleared source','Source statement','not_cleared');
 insert into public.motion_scenes(project_id,client_id,position,beat,start_sec,duration_sec,proof_asset_id)
 values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  1,'Proof',0,4,'99999999-9999-4999-8999-999999999999');
 delete from public.client_proof_assets where id='99999999-9999-4999-8999-999999999999';
 if not (select proof_source_lost from public.motion_render_candidates where id=candidate_id) then
  raise exception 'Deleted proof was forgotten after scene FK cleared'; end if;
 if (select d.blocker from public.motion_candidate_due d
  where d.candidate_id='ffffffff-ffff-4fff-8fff-ffffffffffff')
  not like 'A cited proof source was deleted%' then
  raise exception 'Deleted proof is not visible as a render blocker'; end if;
end $checks$;
rollback;
