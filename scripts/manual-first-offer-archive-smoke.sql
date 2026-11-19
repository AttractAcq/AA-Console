-- Rollback-only archive/retrieve and empty-draft deletion fixture.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','offer-archive-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac','admin','offer-archive-admin@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd','Offer archive fixture','OA');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare template record; record_id uuid; offer_row public.service_offers%rowtype;
  empty_offer public.service_offers%rowtype;
  signed_version public.service_offer_versions%rowtype;
  pending_version public.service_offer_versions%rowtype;
  campaign_id uuid; pending_request_id uuid;
begin
  for template in select item_key,item_type,title,display_order from public.record_templates
    where domain='offer_strategy' order by display_order,item_key loop
    insert into public.client_agent_records(client_id,domain,item_key,item_type,title,
      display_order,body)
    values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd','offer_strategy',
      template.item_key,template.item_type,template.title,template.display_order,
      'Reviewed service details') returning id into record_id;
    perform public.review_model_section_v7(record_id,'Owner interview',current_date,
      'supported','Reviewed against source');
  end loop;
  offer_row:=public.create_named_main_offer_v9(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd','Garage conversion');
  signed_version:=public.create_service_offer_version_v6(
    offer_row.client_id,offer_row.service_name,'Homeowners','First promise',
    array['Survey'],array['Equipment excluded'],null,null,null,'[]'::jsonb,
    'archive-offer-v1',offer_row.id);
  perform public.approve_service_offer_version_v6(signed_version.id);
  pending_version:=public.create_service_offer_version_v6(
    offer_row.client_id,offer_row.service_name,'Homeowners','Second promise',
    array['Survey'],array['Equipment excluded'],null,null,null,'[]'::jsonb,
    'archive-offer-v2',offer_row.id);
  select id into pending_request_id from public.approval_requests_v6
    where source_kind='service_offer' and source_id=pending_version.id::text;
  if public.service_offer_source_state_v6(pending_request_id)<>'pending' then
    raise exception 'Pending version was not reviewable before archive'; end if;
  insert into public.client_campaigns(client_id,name,brief,offer_version_id)
    values(offer_row.client_id,'Historical campaign','Preserve this reference',signed_version.id)
    returning id into campaign_id;
  offer_row:=public.set_service_offer_archived_v10(offer_row.id,true);
  if offer_row.archived_at is null or offer_row.archived_by<>auth.uid()
    or public.service_offer_source_state_v6(pending_request_id)<>'source_held'
    or not exists(select 1 from public.service_offer_signoffs
      where offer_version_id=signed_version.id)
    or not exists(select 1 from public.client_campaigns
      where id=campaign_id and offer_version_id=signed_version.id)
    or not exists(select 1 from public.service_offer_versions where id=pending_version.id) then
    raise exception 'Archiving lost a version, approval or campaign binding'; end if;
  begin
    perform public.create_service_offer_version_v6(
      offer_row.client_id,offer_row.service_name,'Homeowners','Third promise',
      array['Survey'],array['Equipment excluded'],null,null,null,'[]'::jsonb,
      'archive-offer-v3',offer_row.id);
    raise exception 'Archived offer accepted a new version';
  exception when check_violation then null; end;
  begin
    insert into public.service_offer_signoffs(offer_version_id,client_id,approved_by)
      values(pending_version.id,offer_row.client_id,auth.uid());
    raise exception 'Archived offer accepted a new signoff';
  exception when check_violation then null; end;
  begin
    insert into public.client_campaigns(client_id,name,brief,offer_version_id)
      values(offer_row.client_id,'New campaign','Must remain held',signed_version.id);
    raise exception 'Archived offer accepted a new campaign binding';
  exception when check_violation then null; end;
  begin
    perform public.delete_empty_service_offer_v10(offer_row.id);
    raise exception 'Versioned offer was deleted';
  exception when check_violation then null; end;
  offer_row:=public.set_service_offer_archived_v10(offer_row.id,false);
  if offer_row.archived_at is not null or
    public.service_offer_source_state_v6(pending_request_id)<>'pending' or
    (select count(*) from public.service_offer_archive_events_v10
      where offer_id=offer_row.id and action in ('archive','restore'))<>2 then
    raise exception 'Offer restoration lost the archive ledger'; end if;
  empty_offer:=public.create_named_main_offer_v9(
    offer_row.client_id,'Empty draft');
  perform public.delete_empty_service_offer_v10(empty_offer.id);
  if exists(select 1 from public.service_offers where id=empty_offer.id)
    or not exists(select 1 from public.service_offer_archive_events_v10
      where offer_id=empty_offer.id and action='delete_empty_draft') then
    raise exception 'Empty draft was not safely deleted'; end if;
end $checks$;
rollback;
