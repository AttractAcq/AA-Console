begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a7777777-7777-4777-8777-777777777777','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','journey-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a7777777-7777-4777-8777-777777777777','admin','journey-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('b7777777-7777-4777-8777-777777777777','Journey fixture','JF');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $setup$
declare cid uuid:='b7777777-7777-4777-8777-777777777777';
  campaign_id uuid; page_id uuid; asset_id uuid; lead_id uuid;
begin
  insert into public.client_campaigns(client_id,name,brief)
    values(cid,'Archived source campaign','Test journey') returning id into campaign_id;
  insert into public.client_pages(client_id,page_type,title)
    values(cid,'landing','Archived source page') returning id into page_id;
  insert into public.client_media_assets(client_id,media_type,title,storage_path)
    values(cid,'image','Source asset','fixture/source.png') returning id into asset_id;
  insert into public.client_leads(client_id,name,stage,source_channel,
    source_client_campaign_id,source_page_id,source_asset_id,
    consent_given_at,consent_wording,sale_value,cash_collected)
    values(cid,'Journey lead','cash','organic',campaign_id,page_id,asset_id,
      now(),'I agree to be contacted',12000,9000) returning id into lead_id;
  insert into public.lead_events(lead_id,client_id,kind,body,to_stage)
    values(lead_id,cid,'outcome','Cash collected','cash');
  update public.client_campaigns set archived_at=now() where id=campaign_id;
  update public.client_pages set archived_at=now() where id=page_id;
  update public.client_media_assets set archived_at=now() where id=asset_id;
  insert into public.client_leads(client_id,name)
    values(cid,'Unknown source');
end $setup$;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a7777777-7777-4777-8777-777777777777',true);
select set_config('request.jwt.claims',
  '{"sub":"a7777777-7777-4777-8777-777777777777","role":"authenticated"}',true);
do $checks$
declare cid uuid:='b7777777-7777-4777-8777-777777777777';
  v record; refused boolean:=false;
begin
  select * into v from public.lead_journey_trace_v8(cid,30,50)
    where source_channel='organic';
  if v.campaign_name<>'Archived source campaign'
    or v.page_title<>'Archived source page' or v.asset_title<>'Source asset'
    or v.sale_value<>12000 or v.cash_collected<>9000 or v.outcome_events<>1
    or v.opportunity_ids<>array[]::uuid[] then
    raise exception 'Archived source to cash journey was not traceable'; end if;
  select * into v from public.lead_journey_trace_v8(cid,30,50)
    where source_channel is null;
  if v.campaign_id is not null or v.asset_id is not null
    or v.cash_collected is not null then
    raise exception 'Unknown journey evidence was invented'; end if;
  perform set_config('request.jwt.claim.sub','f7777777-7777-4777-8777-777777777777',true);
  perform set_config('request.jwt.claims',
    '{"sub":"f7777777-7777-4777-8777-777777777777","role":"authenticated"}',true);
  begin perform public.lead_journey_trace_v8(cid,30,50);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unauthorized journey read was accepted'; end if;
end $checks$;
rollback;
