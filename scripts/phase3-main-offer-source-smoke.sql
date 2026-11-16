-- Rollback-only proof that a main offer captures and rechecks reviewed Strategy.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','main-offer-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','main-offer-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Main offer fixture','MO');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare t record; record_id uuid; first_record uuid;
  snapshot jsonb; offer public.service_offers%rowtype;
  version public.service_offer_versions%rowtype;
  compiled public.service_offer_versions%rowtype;
  request_id uuid; job_id uuid;
begin
  begin
    perform public.create_main_offer_v7('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    raise exception 'Main offer was created without reviewed Strategy';
  exception when check_violation then null; end;
  for t in select item_key,item_type,title,display_order from public.record_templates
    where domain='offer_strategy' order by display_order,item_key loop
    insert into public.client_agent_records(client_id,domain,item_key,item_type,title,
      display_order,body)
    values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','offer_strategy',
      t.item_key,t.item_type,t.title,t.display_order,'Verified client service detail')
    returning id into record_id;
    if first_record is null then first_record:=record_id; end if;
    perform public.review_model_section_v7(record_id,'Owner interview',current_date,
      'supported','Verified against source');
  end loop;
  if first_record is null then raise exception 'Fixture has no Offer Strategy templates'; end if;
  snapshot:=public.reviewed_offer_strategy_snapshot_v7('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  offer:=public.create_main_offer_v7('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if not public.main_offer_source_current_v7(offer.id) then
    raise exception 'Manual main offer did not retain reviewed Strategy'; end if;
  version:=public.create_service_offer_version_v6(offer.client_id,'New main offer',
    'Service business owners','A reviewed core service',array['Service'],array['Materials'],
    null,null,null,'[]'::jsonb,'main-source-version',offer.id);
  select id into request_id from public.approval_requests_v6
    where source_kind='service_offer' and source_id=version.id::text;
  if public.service_offer_source_state_v6(request_id)<>'pending' then
    raise exception 'Main offer version was not reviewable'; end if;
  insert into public.agent_jobs(agent_key,client_id,params)
    values('offer_compile',offer.client_id,'{"kind":"main","source":"strategy"}'::jsonb)
    returning id into job_id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  compiled:=public.create_compiled_main_offer_v7(offer.client_id,snapshot,job_id,
    'Verified service','Service business owners','A reviewed service offer',
    array['Service'],array['Materials'],job_id::text||':1');
  if (public.create_compiled_main_offer_v7(offer.client_id,snapshot,job_id,
    'Verified service','Service business owners','A reviewed service offer',
    array['Service'],array['Materials'],job_id::text||':1')).id<>compiled.id then
    raise exception 'Compiler retry created a duplicate main offer'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  update public.client_agent_records set body='Changed service detail' where id=first_record;
  if public.main_offer_source_current_v7(offer.id)
    or public.service_offer_source_state_v6(request_id)<>'source_held' then
    raise exception 'Changed Strategy did not hold main offer approval'; end if;
  insert into public.agent_jobs(agent_key,client_id,params)
    values('offer_compile',offer.client_id,'{"kind":"main","source":"strategy"}'::jsonb)
    returning id into job_id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    perform public.create_compiled_main_offer_v7(offer.client_id,snapshot,job_id,
      'Stale service','Service business owners','An old promise',
      array['Service'],array['Materials'],job_id::text||':1');
    raise exception 'Stale Strategy produced a new main offer';
  exception when check_violation then null; end;
end $checks$;
rollback;
