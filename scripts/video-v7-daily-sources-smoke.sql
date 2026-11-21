-- Rollback-only daily code-video source configuration. No Engine or worker is
-- enabled and no provider action is made.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,
  created_at,updated_at)
values ('e1111111-1111-4111-8111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','daily-video-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('e1111111-1111-4111-8111-111111111111','admin',
  'daily-video-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('e2222222-2222-4222-8222-222222222222','Daily video A','DA'),
  ('e3333333-3333-4333-8333-333333333333','Daily video B','DB');
insert into public.client_agent_records(id,client_id,domain,item_key,item_type,
  title,body)
values ('e4444444-4444-4444-8444-444444444444',
  'e2222222-2222-4222-8222-222222222222','offer_strategy',
  'daily_video_source','section','Reviewed service',
  'The service includes an assessed installation and documented handoff.'),
  ('e5555555-5555-4555-8555-555555555555',
  'e3333333-3333-4333-8333-333333333333','offer_strategy',
  'other_daily_video_source','section','Other service',
  'This source belongs to a different client.');
insert into public.client_campaigns(id,client_id,name,brief,
  acquisition_mode,runs_organic)
values ('e6666666-6666-4666-8666-666666666666',
  'e2222222-2222-4222-8222-222222222222',
  'Daily video campaign','A reviewed organic video route.',
  'organic',true);
insert into public.campaign_route_packages_v6(id,client_id,campaign_id,
  route,version,plan_fingerprint)
select 'e7777777-7777-4777-8777-777777777777',c.client_id,c.id,
  'organic',1,public.campaign_plan_fingerprint(c)
from public.client_campaigns c
where c.id='e6666666-6666-4666-8666-666666666666';
insert into public.client_content_pillars(id,client_id,slug,name,premise,
  belongs,does_not_belong)
values ('e8888888-8888-4888-8888-888888888888',
  'e2222222-2222-4222-8222-222222222222','daily-video',
  'Daily video','Explain the service to buyers.','Service explanations.',
  'Unrelated topics.');
insert into public.client_daily_package_settings
  (client_id,campaign_id,pillar_id,enabled)
values ('e2222222-2222-4222-8222-222222222222',
  'e6666666-6666-4666-8666-666666666666',
  'e8888888-8888-4888-8888-888888888888',false);

select set_config('request.jwt.claim.sub',
  'e1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"e1111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
select public.review_model_section_v7(
  'e4444444-4444-4444-8444-444444444444',
  'Fixture owner interview',current_date,'supported','Checked source');

do $checks$
begin
  begin
    perform public.configure_daily_video_sources_v1(
      'e2222222-2222-4222-8222-222222222222',
      'e7777777-7777-4777-8777-777777777777',
      array['e4444444-4444-4444-8444-444444444444']::uuid[]);
    raise exception 'Authenticated user configured service-only source';
  exception when insufficient_privilege then null; end;
end $checks$;

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $checks$
declare result jsonb; configured public.client_daily_video_sources_v1%rowtype;
begin
  begin
    perform public.configure_daily_video_sources_v1(
      'e2222222-2222-4222-8222-222222222222',
      'e7777777-7777-4777-8777-777777777777',
      array['e5555555-5555-4555-8555-555555555555']::uuid[]);
    raise exception 'Cross-client source configured daily video';
  exception when check_violation then null; end;
  result:=public.configure_daily_video_sources_v1(
    'e2222222-2222-4222-8222-222222222222',
    'e7777777-7777-4777-8777-777777777777',
    array['e4444444-4444-4444-8444-444444444444']::uuid[]);
  select * into configured from public.client_daily_video_sources_v1
    where client_id='e2222222-2222-4222-8222-222222222222';
  if result->>'source_count'<>'1' or configured.route_package_id<>
      'e7777777-7777-4777-8777-777777777777'::uuid
    or configured.source_digest is distinct from
      encode(sha256(convert_to(configured.review_snapshot::text,'UTF8')),'hex')
    or configured.review_snapshot->0->>'review_id' is null
    or not public.daily_video_sources_current_v1(configured.client_id)
    or (select enabled from public.client_daily_package_settings
      where client_id=configured.client_id) is not false
    or exists(select 1 from public.video_projects
      where client_id=configured.client_id) then
    raise exception 'Daily source configuration did not preserve hold and lineage';
  end if;
  insert into public.campaign_route_packages_v6(id,client_id,campaign_id,
    route,version,plan_fingerprint)
  select 'e9999999-9999-4999-8999-999999999999',c.client_id,c.id,
    'organic',2,public.campaign_plan_fingerprint(c)
  from public.client_campaigns c
  where c.id='e6666666-6666-4666-8666-666666666666';
  begin
    perform public.configure_daily_video_sources_v1(
      'e2222222-2222-4222-8222-222222222222',
      'e7777777-7777-4777-8777-777777777777',
      array['e4444444-4444-4444-8444-444444444444']::uuid[]);
    raise exception 'Stale route configured daily video';
  exception when check_violation then null; end;
  if public.daily_video_sources_current_v1(configured.client_id) then
    raise exception 'Superseded daily route remained current';
  end if;
end $checks$;
rollback;
