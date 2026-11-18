-- Rollback-only proof of exact paid-Google copy provenance and stale guards.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('10101010-1010-4010-8010-101010101010','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','google-copy-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('10101010-1010-4010-8010-101010101010','admin','google-copy-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('20202020-2020-4020-8020-202020202020','Google copy fixture','GC');
insert into public.agents(agent_key,name,initials,description)
values ('google_search_copy','Google Search Copy','GS','Fixture-only producer identity');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,
  runs_paid,paid_platform,content_count,organic_content_count,paid_content_count,
  built_at,objective,audience)
values ('30303030-3030-4030-8030-303030303030',
  '20202020-2020-4020-8020-202020202020','Combined Google campaign',
  'Signed local offer brief','both',true,true,'google',2,1,1,now(),
  'Book qualified consultations','Local service buyers');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','10101010-1010-4010-8010-101010101010',true);
select set_config('request.jwt.claims',
  '{"sub":"10101010-1010-4010-8010-101010101010","role":"authenticated","aal":"aal2"}',true);
select public.set_campaign_content_spec_v7('30303030-3030-4030-8030-303030303030',
  '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"},
    {"route":"paid","platform":"google_ads","media_type":"text","content_format":"single"}]'::jsonb);
insert into public.client_ideas(client_id,campaign_id,campaign_position,acquisition_route,
  title,body,media_type,content_format,source,status)
values ('20202020-2020-4020-8020-202020202020',
  '30303030-3030-4030-8030-303030303030',2,'paid',
  'Search consultation copy','Invite the local buyer to discuss the signed offer.',
  'text','single','manual','draft');
select public.approve_campaign_plan_v6('30303030-3030-4030-8030-303030303030');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $fixture$
declare cid uuid:='30303030-3030-4030-8030-303030303030';
  client uuid:='20202020-2020-4020-8020-202020202020';
  idea_id uuid; spec_id uuid; route_id uuid; work_id uuid; job_id uuid;
  first_id uuid; again_id uuid; first_hash text;
  headlines text[]:=array['Book a Local Consultation','Explore Your Service Options',
    'Speak With Our Team'];
  descriptions text[]:=array['Discuss your project with our local team.',
    'Book a consultation to explore the next step.'];
  rationale text:='The copy invites the target buyer to discuss the signed offer.';
begin
  select id into idea_id from public.client_ideas where campaign_id=cid and campaign_position=2;
  select content_spec_id into spec_id from public.client_campaigns where id=cid;
  insert into public.campaign_route_packages_v6
    (client_id,campaign_id,route,paid_platform,version,plan_fingerprint)
  select client,id,'paid','google',1,public.campaign_plan_fingerprint(c)
    from public.client_campaigns c where c.id=cid returning id into route_id;
  select id into work_id from public.create_delivery_work_item_v6(cid,route_id,
    null,null,'content_piece2',1,'content_production_factory',true,
    jsonb_build_object('campaign_id',cid,'route_package_id',route_id,
      'content_spec_id',spec_id,'content_spec_hash',
      (select content_spec_hash from public.client_campaigns where id=cid),
      'piece_index',2,'piece',(select pieces->1 from public.campaign_content_spec_versions_v7
        where id=spec_id),'planned_idea_id',idea_id,
      'workflow_run_id','fixture-only'),
    '{"artifact_kind":"asset","route":"paid","platform":"google_ads",
      "media_type":"text","content_format":"single","final_step_key":"piece2_create"}'::jsonb);
  insert into public.agent_jobs(client_id,agent_key,input_table,input_id)
  values(client,'google_search_copy','client_ideas',idea_id) returning id into job_id;
  select id,copy_hash into first_id,first_hash
    from public.record_campaign_google_search_copy_v7(work_id,idea_id,job_id,
      headlines,descriptions,rationale);
  select id into again_id from public.record_campaign_google_search_copy_v7(
    work_id,idea_id,job_id,headlines,descriptions,rationale);
  if first_id is null or first_id is distinct from again_id or first_hash is null
    or (select count(*) from public.campaign_google_search_copy_versions_v7
      where campaign_id=cid)<>1 then
    raise exception 'Google copy retry did not preserve exact version'; end if;
  begin
    perform public.record_campaign_google_search_copy_v7(work_id,idea_id,job_id,
      array['Duplicate','duplicate','Third'],descriptions,rationale);
    raise exception 'Duplicate headline reached storage';
  exception when others then
    if sqlerrm='Duplicate headline reached storage' then raise; end if;
  end;
  begin
    perform public.record_campaign_google_search_copy_v7(work_id,idea_id,job_id,
      headlines,array['One description'],rationale);
    raise exception 'Short description set reached storage';
  exception when others then
    if sqlerrm='Short description set reached storage' then raise; end if;
  end;
  update public.client_campaigns set objective='A revised objective' where id=cid;
  begin
    perform public.record_campaign_google_search_copy_v7(work_id,idea_id,job_id,
      headlines,descriptions,rationale);
    raise exception 'Stale plan reached copy storage';
  exception when others then
    if sqlerrm='Stale plan reached copy storage' then raise; end if;
  end;
end $fixture$;
rollback;
