-- A planned package cannot be marked ready before its exact sweep work passes QA.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','package-fixture@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','package-fixture@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Package fixture','PF');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  content_count,organic_content_count,paid_content_count,built_at,needs_landing_page)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Package sweep','Test source',
  'organic',true,false,1,1,0,now(),true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"}]'::jsonb);
select public.approve_campaign_plan_v6('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
do $checks$
declare result jsonb;
  refused boolean := false;
begin
  result:=public.campaign_package_readiness_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  if result->>'status'<>'preparing' or result->>'expected'<>'2'
     or result->>'ready'<>'0' or jsonb_array_length(result->'blockers')<2 then
    raise exception 'Missing sweep and required page were falsely reviewable: %',result;
  end if;
  begin
    perform public.assemble_campaign_preparation_package_v7(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  exception when check_violation then refused:=true;
  end;
  if not refused or exists(select 1 from public.campaign_preparation_packages_v7
    where campaign_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') then
    raise exception 'Incomplete work produced a frozen package';
  end if;
end $checks$;
rollback;
