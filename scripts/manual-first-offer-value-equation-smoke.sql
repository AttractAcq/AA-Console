-- Disposable rollback-only validation of immutable value equation and exact review.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','value-offer-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab','admin','value-offer-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc','Value offer fixture','VF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare template record; source_id uuid; offer_row public.service_offers%rowtype;
  version_row public.service_offer_versions%rowtype;
  compiled public.service_offer_versions%rowtype; compile_job uuid; strategy jsonb;
  legacy public.service_offer_versions%rowtype;
  packet jsonb; request_row public.approval_requests_v6%rowtype;
  equation jsonb:=jsonb_build_object(
    'dream_outcome','A usable home gym','dream_outcome_boost','Training at home every week',
    'likelihood','A tailored installation plan','likelihood_mechanism','Site survey and measured layout',
    'time_delay','Six weeks estimated, subject to materials',
    'delay_reduction_steps',jsonb_build_array('Survey before final quote'),
    'effort_sacrifice','The owner must clear the garage',
    'effort_reduction_steps',jsonb_build_array('Provide a clearing checklist'),
    'risk_reversal','Written scope before deposit',
    'bonuses',jsonb_build_array(jsonb_build_object('name','Layout sketch','value','One room plan',
      'delivery_limit','One revision')),
    'scarcity','Two installation slots per month','urgency','Book before winter',
    'delivery_limits','Subject to a completed survey');
begin
  if public.valid_offer_value_equation_v9(equation-'bonuses')
    or public.valid_offer_value_equation_v9(equation||jsonb_build_object(
      'bonuses',jsonb_build_array(1,2,3,4,5,6))) then
    raise exception 'Invalid value equation passed validation'; end if;
  for template in select item_key,item_type,title,display_order from public.record_templates
    where domain='offer_strategy' order by display_order,item_key loop
    insert into public.client_agent_records(client_id,domain,item_key,item_type,title,
      display_order,body)
    values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc','offer_strategy',
      template.item_key,template.item_type,template.title,template.display_order,
      'Surveyed and reviewed service scope') returning id into source_id;
    perform public.review_model_section_v7(source_id,'Owner interview',current_date,
      'supported','Matched to the operator notes');
  end loop;
  offer_row:=public.create_named_main_offer_v9(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc','Garage conversion');
  version_row:=public.create_service_offer_version_v9(
    offer_row.id,offer_row.client_id,offer_row.service_name,'Homeowners','A usable garage gym',
    array['Survey','Layout plan'],array['Equipment not included'],4500,'EUR',2200,
    '[]'::jsonb,equation,'value-offer-1');
  if version_row.value_equation<>equation or version_row.version<>1
    or version_row.content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Value equation did not become an immutable version'; end if;
  select * into request_row from public.approval_requests_v6 r
    where r.source_kind='service_offer' and r.source_id=version_row.id::text;
  if not found or request_row.preview->'value_equation'<>equation
    or request_row.artifact_hash<>version_row.content_hash
    or public.service_offer_source_state_v6(request_row.id)<>'pending' then
    raise exception 'Exact approval packet lost the value equation'; end if;
  packet:=equation||jsonb_build_object('dream_outcome','A different result');
  begin
    perform public.create_service_offer_version_v9(
      offer_row.id,offer_row.client_id,offer_row.service_name,'Homeowners','A usable garage gym',
      array['Survey'],array['Equipment not included'],4500,'EUR',2200,
      '[]'::jsonb,packet,'value-offer-1');
    raise exception 'Changed bytes reused the idempotency key';
  exception when unique_violation then null; end;
  legacy:=public.create_service_offer_version_v6(
    offer_row.client_id,offer_row.service_name,'Homeowners','Legacy draft',
    array['Survey'],array['Equipment not included'],null,null,null,'[]'::jsonb,
    'legacy-value-offer',offer_row.id);
  if legacy.value_equation is not null or
    public.service_offer_approval_preview_v6(legacy) ? 'value_equation' then
    raise exception 'Legacy offer preview changed its shape'; end if;
  strategy:=public.reviewed_offer_strategy_snapshot_v7(offer_row.client_id);
  insert into public.agent_jobs(agent_key,client_id,params)
    values('offer_compile',offer_row.client_id,
      '{"kind":"main","source":"strategy","service_name":"Roof repair"}'::jsonb)
    returning id into compile_job;
  perform set_config('request.jwt.claim.role','service_role',true);
  compiled:=public.create_compiled_main_offer_v10(
    offer_row.client_id,strategy,compile_job,'Roof repair','Homeowners',
    'A repaired roof',array['Survey'],array['Structural repairs excluded'],
    'compiled-value-offer',equation);
  if compiled.value_equation<>equation or compiled.version<>1
    or public.service_offer_approval_preview_v6(compiled)->'value_equation'<>equation then
    raise exception 'Agent-compiled offer lost the value equation'; end if;
  begin
    perform public.create_compiled_main_offer_v10(
      offer_row.client_id,strategy,compile_job,'Roof repair','Homeowners',
      'A changed promise',array['Survey'],array['Structural repairs excluded'],
      'compiled-value-offer',equation);
    raise exception 'Compiler accepted changed bytes under the same key';
  exception when unique_violation then null; end;
  perform set_config('request.jwt.claim.role','authenticated',true);
  update public.client_agent_records set body='Changed strategy' where id=source_id;
  begin
    perform public.create_service_offer_version_v9(
      offer_row.id,offer_row.client_id,offer_row.service_name,'Homeowners','New draft',
      array['Survey'],array['Equipment not included'],null,null,null,
      '[]'::jsonb,equation,'value-offer-2');
    raise exception 'Stale Strategy created a new offer version';
  exception when check_violation then null; end;
end $checks$;
rollback;
