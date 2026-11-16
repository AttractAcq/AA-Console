-- Exact manual handoff is recorded separately from approval and delivery.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','magnet-handoff@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','magnet-handoff@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Magnet handoff fixture','MH');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare m public.lead_magnets%rowtype;
  v public.lead_magnet_versions%rowtype;
  a_id uuid; e public.lead_magnet_operator_events_v7%rowtype;
  refused boolean:=false;
begin
  insert into public.lead_magnets(client_id,name,objective,format)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Handoff guide',
    'Give the operator the approved guide','pdf_guide') returning * into m;
  insert into public.lead_magnet_versions(magnet_id,client_id,version,storage_path,
    content_sha256,file_bytes,media_type,delivery_channel)
  values(m.id,m.client_id,1,m.client_id::text||'/lead-magnets/handoff.pdf',
    repeat('a',64),1000,'application/pdf','download_link') returning * into v;
  perform public.record_lead_magnet_operator_event_v7(v.id,'verified_download');
  begin
    perform public.record_lead_magnet_operator_event_v7(v.id,'operator_handoff',
      'Paid ads operator','ticket-1');
  exception when others then refused:=true; end;
  if not refused then raise exception 'Unapproved magnet was handed off'; end if;
  a_id:=public.request_lead_magnet_approval_v6(v.id);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.attest_lead_magnet_bytes_v6(a_id,repeat('a',64),1000);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.decide_lead_magnet_approval_v6(a_id,true);
  refused:=false;
  begin
    perform public.record_lead_magnet_operator_event_v7(v.id,'operator_handoff',
      'Paid ads operator','ticket-1');
  exception when others then refused:=true; end;
  if not refused then raise exception 'Old preapproval download authorized handoff'; end if;
  perform public.record_lead_magnet_operator_event_v7(v.id,'verified_download');
  select * into e from public.record_lead_magnet_operator_event_v7(v.id,
    'operator_handoff','Paid ads operator','ticket-1');
  if e.approval_id<>a_id or e.content_sha256<>v.content_sha256
    or e.recipient<>'Paid ads operator' or e.reference<>'ticket-1'
    or exists(select 1 from public.lead_magnet_deliveries where client_id=m.client_id) then
    raise exception 'Manual handoff changed delivery or lost exact identity'; end if;
  if (select id from public.record_lead_magnet_operator_event_v7(v.id,
      'operator_handoff','Paid ads operator','ticket-1'))<>e.id
    or (select count(*) from public.lead_magnet_operator_events_v7
      where magnet_version_id=v.id and event_kind='operator_handoff')<>1 then
    raise exception 'Retry duplicated the operator handoff'; end if;
  refused:=false;
  begin
    perform public.record_lead_magnet_operator_event_v7(v.id,
      'operator_handoff','Different operator','ticket-1');
  exception when others then refused:=true; end;
  if not refused then raise exception 'One handoff reference changed recipient'; end if;
  refused:=false;
  begin
    update public.lead_magnet_operator_events_v7 set recipient='Someone else' where id=e.id;
  exception when others then refused:=true; end;
  if not refused then raise exception 'Handoff evidence was mutable'; end if;
  perform public.revoke_lead_magnet_approval_v6(a_id,'Fixture right withdrawn');
  refused:=false;
  begin
    perform public.record_lead_magnet_operator_event_v7(v.id,'operator_handoff',
      'Paid ads operator','ticket-2');
  exception when others then refused:=true; end;
  if not refused then raise exception 'Revoked magnet was handed off'; end if;
end $checks$;
rollback;
