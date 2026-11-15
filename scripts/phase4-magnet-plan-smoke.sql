-- A reviewed magnet requirement is part of the plan and holds package review.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','magnet-plan@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','magnet-plan@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Magnet plan fixture','MP');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  content_count,organic_content_count,paid_content_count,built_at)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Magnet campaign','Fixture',
  'organic',true,false,1,1,0,now());
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"}]'::jsonb);

do $checks$
declare c_id uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  old_hash text; new_hash text; readiness jsonb; refused boolean:=false;
begin
  select public.campaign_plan_fingerprint(c) into old_hash
    from public.client_campaigns c where id=c_id;
  perform public.set_campaign_magnet_requirement_v7(c_id,true);
  select public.campaign_plan_fingerprint(c) into new_hash
    from public.client_campaigns c where id=c_id;
  if old_hash=new_hash then raise exception 'Magnet requirement did not version the plan'; end if;
  perform public.approve_campaign_plan_v6(c_id);
  readiness:=public.campaign_package_readiness_v7(c_id);
  if readiness->>'status'<>'preparing' or readiness->>'expected'<>'2'
    or not readiness->'blockers' @> '["Lead magnet: no plan-bound campaign sweep producer has completed internal QA."]'::jsonb then
    raise exception 'Required magnet did not hold package review: %',readiness;
  end if;
  begin
    perform public.set_campaign_magnet_requirement_v7(c_id,false);
  exception when check_violation then refused:=true;
  end;
  if not refused then raise exception 'Reviewed magnet requirement changed directly'; end if;
end $checks$;
rollback;
