-- Rollback-only proof that one commercial campaign freezes both route obligations.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','both-manifest-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','both-manifest-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Both route fixture','BR'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Other client fixture','OC');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  paid_platform,content_count,organic_content_count,paid_content_count,built_at,objective,audience)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Coordinated campaign','Exact test brief',
  'both',true,true,'meta',2,1,1,now(),'Book verified consultations','Local service buyers');
insert into public.agent_jobs(id,client_id,agent_key,input_table,input_id)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','campaign_plan','client_campaigns',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd','campaign_plan','client_campaigns',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $checks$
declare cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  job uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  snapshot_id uuid; again_id uuid;
begin
  begin
    perform public.capture_campaign_intelligence_snapshot_v6(cid,
      'ffffffff-ffff-4fff-8fff-ffffffffffff');
    raise exception 'Wrong-client planner job captured Intelligence';
  exception when raise_exception then
    if sqlerrm='Wrong-client planner job captured Intelligence' then raise; end if;
  end;
  select id into snapshot_id from public.capture_campaign_intelligence_snapshot_v6(cid,job);
  select id into again_id from public.capture_campaign_intelligence_snapshot_v6(cid,job);
  if snapshot_id is null or snapshot_id is distinct from again_id or
     (select acquisition_mode from public.campaign_intelligence_snapshots where id=snapshot_id)<>'both'
    then raise exception 'Both-route Intelligence snapshot was not frozen once'; end if;
  begin
    perform public.create_campaign_manifest_v6(cid,'unplanned',false);
    raise exception 'Unspecified both-route manifest was accepted';
  exception when raise_exception then
    if sqlerrm='Unspecified both-route manifest was accepted' then raise; end if;
  end;
end $checks$;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"},
    {"route":"paid","platform":"facebook","media_type":"image","content_format":"single"}]'::jsonb);
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $checks$
declare cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  snapshot_id uuid; v_manifest_id uuid; again_id uuid; newer_id uuid;
  n integer;
begin
  select id into snapshot_id from public.campaign_intelligence_snapshots
    where campaign_id=cid;
  select id into v_manifest_id from public.create_campaign_manifest_v6(cid,'both-v1',false);
  select id into again_id from public.create_campaign_manifest_v6(cid,'both-v1',false);
  if v_manifest_id is null or v_manifest_id is distinct from again_id
    then raise exception 'Both-route manifest retry changed identity'; end if;
  perform public.attach_campaign_manifest_intelligence_v6(v_manifest_id,snapshot_id);
  select count(*) into n from public.campaign_manifest_items where manifest_id=v_manifest_id;
  if n<>11 then raise exception 'Both-route manifest did not contain eleven requirements'; end if;
  if not exists (select 1 from public.campaign_manifest_items
    where manifest_id=v_manifest_id and item_key='distribution'
      and module_key='content_distribution' and required)
    or not exists (select 1 from public.campaign_manifest_items
      where manifest_id=v_manifest_id and item_key='paid_distribution'
        and module_key='meta_ads_studio' and required)
    or not exists (select 1 from public.campaign_manifest_items
      where manifest_id=v_manifest_id and item_key='attribution'
        and depends_on @> '{distribution,paid_distribution}'::text[])
    then raise exception 'Both route obligations were not separate'; end if;
  if not exists (select 1 from public.campaign_route_actions
    where manifest_id=v_manifest_id and item_key='distribution'
      and action_key='organic_publish')
    or not exists (select 1 from public.campaign_route_actions
      where manifest_id=v_manifest_id and item_key='paid_distribution'
        and action_key='meta_ad_build')
    then raise exception 'Both route actions were not separate'; end if;
  perform public.request_campaign_action_approval_v6(v_manifest_id,'organic-1',
    'organic_publish','instagram',repeat('a',32),'{}'::jsonb);
  perform public.request_campaign_action_approval_v6(v_manifest_id,'meta-1',
    'meta_ad_build','meta:act_fixture',repeat('b',32),'{}'::jsonb);
  begin
    perform public.request_campaign_action_approval_v6(v_manifest_id,'wrong-platform',
      'google_ad_build','google:fixture',repeat('c',32),'{}'::jsonb);
    raise exception 'Wrong paid platform was accepted';
  exception when raise_exception then
    if sqlerrm='Wrong paid platform was accepted' then raise; end if;
  end;
  update public.client_campaigns set built_at=built_at+interval '1 second' where id=cid;
  select id into newer_id from public.create_campaign_manifest_v6(cid,'both-v2',false);
  if newer_id=v_manifest_id then raise exception 'New package reused old manifest'; end if;
  begin
    perform public.request_campaign_action_approval_v6(v_manifest_id,'stale',
      'organic_publish','instagram',repeat('d',32),'{}'::jsonb);
    raise exception 'Superseded manifest accepted action';
  exception when raise_exception then
    if sqlerrm='Superseded manifest accepted action' then raise; end if;
  end;
  if (select live from public.campaign_launch_due where campaign_id=cid) then
    raise exception 'A packaged but unexecuted both-route campaign was called live'; end if;
  update public.client_campaigns set meta_campaign_id='fixture-meta-campaign' where id=cid;
  insert into public.metrics_daily(client_id,surface,entity_type,external_id,metric_date,
    basis,spend,currency)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','paid','campaign',
    'fixture-meta-campaign',current_date,'daily',10,'ZAR');
  if (select live from public.campaign_launch_due where campaign_id=cid) then
    raise exception 'Paid spend alone made both routes live'; end if;
  insert into public.client_ideas(client_id,campaign_id,campaign_position,
    acquisition_route,title,source,status)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',cid,1,
    'organic','Organic fixture idea','manual','draft');
  insert into public.client_briefs(client_id,source_idea_id,title)
  select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',i.id,'Organic fixture brief'
    from public.client_ideas i where i.campaign_id=cid and i.title='Organic fixture idea';
  insert into public.client_media_assets(client_id,brief_id,title,media_type,storage_path)
  select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',b.id,'Organic fixture asset',
    'image','fixture/organic.png'
    from public.client_briefs b where b.title='Organic fixture brief'
      and b.client_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  insert into public.scheduled_posts(client_id,asset_id,scheduled_for,scheduled_at,
    channel,media_type,platform,publication_status,published_at,external_id)
  select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',a.id,current_date,now(),
    'organic','image','instagram','published',now(),'fixture-organic-post'
    from public.client_media_assets a where a.title='Organic fixture asset'
      and a.client_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  if not (select live from public.campaign_launch_due where campaign_id=cid) then
    raise exception 'Two recorded route effects did not make both routes live'; end if;
end $checks$;
do $single_route$
declare cid uuid; mid uuid;
begin
  insert into public.client_campaigns(client_id,name,brief,acquisition_mode,
    runs_organic,runs_paid,paid_platform,built_at,objective,audience)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Single paid regression',
    'Exact paid brief','paid',false,true,'meta',now(),
    'Book consultations','Service buyers') returning id into cid;
  select id into mid from public.create_campaign_manifest_v6(cid,'paid-v1',false);
  if (select count(*) from public.campaign_manifest_items where manifest_id=mid)<>10
    or exists (select 1 from public.campaign_manifest_items
      where manifest_id=mid and item_key='paid_distribution')
    or not exists (select 1 from public.campaign_route_actions
      where manifest_id=mid and item_key='distribution' and action_key='meta_ad_build')
    then raise exception 'Single paid manifest changed its route contract'; end if;
end $single_route$;
rollback;
